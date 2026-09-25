import type { INestApplication } from '@nestjs/common';
import bcrypt from 'bcryptjs';
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
  await app.close();
  await prisma.$disconnect();
});

describe('Platform stats', () => {
  it('counts customers, income and a 30-day series', async () => {
    const t = await signupTenant(app);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } });
    await prisma.transaction.create({ data: { tenantId: tenant.id, type: 'SUBSCRIPTION', amount: -99, balanceAfter: 0 } });
    const res = await admin.get('/admin/stats').expect(200);
    expect(res.body).toMatchObject({ tenants: 1, trial: 1 });
    expect(Number(res.body.incomeThisMonth)).toBe(99);
    expect(res.body.daily).toHaveLength(30);
    expect(res.body.daily[29].income).toBe(99);
  });
});

describe('Plans', () => {
  it('creates and edits plans; codes are unique', async () => {
    const created = await admin
      .post('/admin/plans', { code: 'growth', name: 'Growth', monthlyPrice: 149, perMinuteRate: 0.022, includedNumbers: 10, maxUsers: 5, whiteLabel: true })
      .expect(201);
    await admin.post('/admin/plans', { code: 'growth', name: 'Dup', monthlyPrice: 1, perMinuteRate: 0.01, includedNumbers: 1 }).expect(409);
    await admin.patch(`/admin/plans/${created.body.id}`, { monthlyPrice: 159, active: false }).expect(200);
    const plans = await admin.get('/admin/plans').expect(200);
    expect(plans.body.find((p: { code: string }) => p.code === 'growth')).toMatchObject({ monthlyPrice: '159', active: false });

    // Inactive plans aren't offered to customers.
    const t = await signupTenant(app);
    const billing = await portal(app, t.sub, t.token).get('/billing').expect(200);
    expect(billing.body.plans.map((p: { code: string }) => p.code)).not.toContain('growth');
  });
});

describe('Support login ("log in as customer")', () => {
  it('opens the customer portal as their admin, flagged and audit-logged', async () => {
    const t = await signupTenant(app);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } });
    const imp = await admin.post(`/admin/tenants/${tenant.id}/impersonate`).expect(200);
    expect(imp.body.subdomain).toBe(t.sub);

    // Works only on that customer's portal.
    const other = await signupTenant(app);
    await portal(app, other.sub).post('/auth/handoff', { handoffToken: imp.body.handoffToken }).expect(401);

    const session = await portal(app, t.sub).post('/auth/handoff', { handoffToken: imp.body.handoffToken }).expect(200);
    expect(session.body.user.impersonatedBy).toBe('Root Admin');
    const me = await portal(app, t.sub, session.body.token).get('/auth/me').expect(200);
    expect(me.body).toMatchObject({ email: t.email, impersonatedBy: 'Root Admin' });

    const log = await prisma.auditLog.findFirst({ where: { tenantId: tenant.id, action: 'support.impersonate' } });
    expect(log).toBeTruthy();
  });

  it('skips the customer 2FA step (the admin already signed in) ', async () => {
    const t = await signupTenant(app);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } });
    await prisma.user.updateMany({ where: { tenantId: tenant.id }, data: { twofaEnabled: true, twofaSecret: 'x' } });
    const imp = await admin.post(`/admin/tenants/${tenant.id}/impersonate`).expect(200);
    const session = await portal(app, t.sub).post('/auth/handoff', { handoffToken: imp.body.handoffToken }).expect(200);
    expect(session.body.token).toBeDefined();
  });

  it('is only for the platform owner', async () => {
    const t = await signupTenant(app);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } });
    await portal(app, t.sub, t.token).post(`/admin/tenants/${tenant.id}/impersonate`).expect(403);
  });
});
