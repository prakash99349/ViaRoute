import type { INestApplication } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { prisma } from '@viaroute/db';
import { CapsService } from '../src/routing/caps.service';
import { createApp, portal, resetDb, signupTenant, tokenFromEmail, uid, verifyEmail } from './helpers';

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

type Session = Awaited<ReturnType<typeof signupTenant>>;
const api = (t: Session) => portal(app, t.sub, t.token);
const idOf = async (t: Session) => (await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } })).id;

/** A customer with money, a campaign with one buyer and a live number. */
async function withNumber() {
  const t = await signupTenant(app);
  await verifyEmail(app, t);
  await prisma.tenant.update({ where: { subdomain: t.sub }, data: { walletBalance: 100 } });
  const camp = await api(t).post('/campaigns', { name: 'Camp', revenue: 10 }).expect(201);
  const buyer = await api(t).post('/buyers', { name: 'Buyer', destination: '+12125550999' }).expect(201);
  await api(t).post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyer.body.id }).expect(201);
  const found = await api(t).get('/numbers/available?type=LOCAL&areaCode=415').expect(200);
  const num = await api(t).post('/numbers', { e164: found.body[0].e164 }).expect(201);
  await api(t).patch(`/numbers/${num.body.id}`, { campaignId: camp.body.id }).expect(200);
  return { t, id: await idOf(t), number: num.body.e164 as string, numberId: num.body.id as string };
}

async function simulate(t: Session, to: string, talkSec = 60) {
  const res = await api(t).post('/simulator/calls', { to, from: `+1305555${Math.floor(1000 + Math.random() * 8999)}`, talkSec, stepMs: 5 }).expect(201);
  for (let i = 0; i < 300; i++) {
    const c = await api(t).get(`/calls/${res.body.callId}`).expect(200);
    if (c.body.endedAt) return c.body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('call never finished');
}

describe('Customer list & create', () => {
  it('lists customers with owner, usage and wallet flags', async () => {
    const t = await signupTenant(app);
    const res = await admin.get('/admin/tenants').expect(200);
    const row = res.body.find((x: { subdomain: string }) => x.subdomain === t.sub);
    expect(row).toMatchObject({ owner: { email: t.email }, calls30d: 0, numbers: 0, lowWallet: true, plan: { name: expect.any(String) } });
  });

  it('creates a customer and invites the owner to set a password', async () => {
    const sub = `made${uid()}`;
    const email = `owner-${uid()}@acme.test`;
    const plans = await admin.get('/admin/plans').expect(200);
    const pro = plans.body.find((p: { code: string }) => p.code === 'pro');
    const created = await admin
      .post('/admin/tenants', { companyName: 'Made By Sales', subdomain: sub, ownerName: 'Olivia Owner', ownerEmail: email, planId: pro.id, trialDays: 0, startingCredit: 50 })
      .expect(201);
    await admin.post('/admin/tenants', { companyName: 'Dup', subdomain: sub, ownerName: 'X Y', ownerEmail: 'x@y.test' }).expect(409);

    const detail = await admin.get(`/admin/tenants/${created.body.id}`).expect(200);
    expect(detail.body).toMatchObject({ status: 'ACTIVE', walletBalance: '50', plan: { code: 'pro' }, owner: { email } });

    const token = await tokenFromEmail(email, '/accept-invite');
    const login = await portal(app, sub).post('/auth/accept-invite', { token, password: 'Welcome123' }).expect(200);
    expect(login.body.user).toMatchObject({ email, role: 'TENANT_ADMIN' });
  });

  it('is only for the platform owner', async () => {
    const t = await signupTenant(app);
    await api(t).get('/admin/tenants').expect(403);
    await api(t).patch(`/admin/tenants/${await idOf(t)}`, { perMinuteRate: 0 }).expect(403);
  });
});

describe('Plan, custom prices & limits', () => {
  it('changes plan, dates and custom prices, and logs old → new', async () => {
    const t = await signupTenant(app);
    const id = await idOf(t);
    const plans = await admin.get('/admin/plans').expect(200);
    const pro = plans.body.find((p: { code: string }) => p.code === 'pro');
    const trialEnd = new Date(Date.now() + 20 * 86400_000).toISOString();
    await admin.patch(`/admin/tenants/${id}`, { planId: pro.id, trialEndsAt: trialEnd, perMinuteRate: 0.012, numberPriceLocal: 0.5, includedNumbers: 0, maxNumbers: 3 }).expect(200);
    await admin.patch(`/admin/tenants/${id}`, { perMinuteRate: -1 }).expect(400);

    const d = await admin.get(`/admin/tenants/${id}`).expect(200);
    expect(d.body).toMatchObject({ perMinuteRate: '0.012', numberPriceLocal: '0.5', includedNumbers: 0, maxNumbers: 3, plan: { code: 'pro' } });
    expect(d.body.trialEndsAt).toBe(trialEnd);

    const overview = await api(t).get('/numbers/overview').expect(200);
    expect(overview.body).toMatchObject({ prices: { LOCAL: 0.5 }, includedNumbers: 0, maxNumbers: 3 });

    const log = await admin.get(`/admin/tenants/${id}/activity`).expect(200);
    const change = log.body.items.find((x: { action: string }) => x.action === 'admin.customer_update');
    expect(change.meta.perMinuteRate).toEqual({ from: null, to: '0.012' });
    expect(change.user.name).toBe('Root Admin');
  });

  it('bills calls at the custom per-minute rate', async () => {
    const s = await withNumber();
    await admin.patch(`/admin/tenants/${s.id}`, { perMinuteRate: 0.1 }).expect(200);
    const c = await simulate(s.t, s.number, 60); // caller leg ~1–2 min + buyer leg 1 min
    const minutes = Math.ceil(c.durationSec / 60) + Math.ceil(c.connectedSec / 60);
    expect(Number(c.cost)).toBeCloseTo(0.1 * minutes, 4);
  });

  it('stops buying numbers past the limit', async () => {
    const t = await signupTenant(app);
    await verifyEmail(app, t);
    await prisma.tenant.update({ where: { subdomain: t.sub }, data: { walletBalance: 100, maxNumbers: 0 } });
    const found = await api(t).get('/numbers/available?type=LOCAL&areaCode=415').expect(200);
    const res = await api(t).post('/numbers', { e164: found.body[0].e164 }).expect(400);
    expect(res.body.message).toContain('up to 0 numbers');
  });

  it('rejects calls over the account-wide concurrent call limit', async () => {
    const s = await withNumber();
    await admin.patch(`/admin/tenants/${s.id}`, { maxConcurrentCalls: 1 }).expect(200);
    const caps = app.get(CapsService);
    const none = { concurrencyCap: null, hourlyCap: null, dailyCap: null, monthlyCap: null };
    await caps.reserve(`acct:${s.id}`, none, 'UTC'); // another call is live
    const blocked = await simulate(s.t, s.number);
    expect(blocked).toMatchObject({ status: 'REJECTED', rejectReason: 'account_limit' });

    await caps.releaseConcurrency(`acct:${s.id}`);
    const ok = await simulate(s.t, s.number);
    expect(ok.status).toBe('COMPLETED');
    expect((await caps.usageMany([`acct:${s.id}`], 'UTC')).get(`acct:${s.id}`)!.live).toBe(0); // freed at the end
  });
});

describe('Suspend, reactivate & close', () => {
  it('suspends with a reason the customer sees; a top-up does not lift it', async () => {
    const t = await signupTenant(app);
    const id = await idOf(t);
    await admin.patch(`/admin/tenants/${id}/status`, { status: 'SUSPENDED' }).expect(400); // reason required
    await admin.patch(`/admin/tenants/${id}/status`, { status: 'SUSPENDED', reason: 'Unpaid invoice #42' }).expect(200);
    const mine = await api(t).get('/tenant').expect(200);
    expect(mine.body).toMatchObject({ status: 'SUSPENDED', suspendReason: 'Unpaid invoice #42' });
    await api(t).post('/campaigns', { name: 'Nope' }).expect(403);

    await admin.post(`/admin/tenants/${id}/credit`, { amount: 500, note: 'Top-up' }).expect(200);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id } })).status).toBe('SUSPENDED');

    await admin.patch(`/admin/tenants/${id}/status`, { status: 'ACTIVE' }).expect(200);
    const after = await prisma.tenant.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ status: 'ACTIVE', suspendReason: null });
    expect(after.billingRenewsAt).not.toBeNull();
  });

  it('closes an account: releases numbers, signs everyone out, closes the portal', async () => {
    const s = await withNumber();
    await admin.post(`/admin/tenants/${s.id}/close`, { reason: 'Customer asked', confirm: 'wrong' }).expect(400);
    const res = await admin.post(`/admin/tenants/${s.id}/close`, { reason: 'Customer asked', confirm: s.t.sub }).expect(200);
    expect(res.body).toMatchObject({ released: 1, failed: [] });
    expect((await prisma.phoneNumber.findUniqueOrThrow({ where: { id: s.numberId } })).status).toBe('RELEASED');
    await api(s.t).get('/auth/me').expect(404); // portal is gone
    expect((await prisma.call.count({ where: { tenantId: s.id } })) >= 0).toBe(true);

    await admin.patch(`/admin/tenants/${s.id}/status`, { status: 'ACTIVE' }).expect(200); // reopen
    await portal(app, s.t.sub).get('/tenant/public').expect(200);
  });
});

describe('Wallet: transactions & refunds', () => {
  it('lists transactions and refunds a charge once', async () => {
    const t = await signupTenant(app);
    const id = await idOf(t);
    await prisma.tenant.update({ where: { id }, data: { walletBalance: 20 } });
    const charge = await prisma.transaction.create({ data: { tenantId: id, type: 'SUBSCRIPTION', amount: -49, balanceAfter: -29, description: 'Pro plan — monthly' } });
    const topup = await prisma.transaction.create({ data: { tenantId: id, type: 'TOPUP', amount: 10, balanceAfter: -19 } });

    const list = await admin.get(`/admin/tenants/${id}/transactions`).expect(200);
    expect(list.body.items.find((x: { id: string }) => x.id === charge.id)).toMatchObject({ refundable: true });
    expect(list.body.items.find((x: { id: string }) => x.id === topup.id)).toMatchObject({ refundable: false });

    await admin.post(`/admin/transactions/${topup.id}/refund`, {}).expect(400);
    const r = await admin.post(`/admin/transactions/${charge.id}/refund`, { note: 'Goodwill' }).expect(200);
    expect(Number(r.body.walletBalance)).toBe(69);
    await admin.post(`/admin/transactions/${charge.id}/refund`, {}).expect(409);

    const refunds = await admin.get(`/admin/tenants/${id}/transactions?type=REFUND`).expect(200);
    expect(refunds.body.items[0]).toMatchObject({ amount: '49', description: 'Refund: Pro plan — monthly — Goodwill' });
  });

  it('reports daily usage and income', async () => {
    const s = await withNumber();
    await simulate(s.t, s.number);
    const u = await admin.get(`/admin/tenants/${s.id}/usage?days=7`).expect(200);
    expect(u.body.days).toHaveLength(7);
    expect(u.body.totals.calls).toBe(1);
    expect(u.body.totals.minutes).toBeGreaterThan(0);
    expect(u.body.days[6].usage).toBeGreaterThan(0);
  });
});

describe('Users', () => {
  it('disables, re-enables, signs out and removes 2FA', async () => {
    const t = await signupTenant(app);
    const id = await idOf(t);
    const users = await admin.get(`/admin/tenants/${id}/users`).expect(200);
    const owner = users.body[0];
    expect(owner).toMatchObject({ email: t.email, role: 'TENANT_ADMIN', invited: false });

    await admin.post(`/admin/users/${owner.id}/actions`, { action: 'disable' }).expect(200);
    await api(t).get('/auth/me').expect(401); // old session ended
    const blocked = await portal(app, t.sub).post('/auth/login', { email: t.email, password: t.password }).expect(403);
    expect(blocked.body.message).toContain('disabled');

    await admin.post(`/admin/users/${owner.id}/actions`, { action: 'enable' }).expect(200);
    const again = await portal(app, t.sub).post('/auth/login', { email: t.email, password: t.password }).expect(200);

    await prisma.user.update({ where: { id: owner.id }, data: { twofaEnabled: true, twofaSecret: 'x' } });
    await admin.post(`/admin/users/${owner.id}/actions`, { action: 'disable_2fa' }).expect(200);
    await portal(app, t.sub, again.body.token).get('/auth/me').expect(401); // signed out
    const plain = await portal(app, t.sub).post('/auth/login', { email: t.email, password: t.password }).expect(200);
    expect(plain.body.token).toBeDefined(); // no 2FA step

    await admin.post(`/admin/users/${owner.id}/actions`, { action: 'resend_invite' }).expect(400); // has a password
    await admin.post(`/admin/users/${owner.id}/actions`, { action: 'reset_password' }).expect(200);
    expect(await tokenFromEmail(t.email, '/reset-password')).toBeTruthy();
  });
});

describe('Numbers, notes & activity', () => {
  it('moves a number to another customer, unassigned', async () => {
    const s = await withNumber();
    const other = await signupTenant(app);
    const otherId = await idOf(other);
    await admin.post(`/admin/numbers/${s.numberId}/move`, { tenantId: s.id }).expect(400);
    await admin.post(`/admin/numbers/${s.numberId}/move`, { tenantId: otherId }).expect(200);
    const theirs = await admin.get(`/admin/tenants/${otherId}/numbers`).expect(200);
    expect(theirs.body).toHaveLength(1);
    expect(theirs.body[0]).toMatchObject({ e164: s.number, campaign: null });
    expect(await admin.get(`/admin/tenants/${s.id}/numbers`).expect(200).then((r) => r.body)).toHaveLength(0);
  });

  it('keeps internal notes the customer never sees', async () => {
    const t = await signupTenant(app);
    const id = await idOf(t);
    const note = await admin.post(`/admin/tenants/${id}/notes`, { body: 'Wants volume pricing in Q4' }).expect(201);
    expect(note.body).toMatchObject({ authorName: 'Root Admin' });
    expect((await admin.get(`/admin/tenants/${id}/notes`).expect(200)).body).toHaveLength(1);
    await api(t).get(`/admin/tenants/${id}/notes`).expect(403);
    await admin.delete(`/admin/notes/${note.body.id}`).expect(200);
    expect((await admin.get(`/admin/tenants/${id}/notes`).expect(200)).body).toHaveLength(0);
  });
});
