import type { INestApplication } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { prisma } from '@viaroute/db';
import { createApp, portal, resetDb, signupTenant, verifyEmail } from './helpers';

let app: INestApplication;
let admin: ReturnType<typeof portal>;
const realFetch = global.fetch;
const ipqs: string[] = [];
let ipqsDown = false;

beforeAll(async () => {
  await resetDb();
  app = await createApp();
  await prisma.user.create({ data: { email: 'root@viaroute.test', name: 'Root Admin', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash('RootPass123', 4) } });
  const res = await portal(app, null).post('/auth/login', { email: 'root@viaroute.test', password: 'RootPass123' }).expect(200);
  admin = portal(app, null, res.body.token);
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://www.ipqualityscore.com/')) return realFetch(input, init);
    ipqs.push(url);
    if (ipqsDown) return new Response('oops', { status: 500 });
    const number = url.split('/').pop()!.split('?')[0];
    const json = number.endsWith('9999')
      ? { success: true, fraud_score: 95, line_type: 'Wireless', VOIP: false, spammer: true }
      : { success: true, fraud_score: 12, line_type: 'Landline', VOIP: number.endsWith('8888') };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await prisma.$disconnect();
});

type Session = Awaited<ReturnType<typeof signupTenant>>;
const api = (t: Session) => portal(app, t.sub, t.token);

async function setup(campaign: Record<string, unknown> = {}) {
  const t = await signupTenant(app);
  await verifyEmail(app, t);
  await prisma.tenant.update({ where: { subdomain: t.sub }, data: { walletBalance: 100 } });
  const camp = await api(t).post('/campaigns', { name: 'Spam test', revenue: 10 }).expect(201);
  if (Object.keys(campaign).length) await api(t).patch(`/campaigns/${camp.body.id}`, campaign).expect(200);
  const buyer = await api(t).post('/buyers', { name: 'Spam buyer', destination: '+12125550999' }).expect(201);
  await api(t).post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyer.body.id }).expect(201);
  const found = await api(t).get('/numbers/available?type=LOCAL&areaCode=415').expect(200);
  const num = await api(t).post('/numbers', { e164: found.body[0].e164 }).expect(201);
  await api(t).patch(`/numbers/${num.body.id}`, { campaignId: camp.body.id }).expect(200);
  return { t, campaignId: camp.body.id as string, number: num.body.e164 as string };
}

async function call(t: Session, to: string, from: string, extra: Record<string, unknown> = {}) {
  const res = await api(t).post('/simulator/calls', { to, from, talkSec: 30, stepMs: 5, ...extra }).expect(201);
  for (let i = 0; i < 300; i++) {
    const c = await api(t).get(`/calls/${res.body.callId}`).expect(200);
    if (c.body.endedAt) return c.body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('call never finished');
}

describe('Spam protection rules', () => {
  it('blocks hidden caller IDs unless the campaign allows them', async () => {
    const s = await setup();
    expect(await call(s.t, s.number, 'anonymous')).toMatchObject({ status: 'REJECTED', rejectReason: 'spam_anonymous', revenue: '0' });
    await api(s.t).patch(`/campaigns/${s.campaignId}`, { blockAnonymous: false }).expect(200);
    expect((await call(s.t, s.number, 'anonymous')).status).toBe('COMPLETED');
  });

  it('blocks prefixes (area codes, countries, premium numbers)', async () => {
    const s = await setup();
    await api(s.t).patch(`/campaigns/${s.campaignId}`, { blockedPrefixes: ['abc'] }).expect(400);
    await api(s.t).patch(`/campaigns/${s.campaignId}`, { blockedPrefixes: ['1702', '+1900'] }).expect(200);
    const camp = await api(s.t).get(`/campaigns/${s.campaignId}`).expect(200);
    expect(camp.body.blockedPrefixes).toEqual(['+1702', '+1900']);
    expect(await call(s.t, s.number, '+17025550100')).toMatchObject({ status: 'REJECTED', rejectReason: 'spam_prefix' });
    expect((await call(s.t, s.number, '+13055550100')).status).toBe('COMPLETED');
  });

  it('limits calls per caller', async () => {
    const s = await setup({ callerRateLimit: 2, callerRateWindowMin: 60 });
    await call(s.t, s.number, '+13055550111');
    await call(s.t, s.number, '+13055550111');
    expect(await call(s.t, s.number, '+13055550111')).toMatchObject({ status: 'REJECTED', rejectReason: 'spam_rate_limit' });
    expect((await call(s.t, s.number, '+13055550112')).status).toBe('COMPLETED'); // other callers unaffected
  });

  it('requires a verified caller ID (STIR/SHAKEN) when set', async () => {
    const s = await setup({ minAttestation: 'A' });
    expect(await call(s.t, s.number, '+13055550121', { attestation: 'B' })).toMatchObject({ status: 'REJECTED', rejectReason: 'spam_attestation', attestation: 'B' });
    expect(await call(s.t, s.number, '+13055550122')).toMatchObject({ rejectReason: 'spam_attestation' }); // not signed at all
    expect(await call(s.t, s.number, '+13055550123', { attestation: 'A' })).toMatchObject({ status: 'COMPLETED', attestation: 'A' });
    await api(s.t).patch(`/campaigns/${s.campaignId}`, { minAttestation: 'B' }).expect(200);
    expect((await call(s.t, s.number, '+13055550124', { attestation: 'B' })).status).toBe('COMPLETED');
  });

  it('rejects high spam scores, caches lookups and fails open', async () => {
    const s = await setup({ maxSpamScore: 80 });
    // No key yet: nothing is looked up, calls go through.
    expect((await call(s.t, s.number, '+13055559999')).status).toBe('COMPLETED');
    expect(ipqs).toHaveLength(0);

    await admin.put('/admin/spam/reputation', { apiKey: 'ipqs_test_key_1234' }).expect(200);
    const bad = await call(s.t, s.number, '+13055559999');
    expect(bad).toMatchObject({ status: 'REJECTED', rejectReason: 'spam_reputation', spamScore: 95, lineType: 'wireless' });
    expect(ipqs[0]).toContain('/ipqs_test_key_1234/13055559999');
    const good = await call(s.t, s.number, '+13055558888');
    expect(good).toMatchObject({ status: 'COMPLETED', spamScore: 12, lineType: 'voip' });

    const before = ipqs.length;
    await call(s.t, s.number, '+13055559999'); // cached: no new lookup
    expect(ipqs).toHaveLength(before);

    ipqsDown = true;
    expect((await call(s.t, s.number, '+13055557777')).status).toBe('COMPLETED'); // lookup failed → allowed
    ipqsDown = false;

    const test = await admin.post('/admin/spam/lookup', { number: '(305) 555-9999' }).expect(200);
    expect(test.body).toEqual({ number: '+13055559999', score: 95, lineType: 'wireless' });
    const o = await admin.get('/admin/spam').expect(200);
    expect(o.body.reputation).toMatchObject({ configured: true, source: 'admin', keyHint: 'ipq…1234' });
    expect(JSON.stringify(o.body)).not.toContain('ipqs_test_key_1234');
    await admin.put('/admin/spam/reputation', { apiKey: null }).expect(200);
  });

  it('auto-blocks callers who keep making very short calls', async () => {
    const s = await setup({ recordCalls: false, autoBlockShortCalls: 2, shortCallSec: 10 });
    await call(s.t, s.number, '+13055550131', { talkSec: 0 });
    await call(s.t, s.number, '+13055550131', { talkSec: 0 });
    const blocked = await api(s.t).get('/blocked-numbers').expect(200);
    expect(blocked.body[0]).toMatchObject({ e164: '+13055550131', auto: true, reason: 'Auto-blocked: 2 calls under 10s in 24 hours' });
    expect(await call(s.t, s.number, '+13055550131')).toMatchObject({ rejectReason: 'blocked_caller' });
    const notes = await api(s.t).get('/notifications').expect(200);
    expect(notes.body.items.some((n: { type: string }) => n.type === 'spam_blocked')).toBe(true);
    // Long calls never count.
    await call(s.t, s.number, '+13055550132', { talkSec: 60 });
    await call(s.t, s.number, '+13055550132', { talkSec: 60 });
    expect((await api(s.t).get('/blocked-numbers').expect(200)).body).toHaveLength(1);
  });
});

describe('Platform blocklist & reports', () => {
  it('blocks numbers and prefixes for every customer', async () => {
    const a = await setup();
    const b = await setup();
    await admin.post('/admin/spam/blocks', { pattern: 'not a number' }).expect(400);
    const exact = await admin.post('/admin/spam/blocks', { pattern: '+1 (305) 555-0141', reason: 'Known robocaller' }).expect(201);
    expect(exact.body.pattern).toBe('+13055550141');
    await admin.post('/admin/spam/blocks', { pattern: '+13055550141' }).expect(409);
    await admin.post('/admin/spam/blocks', { pattern: '+1808*' }).expect(201);
    await api(a.t).get('/admin/spam').expect(403);

    expect(await call(a.t, a.number, '+13055550141')).toMatchObject({ rejectReason: 'spam_global_block' });
    expect(await call(b.t, b.number, '+18085550100')).toMatchObject({ rejectReason: 'spam_global_block' });

    const o = await admin.get('/admin/spam').expect(200);
    expect(o.body.byReason.spam_global_block).toBeGreaterThanOrEqual(2);
    expect(o.body.topCallers.find((c: { callerNumber: string }) => c.callerNumber === '+13055550141')).toMatchObject({ globallyBlocked: true, customers: 1 });

    await admin.delete(`/admin/spam/blocks/${exact.body.id}`).expect(200);
    expect((await call(a.t, a.number, '+13055550141')).status).toBe('COMPLETED');
  });

  it('shows customers what was blocked and why', async () => {
    const s = await setup({ blockedPrefixes: ['+1702'] });
    await call(s.t, s.number, 'anonymous');
    await call(s.t, s.number, '+17025550100');
    await call(s.t, s.number, '+17025550100');
    await call(s.t, s.number, '+13055550150');

    const o = await api(s.t).get('/spam/overview?days=7').expect(200);
    expect(o.body).toMatchObject({ totalCalls: 4, blockedCalls: 3, byReason: { spam_anonymous: 1, spam_prefix: 2 } });
    expect(o.body.daily).toHaveLength(7);
    expect(o.body.daily[6].blocked).toBe(3);
    expect(o.body.topCallers[0]).toEqual({ callerNumber: '+17025550100', calls: 2 });
    expect(o.body.recent).toHaveLength(3);

    const spamOnly = await api(s.t).get('/calls?spam=true').expect(200);
    expect(spamOnly.body.total).toBe(3);
    const clean = await api(s.t).get('/calls?spam=false').expect(200);
    expect(clean.body.total).toBe(1);
  });
});
