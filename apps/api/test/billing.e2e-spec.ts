import type { INestApplication } from '@nestjs/common';
import { prisma } from '@viaroute/db';
import { BillingService } from '../src/billing/billing.service';
import { createApp, portal, resetDb, signupTenant, uid, verifyEmail } from './helpers';

let app: INestApplication;
let billing: BillingService;

beforeAll(async () => {
  await resetDb();
  app = await createApp();
  billing = app.get(BillingService);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

type Session = Awaited<ReturnType<typeof signupTenant>>;
const api = (t: Session) => portal(app, t.sub, t.token);
const tenantOf = (t: Session) => prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } });

describe('Wallet top-ups (test mode)', () => {
  it('credits instantly, records a receipt and notifies', async () => {
    const t = await signupTenant(app);
    const res = await api(t).post('/billing/topup', { amount: 50 }).expect(200);
    expect(res.body).toEqual({ credited: true });
    expect(Number((await tenantOf(t)).walletBalance)).toBe(50);

    const txs = await api(t).get('/billing/transactions').expect(200);
    expect(txs.body.items[0]).toMatchObject({ type: 'TOPUP', amount: '50', balanceAfter: '50' });
    const notes = await api(t).get('/notifications').expect(200);
    expect(notes.body.items[0].title).toBe('$50.00 added to your wallet');
  });

  it('rejects tiny and huge amounts', async () => {
    const t = await signupTenant(app);
    await api(t).post('/billing/topup', { amount: 5 }).expect(400);
    await api(t).post('/billing/topup', { amount: 50_000 }).expect(400);
  });

  it('is only for account admins', async () => {
    const t = await signupTenant(app);
    const email = `mgr${uid()}@x.test`;
    await api(t).post('/team/invite', { email, name: 'Manager Person', role: 'MANAGER' }).expect(201);
    const tenant = await tenantOf(t);
    const mgr = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email } });
    await prisma.user.update({ where: { id: mgr.id }, data: { passwordHash: (await import('bcryptjs')).hashSync('Manager123', 4) } });
    const login = await portal(app, t.sub).post('/auth/login', { email, password: 'Manager123' }).expect(200);
    await portal(app, t.sub, login.body.token).get('/billing').expect(403);
  });
});

describe('Overview', () => {
  it('shows plan, trial, next charge and test mode', async () => {
    const t = await signupTenant(app);
    const res = await api(t).get('/billing').expect(200);
    expect(res.body).toMatchObject({ testMode: true, status: 'TRIAL', plan: { code: 'starter' } });
    expect(new Date(res.body.trialEndsAt).getTime()).toBeGreaterThan(Date.now() + 13 * 86400_000);
    expect(res.body.plans.map((p: { code: string }) => p.code)).toEqual(['starter', 'pro']);
  });
});

describe('Monthly renewals', () => {
  it('turns a finished trial into a paid month, including extra numbers', async () => {
    const t = await signupTenant(app);
    await verifyEmail(app, t);
    const tenant = await tenantOf(t);
    // One paid number ($2) on top of the Starter plan ($99).
    await prisma.phoneNumber.create({ data: { tenantId: tenant.id, e164: `+1415555${String(Math.floor(1000 + Math.random() * 8999))}`, status: 'ACTIVE', provider: 'mock', monthlyPrice: 2 } });
    await prisma.tenant.update({ where: { id: tenant.id }, data: { walletBalance: 150, trialEndsAt: new Date(Date.now() - 1000) } });

    await billing.runRenewals();

    const after = await tenantOf(t);
    expect(after.status).toBe('ACTIVE');
    expect(Number(after.walletBalance)).toBe(49);
    expect(after.billingRenewsAt!.getTime()).toBeGreaterThan(Date.now() + 27 * 86400_000);
    const types = (await prisma.transaction.findMany({ where: { tenantId: tenant.id } })).map((x) => x.type).sort();
    expect(types).toEqual(['NUMBER_RENTAL', 'SUBSCRIPTION']);
  });

  it('suspends when the wallet cannot pay, blocks changes, and reactivates on top-up', async () => {
    const t = await signupTenant(app);
    await verifyEmail(app, t);
    const tenant = await tenantOf(t);
    await prisma.tenant.update({ where: { id: tenant.id }, data: { walletBalance: 20, trialEndsAt: new Date(Date.now() - 1000) } });

    await billing.runRenewals();
    const suspended = await tenantOf(t);
    expect(suspended.status).toBe('SUSPENDED');
    expect(Number(suspended.walletBalance)).toBe(20); // nothing half-charged
    const notes = await api(t).get('/notifications').expect(200);
    expect(notes.body.items[0]).toMatchObject({ type: 'suspended' });

    // Suspended accounts can't change things…
    await api(t).post('/campaigns', { name: 'Blocked' }).expect(403);
    // …but can pay.
    await api(t).post('/billing/topup', { amount: 100 }).expect(200);
    const active = await tenantOf(t);
    expect(active.status).toBe('ACTIVE');
    expect(Number(active.walletBalance)).toBe(21); // 20 + 100 − 99
    await api(t).post('/campaigns', { name: 'Allowed again' }).expect(201);
  });

  it('gives existing active accounts a renewal date instead of charging them at once', async () => {
    const t = await signupTenant(app);
    await prisma.tenant.update({ where: { subdomain: t.sub }, data: { status: 'ACTIVE', billingRenewsAt: null, walletBalance: 10 } });
    await billing.runRenewals();
    const after = await tenantOf(t);
    expect(after.status).toBe('ACTIVE');
    expect(Number(after.walletBalance)).toBe(10);
    expect(after.billingRenewsAt!.getTime()).toBeGreaterThan(Date.now() + 27 * 86400_000);
  });

  it('does not charge accounts that are not due', async () => {
    const t = await signupTenant(app);
    await prisma.tenant.update({ where: { subdomain: t.sub }, data: { walletBalance: 500 } });
    await billing.runRenewals();
    expect(Number((await tenantOf(t)).walletBalance)).toBe(500);
  });
});

describe('Plans', () => {
  it('upgrades and downgrades, respecting user limits', async () => {
    const t = await signupTenant(app);
    await api(t).post('/billing/plan', { code: 'pro' }).expect(200);
    expect((await api(t).get('/billing').expect(200)).body.plan.code).toBe('pro');

    // 4 staff users is fine on Pro but too many for Starter (3).
    const tenant = await tenantOf(t);
    for (let i = 0; i < 3; i++) {
      await prisma.user.create({ data: { tenantId: tenant.id, email: `u${i}${uid()}@x.test`, name: 'Extra', role: 'MANAGER' } });
    }
    const res = await api(t).post('/billing/plan', { code: 'starter' }).expect(400);
    expect(res.body.message).toContain('allows 3 users');
    await api(t).post('/billing/plan', { code: 'nope' }).expect(400);
  });
});

describe('Statements & settings', () => {
  it('builds a monthly statement that adds up', async () => {
    const t = await signupTenant(app);
    await api(t).post('/billing/topup', { amount: 40 }).expect(200);
    await api(t).post('/billing/topup', { amount: 60 }).expect(200);
    const month = new Date().toISOString().slice(0, 7);
    const s = await api(t).get(`/billing/statements/${month}`).expect(200);
    expect(Number(s.body.openingBalance)).toBe(0);
    expect(Number(s.body.closingBalance)).toBe(100);
    expect(Number(s.body.totals.TOPUP)).toBe(100);
    await api(t).get('/billing/statements/2026-13x').expect(400);
  });

  it('saves the low-balance alert level', async () => {
    const t = await signupTenant(app);
    await api(t).patch('/billing/settings', { lowBalanceThreshold: 25 }).expect(200);
    expect(Number((await api(t).get('/billing').expect(200)).body.lowBalanceThreshold)).toBe(25);
  });
});
