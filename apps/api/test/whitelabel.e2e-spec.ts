import type { INestApplication } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { promises as dns } from 'dns';
import request from 'supertest';
import { prisma } from '@viaroute/db';
import { createApp, portal, resetDb, signupTenant } from './helpers';

let app: INestApplication;
let admin: ReturnType<typeof portal>;

beforeAll(async () => {
  await resetDb();
  app = await createApp();
  await prisma.user.create({ data: { email: 'root@viaroute.test', name: 'Root Admin', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash('RootPass123', 4) } });
  const res = await portal(app, null).post('/auth/login', { email: 'root@viaroute.test', password: 'RootPass123' }).expect(200);
  admin = portal(app, null, res.body.token);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await prisma.$disconnect();
});

type Session = Awaited<ReturnType<typeof signupTenant>>;
const api = (t: Session) => portal(app, t.sub, t.token);
const idOf = async (t: Session) => (await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } })).id;
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('Account settings', () => {
  it('renames the company and sets the portal timezone', async () => {
    const t = await signupTenant(app);
    await api(t).patch('/tenant/settings', { name: 'Renamed Co', timezone: 'America/Los_Angeles' }).expect(200);
    const res = await api(t).get('/tenant').expect(200);
    expect(res.body).toMatchObject({ name: 'Renamed Co', timezone: 'America/Los_Angeles' });
    await api(t).patch('/tenant/settings', { timezone: 'Mars/Olympus' }).expect(400);
  });

  it('lets each person pick their own default timezone', async () => {
    const t = await signupTenant(app);
    expect((await api(t).get('/auth/me').expect(200)).body.timezone).toBeNull();
    const res = await api(t).patch('/auth/me', { timezone: 'Asia/Calcutta' }).expect(200);
    expect(res.body.timezone).toBe('Asia/Calcutta');
    expect((await api(t).get('/auth/me').expect(200)).body.timezone).toBe('Asia/Calcutta');

    // Reports without an explicit tz use the personal one.
    expect((await api(t).get('/reports/summary').expect(200)).body.timezone).toBe('Asia/Calcutta');
    expect((await api(t).get('/reports/summary?tz=UTC').expect(200)).body.timezone).toBe('UTC');

    await api(t).patch('/auth/me', { timezone: 'Nowhere/Land' }).expect(400);
    await api(t).patch('/auth/me', { timezone: null }).expect(200);
    expect((await api(t).get('/auth/me').expect(200)).body.timezone).toBeNull();
  });
});

describe('Branding (platform admin)', () => {
  it('customers cannot change it themselves', async () => {
    const t = await signupTenant(app);
    await api(t).patch('/tenant/branding', { portalName: 'Mine' }).expect(404);
    await api(t).patch(`/admin/tenants/${await idOf(t)}/branding`, { portalName: 'Mine' }).expect(403);
  });

  it('sets and clears name, color and logo; the login page shows them', async () => {
    const t = await signupTenant(app);
    const id = await idOf(t);
    await admin.patch(`/admin/tenants/${id}/branding`, { portalName: 'LeadLine Portal', primaryColor: '#16a34a', logoUrl: PNG_1PX }).expect(200);

    const pub = await portal(app, t.sub).get('/tenant/public').expect(200);
    expect(pub.body.branding).toEqual({ portalName: 'LeadLine Portal', primaryColor: '#16a34a', logoUrl: PNG_1PX });
    const detail = await admin.get(`/admin/tenants/${id}`).expect(200);
    expect(detail.body).toMatchObject({ subdomain: t.sub, branding: { portalName: 'LeadLine Portal' }, owner: { email: t.email } });

    await admin.patch(`/admin/tenants/${id}/branding`, { logoUrl: null }).expect(200);
    const after = await portal(app, t.sub).get('/tenant/public').expect(200);
    expect(after.body.branding).toEqual({ portalName: 'LeadLine Portal', primaryColor: '#16a34a' });
  });

  it('rejects bad colors, unsafe files, huge logos and unknown customers', async () => {
    const id = await idOf(await signupTenant(app));
    await admin.patch(`/admin/tenants/${id}/branding`, { primaryColor: 'red; background:url(x)' }).expect(400);
    await admin.patch(`/admin/tenants/${id}/branding`, { logoUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }).expect(400);
    const big = `data:image/png;base64,${Buffer.alloc(300 * 1024, 1).toString('base64')}`;
    const res = await admin.patch(`/admin/tenants/${id}/branding`, { logoUrl: big }).expect(400);
    expect(res.body.message).toContain('200 KB');
    await admin.patch('/admin/tenants/00000000-0000-4000-8000-000000000000/branding', { portalName: 'X' }).expect(404);
  });
});

describe('Custom domains (platform admin)', () => {
  it('connects a domain after the DNS check, then serves the portal on it', async () => {
    const t = await signupTenant(app);
    const id = await idOf(t);
    await api(t).put('/tenant/domain', { domain: 'calls.example.com' }).expect(404);
    await admin.put(`/admin/tenants/${id}/domain`, { domain: 'x.localhost' }).expect(400); // under our own root
    const set = await admin.put(`/admin/tenants/${id}/domain`, { domain: 'Calls.BestLeads.com' }).expect(200);
    expect(set.body).toEqual({ domain: 'calls.bestleads.com', target: 'domains.localhost', verified: false });

    // Not verified yet: the domain doesn't open a portal and gets no certificate.
    await portal(app, null).get('/tenant/public').set('X-Tenant-Host', 'calls.bestleads.com').expect(404);
    await request(app.getHttpServer()).get('/internal/tls-check?domain=calls.bestleads.com').expect(404);

    const spy = jest.spyOn(dns, 'resolveCname');
    spy.mockResolvedValueOnce(['wrong.example.net']);
    const bad = await admin.post(`/admin/tenants/${id}/domain/verify`).expect(400);
    expect(bad.body.message).toContain('should point to domains.localhost');

    spy.mockResolvedValueOnce(['domains.localhost.']);
    await admin.post(`/admin/tenants/${id}/domain/verify`).expect(200);

    const pub = await request(app.getHttpServer()).get('/tenant/public').set('X-Tenant-Host', 'calls.bestleads.com').expect(200);
    expect(pub.body.subdomain).toBe(t.sub);
    await request(app.getHttpServer()).get('/internal/tls-check?domain=calls.bestleads.com').expect(200);

    // CORS lets the custom domain call the API.
    const pre = await request(app.getHttpServer())
      .options('/auth/login')
      .set('Origin', 'https://calls.bestleads.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(pre.headers['access-control-allow-origin']).toBe('https://calls.bestleads.com');
    const evil = await request(app.getHttpServer()).options('/auth/login').set('Origin', 'https://evil.example.com').set('Access-Control-Request-Method', 'POST');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();

    // Another account can't take it.
    const other = await idOf(await signupTenant(app));
    await admin.put(`/admin/tenants/${other}/domain`, { domain: 'calls.bestleads.com' }).expect(409);

    await admin.delete(`/admin/tenants/${id}/domain`).expect(200);
    await request(app.getHttpServer()).get('/internal/tls-check?domain=calls.bestleads.com').expect(404);
  });
});

describe('Certificate check for Caddy', () => {
  it('only approves real portals', async () => {
    const t = await signupTenant(app);
    const check = (d: string) => request(app.getHttpServer()).get(`/internal/tls-check?domain=${d}`);
    await check('localhost').expect(200);
    await check('app.localhost').expect(200);
    await check(`${t.sub}.localhost`).expect(200);
    await check('nobody-here.localhost').expect(404);
    await check('admin.localhost').expect(404);
    await check('random.example.com').expect(404);
  });
});
