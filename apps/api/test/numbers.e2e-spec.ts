import type { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { prisma } from '@viaroute/db';
import { createApp, portal, resetDb, signupTenant, verifyEmail } from './helpers';

// Test plan "starter" includes 2 numbers; local numbers cost $2/month after that.
let app: INestApplication;
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

beforeAll(async () => {
  await resetDb();
  app = await createApp();
});
afterAll(async () => {
  await app.close();
  await redis.quit();
  await prisma.$disconnect();
});

type Session = Awaited<ReturnType<typeof signupTenant>>;

async function readyTenant(): Promise<Session> {
  const t = await signupTenant(app);
  await verifyEmail(app, t);
  return t;
}

const api = (t: Session) => portal(app, t.sub, t.token);
const wallet = async (t: Session) => Number((await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } })).walletBalance);
const setWallet = (t: Session, amount: number) => prisma.tenant.update({ where: { subdomain: t.sub }, data: { walletBalance: amount } });
const noAllowance = (t: Session) => prisma.tenant.update({ where: { subdomain: t.sub }, data: { planId: null } });

async function searchAndBuy(t: Session, areaCode = '415') {
  const found = await api(t).get(`/numbers/available?type=LOCAL&areaCode=${areaCode}`).expect(200);
  const e164 = found.body[0].e164 as string;
  const res = await api(t).post('/numbers', { e164, label: 'Test line' });
  return { e164, res };
}

/** Pretends the customer was quoted a specific number (to reach the simulated failure/pending numbers). */
async function forceQuote(t: Session, e164: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } });
  await redis.set(`quote:${tenant.id}:${e164}`, JSON.stringify({ e164, type: 'LOCAL', monthlyCost: 1, upfrontCost: 0 }), 'EX', 60);
}

describe('Search', () => {
  it('shows test mode, prices and plan allowance', async () => {
    const t = await readyTenant();
    const res = await api(t).get('/numbers/overview').expect(200);
    expect(res.body).toMatchObject({ testMode: true, includedNumbers: 2, usedNumbers: 0, prices: { LOCAL: 2, TOLL_FREE: 3 } });
  });

  it('finds local numbers in the requested area code', async () => {
    const t = await readyTenant();
    const res = await api(t).get('/numbers/available?type=LOCAL&areaCode=305').expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const n of res.body) expect(n.e164).toMatch(/^\+1305/);
    expect(res.body[0]).toMatchObject({ included: true, monthlyPrice: 0 });
  });

  it('finds toll-free numbers', async () => {
    const t = await readyTenant();
    const res = await api(t).get('/numbers/available?type=TOLL_FREE').expect(200);
    for (const n of res.body) expect(n.e164).toMatch(/^\+18(33|44|55)/);
  });

  it('rejects a bad area code', async () => {
    const t = await readyTenant();
    await api(t).get('/numbers/available?type=LOCAL&areaCode=12').expect(400);
  });
});

describe('Buying', () => {
  it('requires a confirmed email', async () => {
    const t = await signupTenant(app);
    const found = await api(t).get('/numbers/available?type=LOCAL').expect(200);
    const res = await api(t).post('/numbers', { e164: found.body[0].e164 }).expect(403);
    expect(res.body.message).toContain('confirm your email');
  });

  it('only sells numbers the customer was quoted', async () => {
    const t = await readyTenant();
    await api(t).post('/numbers', { e164: '+14155550142' }).expect(400);
  });

  it('uses plan-included numbers first (no charge)', async () => {
    const t = await readyTenant();
    const { e164, res } = await searchAndBuy(t);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ e164, status: 'ACTIVE', label: 'Test line', monthlyPrice: '0' });
    expect(await wallet(t)).toBe(0);

    const list = await api(t).get('/numbers').expect(200);
    expect(list.body.map((n: { e164: string }) => n.e164)).toEqual([e164]);
    const overview = await api(t).get('/tenant').expect(200);
    expect(overview.body.counts.numbers).toBe(1);
  });

  it('charges the wallet beyond the allowance, and refuses when funds are short', async () => {
    const t = await readyTenant();
    await noAllowance(t);

    const noMoney = await searchAndBuy(t);
    expect(noMoney.res.status).toBe(402);
    expect(noMoney.res.body.message).toContain('Not enough funds');

    await setWallet(t, 10);
    const { res } = await searchAndBuy(t);
    expect(res.status).toBe(201);
    expect(await wallet(t)).toBe(8);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } });
    const txs = await prisma.transaction.findMany({ where: { tenantId: tenant.id } });
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ type: 'NUMBER_RENTAL' });
    expect(Number(txs[0].amount)).toBe(-2);
    expect(Number(txs[0].balanceAfter)).toBe(8);
  });

  it('never overspends when two purchases race for the last $2', async () => {
    const t = await readyTenant();
    await noAllowance(t);
    await setWallet(t, 2);
    const found = await api(t).get('/numbers/available?type=LOCAL&areaCode=512').expect(200);
    const [a, b] = await Promise.all([
      api(t).post('/numbers', { e164: found.body[0].e164 }),
      api(t).post('/numbers', { e164: found.body[1].e164 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 402]);
    expect(await wallet(t)).toBe(0);
  });

  it('gives a number to only one customer', async () => {
    const a = await readyTenant();
    const b = await readyTenant();
    const { e164 } = await searchAndBuy(a, '702');

    const bSearch = await api(b).get('/numbers/available?type=LOCAL&areaCode=702').expect(200);
    expect(bSearch.body.map((n: { e164: string }) => n.e164)).not.toContain(e164);

    await forceQuote(b, e164);
    await api(b).post('/numbers', { e164 }).expect(409);
  });

  it('refunds and hides the number when the carrier rejects it', async () => {
    const t = await readyTenant();
    await noAllowance(t);
    await setWallet(t, 5);
    await forceQuote(t, '+12125550199'); // simulated carrier rejection
    const res = await api(t).post('/numbers', { e164: '+12125550199' }).expect(502);
    expect(res.body.message).toContain('not been charged');
    expect(await wallet(t)).toBe(5);
    expect((await api(t).get('/numbers').expect(200)).body).toHaveLength(0);
  });

  it('finishes pending carrier orders when the list is loaded', async () => {
    const t = await readyTenant();
    await forceQuote(t, '+12125550198'); // simulated slow activation
    const res = await api(t).post('/numbers', { e164: '+12125550198' }).expect(201);
    expect(res.body.status).toBe('PENDING');
    const list = await api(t).get('/numbers').expect(200);
    expect(list.body[0]).toMatchObject({ e164: '+12125550198', status: 'ACTIVE' });
  });
});

describe('Managing numbers', () => {
  it('renames a number', async () => {
    const t = await readyTenant();
    const { res } = await searchAndBuy(t);
    const upd = await api(t).patch(`/numbers/${res.body.id}`, { label: 'Google Ads – Plumbing' }).expect(200);
    expect(upd.body.label).toBe('Google Ads – Plumbing');
  });

  it('releases a number, which can then be bought again', async () => {
    const a = await readyTenant();
    const b = await readyTenant();
    const { e164, res } = await searchAndBuy(a, '713');
    await api(a).delete(`/numbers/${res.body.id}`).expect(200);
    expect((await api(a).get('/numbers').expect(200)).body).toHaveLength(0);

    await forceQuote(b, e164);
    await api(b).post('/numbers', { e164 }).expect(201);
  });

  it("🔒 can't see, rename or release another customer's number", async () => {
    const a = await readyTenant();
    const b = await readyTenant();
    const { res } = await searchAndBuy(a);
    expect((await api(b).get('/numbers').expect(200)).body).toHaveLength(0);
    await api(b).patch(`/numbers/${res.body.id}`, { label: 'hijack' }).expect(404);
    await api(b).delete(`/numbers/${res.body.id}`).expect(404);
  });

  it("🔒 can't link a number to another customer's campaign", async () => {
    const a = await readyTenant();
    const b = await readyTenant();
    const bTenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: b.sub } });
    const bCampaign = await prisma.campaign.create({ data: { tenantId: bTenant.id, name: 'B campaign' } });
    const { res } = await searchAndBuy(a);
    await api(a).patch(`/numbers/${res.body.id}`, { campaignId: bCampaign.id }).expect(400);
  });
});

describe('Admin wallet adjustments', () => {
  async function adminToken() {
    const bcrypt = await import('bcryptjs');
    const email = 'root@viaroute.test';
    if (!(await prisma.user.findFirst({ where: { email, tenantId: null } }))) {
      await prisma.user.create({ data: { email, name: 'Root', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash('RootPass123', 4) } });
    }
    const res = await portal(app, null).post('/auth/login', { email, password: 'RootPass123' }).expect(200);
    return res.body.token as string;
  }

  it('adds and removes credit with a ledger entry', async () => {
    const t = await readyTenant();
    const token = await adminToken();
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } });
    const admin = portal(app, null, token);

    await admin.post(`/admin/tenants/${tenant.id}/credit`, { amount: 25, note: 'Welcome bonus' }).expect(200);
    expect(await wallet(t)).toBe(25);
    await admin.post(`/admin/tenants/${tenant.id}/credit`, { amount: -30, note: 'Too much' }).expect(402);
    await admin.post(`/admin/tenants/${tenant.id}/credit`, { amount: -5, note: 'Correction' }).expect(200);
    expect(await wallet(t)).toBe(20);
    expect(await prisma.transaction.count({ where: { tenantId: tenant.id, type: 'ADJUSTMENT' } })).toBe(2);
  });

  it('is off-limits to customers', async () => {
    const t = await readyTenant();
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } });
    await api(t).post(`/admin/tenants/${tenant.id}/credit`, { amount: 1000, note: 'free money' }).expect(403);
  });
});
