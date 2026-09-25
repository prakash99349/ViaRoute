import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import { prisma } from '@viaroute/db';
import { createApp, portal, resetDb, signupTenant, tokenFromEmail, uid } from './helpers';

let app: INestApplication;

beforeAll(async () => {
  await resetDb();
  app = await createApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('Signup & login', () => {
  it('signs up, hands off to the new portal, and returns the user', async () => {
    const t = await signupTenant(app);
    const me = await portal(app, t.sub, t.token).get('/auth/me').expect(200);
    expect(me.body).toMatchObject({ email: t.email, role: 'TENANT_ADMIN', emailVerified: false });
  });

  it('rejects taken and reserved subdomains', async () => {
    const t = await signupTenant(app);
    const body = { companyName: 'Other Co', name: 'Some One', email: `x${uid()}@x.test`, password: 'Password123' };
    await portal(app, null).post('/auth/signup', { ...body, subdomain: t.sub }).expect(409);
    await portal(app, null).post('/auth/signup', { ...body, subdomain: 'admin' }).expect(409);
  });

  it('rejects a wrong password with a generic message', async () => {
    const t = await signupTenant(app);
    const res = await portal(app, t.sub).post('/auth/login', { email: t.email, password: 'wrong-password' }).expect(401);
    expect(res.body.message).toBe('Invalid email or password');
  });

  it('sends customers who log in on the main site to their own portal', async () => {
    const t = await signupTenant(app);
    const res = await portal(app, null).post('/auth/login', { email: t.email, password: t.password }).expect(200);
    expect(res.body.redirect.subdomain).toBe(t.sub);
    expect(res.body.token).toBeUndefined();
  });

  it('returns 404 for a portal that does not exist', async () => {
    await portal(app, 'does-not-exist').get('/tenant/public').expect(404);
  });
});

describe('Email verification', () => {
  it('verifies the email from the link sent at signup', async () => {
    const t = await signupTenant(app);
    const token = await tokenFromEmail(t.email, '/verify-email');
    await portal(app, t.sub).post('/auth/verify-email', { token }).expect(200);
    const me = await portal(app, t.sub, t.token).get('/auth/me').expect(200);
    expect(me.body.emailVerified).toBe(true);
  });

  it('refuses to reuse a verification link', async () => {
    const t = await signupTenant(app);
    const token = await tokenFromEmail(t.email, '/verify-email');
    await portal(app, t.sub).post('/auth/verify-email', { token }).expect(200);
    await portal(app, t.sub).post('/auth/verify-email', { token }).expect(400);
  });
});

describe('Forgot / reset password', () => {
  it('resets the password and logs out every old session', async () => {
    const t = await signupTenant(app);
    await portal(app, t.sub).post('/auth/forgot-password', { email: t.email }).expect(200);
    const token = await tokenFromEmail(t.email, '/reset-password');

    await portal(app, t.sub).post('/auth/reset-password', { token, password: 'BrandNew456' }).expect(200);

    await portal(app, t.sub, t.token).get('/auth/me').expect(401); // old session is dead
    await portal(app, t.sub).post('/auth/login', { email: t.email, password: t.password }).expect(401);
    await portal(app, t.sub).post('/auth/login', { email: t.email, password: 'BrandNew456' }).expect(200);
  });

  it('answers the same for unknown emails (no account discovery)', async () => {
    const t = await signupTenant(app);
    const res = await portal(app, t.sub).post('/auth/forgot-password', { email: 'nobody@nowhere.test' }).expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("won't accept a reset link on another customer's portal", async () => {
    const a = await signupTenant(app);
    const b = await signupTenant(app);
    await portal(app, a.sub).post('/auth/forgot-password', { email: a.email }).expect(200);
    const token = await tokenFromEmail(a.email, '/reset-password');
    await portal(app, b.sub).post('/auth/reset-password', { token, password: 'Hijacked123' }).expect(400);
  });

  it('rejects short passwords', async () => {
    const t = await signupTenant(app);
    await portal(app, t.sub).post('/auth/forgot-password', { email: t.email }).expect(200);
    const token = await tokenFromEmail(t.email, '/reset-password');
    await portal(app, t.sub).post('/auth/reset-password', { token, password: 'short' }).expect(400);
  });
});

describe('Change password', () => {
  it('keeps this device logged in and logs out the others', async () => {
    const t = await signupTenant(app);
    const other = await portal(app, t.sub).post('/auth/login', { email: t.email, password: t.password }).expect(200);

    await portal(app, t.sub, t.token)
      .post('/auth/change-password', { currentPassword: 'wrong', newPassword: 'Another789' })
      .expect(400);
    const res = await portal(app, t.sub, t.token)
      .post('/auth/change-password', { currentPassword: t.password, newPassword: 'Another789' })
      .expect(200);

    await portal(app, t.sub, res.body.token).get('/auth/me').expect(200);
    await portal(app, t.sub, other.body.token).get('/auth/me').expect(401);
  });
});

describe('Two-factor authentication', () => {
  it('sets up 2FA, then requires a code at login', async () => {
    const t = await signupTenant(app);
    const api = portal(app, t.sub, t.token);

    const setup = await api.post('/auth/2fa/setup').expect(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    await api.post('/auth/2fa/enable', { code: '000000' }).expect(400);
    await api.post('/auth/2fa/enable', { code: authenticator.generate(setup.body.secret) }).expect(200);

    const step1 = await portal(app, t.sub).post('/auth/login', { email: t.email, password: t.password }).expect(200);
    expect(step1.body).toMatchObject({ twofaRequired: true });
    expect(step1.body.token).toBeUndefined();

    const { challengeToken } = step1.body;
    await portal(app, t.sub).post('/auth/login/2fa', { challengeToken, code: '000000' }).expect(401);
    const step2 = await portal(app, t.sub)
      .post('/auth/login/2fa', { challengeToken, code: authenticator.generate(setup.body.secret) })
      .expect(200);
    expect(step2.body.token).toBeDefined();
  });

  it('stores the 2FA secret encrypted', async () => {
    const t = await signupTenant(app);
    const setup = await portal(app, t.sub, t.token).post('/auth/2fa/setup').expect(200);
    const user = await prisma.user.findFirstOrThrow({ where: { email: t.email } });
    expect(user.twofaSecret).toBeTruthy();
    expect(user.twofaSecret).not.toContain(setup.body.secret);
  });

  it('turns 2FA off only with the right password', async () => {
    const t = await signupTenant(app);
    const api = portal(app, t.sub, t.token);
    const setup = await api.post('/auth/2fa/setup').expect(200);
    await api.post('/auth/2fa/enable', { code: authenticator.generate(setup.body.secret) }).expect(200);

    await api.post('/auth/2fa/disable', { password: 'wrong' }).expect(400);
    await api.post('/auth/2fa/disable', { password: t.password }).expect(200);
    const login = await portal(app, t.sub).post('/auth/login', { email: t.email, password: t.password }).expect(200);
    expect(login.body.token).toBeDefined();
  });
});
