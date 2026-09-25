import type { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { prisma } from '@viaroute/db';
import { CapsService } from '../src/routing/caps.service';
import { localTime, DAYS } from '../src/routing/rules';
import { createApp, portal, resetDb, signupTenant, tokenFromEmail, uid, verifyEmail } from './helpers';

let app: INestApplication;
let hookServer: Server;
let hookUrl: string;
const hooks: string[] = [];

beforeAll(async () => {
  await resetDb();
  app = await createApp();
  hookServer = createServer((req, res) => {
    hooks.push(req.url ?? '');
    res.writeHead(req.url?.includes('fail') ? 500 : 200).end('ok');
  });
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  hookServer.close();
  await app.close();
  await prisma.$disconnect();
});

type Session = Awaited<ReturnType<typeof signupTenant>>;
const api = (t: Session) => portal(app, t.sub, t.token);

interface BuyerSpec {
  name?: string;
  priority?: number;
  weight?: number;
  dailyCap?: number;
  schedule?: object;
  geoRules?: object;
  revenueOverride?: number;
}

/** A tenant with money, a campaign ($40 revenue / $25 payout, converts at 90s), buyers, a publisher and a live number. */
async function setup(buyers: BuyerSpec[] = [{}], campaign: Record<string, unknown> = {}) {
  const t = await signupTenant(app);
  await verifyEmail(app, t);
  await prisma.tenant.update({ where: { subdomain: t.sub }, data: { walletBalance: 100 } });

  const pub = await api(t).post('/publishers', { name: 'Pub One', payoutOverride: null, postbackUrl: `${hookUrl}/cb?id={call_id}&p={payout}&d={duration}&c={campaign}` }).expect(201);
  const camp = await api(t).post('/campaigns', { name: 'Auto Insurance', revenue: 40, payout: 25, convertAfterSeconds: 90, ...campaign }).expect(201);

  const buyerIds: string[] = [];
  for (const [i, b] of buyers.entries()) {
    const buyer = await api(t).post('/buyers', { name: b.name ?? `Buyer ${i + 1}`, destination: `+1212555${String(1000 + i)}` }).expect(201);
    buyerIds.push(buyer.body.id);
    const { name: _n, ...route } = b;
    await api(t).post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyer.body.id, priority: i + 1, ...route }).expect(201);
  }

  const found = await api(t).get('/numbers/available?type=LOCAL&areaCode=415').expect(200);
  const num = await api(t).post('/numbers', { e164: found.body[0].e164 }).expect(201);
  await api(t).patch(`/numbers/${num.body.id}`, { campaignId: camp.body.id, publisherId: pub.body.id }).expect(200);

  return { t, campaignId: camp.body.id as string, publisherId: pub.body.id as string, buyerIds, number: num.body.e164 as string };
}

const FINAL = ['COMPLETED', 'NO_ANSWER', 'REJECTED', 'FAILED'];

/** Places a simulated call and waits until it's fully processed. */
async function call(t: Session, to: string, opts: { from?: string; outcomes?: string[]; talkSec?: number; hangupBy?: string; waitRecording?: boolean } = {}) {
  const from = opts.from ?? `+1305555${Math.floor(1000 + Math.random() * 8999)}`;
  const res = await api(t).post('/simulator/calls', { to, from, outcomes: opts.outcomes, talkSec: opts.talkSec ?? 120, hangupBy: opts.hangupBy, stepMs: 5 }).expect(201);
  const id = res.body.callId as string;
  for (let i = 0; i < 300; i++) {
    const c = await api(t).get(`/calls/${id}`).expect(200);
    if (FINAL.includes(c.body.status) && c.body.endedAt && (!opts.waitRecording || c.body.recordingLink)) return c.body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Call ${id} never finished`);
}

const wallet = async (t: Session) => Number((await prisma.tenant.findUniqueOrThrow({ where: { subdomain: t.sub } })).walletBalance);

describe('Campaign setup (Module 4)', () => {
  it('validates buyer destinations', async () => {
    const t = await signupTenant(app);
    await api(t).post('/buyers', { name: 'Bad', destination: '555-1234' }).expect(400);
    await api(t).post('/buyers', { name: 'SIP buyer', destinationType: 'SIP', destination: 'sip:agent@pbx.example.com' }).expect(201);
  });

  it('validates schedules and states on routes', async () => {
    const t = await signupTenant(app);
    const camp = await api(t).post('/campaigns', { name: 'Test' }).expect(201);
    const buyer = await api(t).post('/buyers', { name: 'Buyer B', destination: '+12125550000' }).expect(201);
    const url = `/campaigns/${camp.body.id}/routes`;
    await api(t).post(url, { buyerId: buyer.body.id, schedule: { funday: [['09:00', '17:00']] } }).expect(400);
    await api(t).post(url, { buyerId: buyer.body.id, schedule: { mon: [['9am', '5pm']] } }).expect(400);
    await api(t).post(url, { buyerId: buyer.body.id, geoRules: { allowStates: ['XX'] } }).expect(400);
    await api(t).post(url, { buyerId: buyer.body.id, schedule: { mon: [['09:00', '17:00']] }, geoRules: { allowStates: ['CA'] }, dailyCap: 10 }).expect(201);
    await api(t).post(url, { buyerId: buyer.body.id }).expect(400); // same buyer twice
    const detail = await api(t).get(`/campaigns/${camp.body.id}`).expect(200);
    expect(detail.body.routes[0]).toMatchObject({ dailyCap: 10, geoRules: { allowStates: ['CA'] } });
  });

  it("🔒 can't route to another customer's buyer", async () => {
    const a = await signupTenant(app);
    const b = await signupTenant(app);
    const bBuyer = await api(b).post('/buyers', { name: 'B buyer', destination: '+12125550001' }).expect(201);
    const camp = await api(a).post('/campaigns', { name: 'A camp' }).expect(201);
    await api(a).post(`/campaigns/${camp.body.id}/routes`, { buyerId: bBuyer.body.id }).expect(404);
    await api(a).get(`/campaigns/${camp.body.id}`).expect(200);
    await api(b).get(`/campaigns/${camp.body.id}`).expect(404);
  });
});

describe('Call routing (Module 5)', () => {
  it('connects, records, converts, pays and charges usage', async () => {
    const s = await setup();
    const c = await call(s.t, s.number, { talkSec: 120, waitRecording: true });

    expect(c).toMatchObject({ status: 'COMPLETED', converted: true, attempts: 1, connectedSec: 120, durationSec: 130, duplicate: false });
    expect(c.buyer.id).toBe(s.buyerIds[0]);
    expect(Number(c.revenue)).toBe(40);
    expect(Number(c.payout)).toBe(25);
    // (ceil(130/60)=3 + ceil(120/60)=2) minutes × $0.025
    expect(Number(c.cost)).toBeCloseTo(0.125);
    expect(await wallet(s.t)).toBeCloseTo(100 - 0.125);

    const audio = await request(app.getHttpServer()).get(c.recordingLink).expect(200);
    expect(audio.headers['content-type']).toContain('audio/wav');
    await request(app.getHttpServer()).get(c.recordingLink.replace(/sig=[^&]+/, 'sig=forged')).expect(403);
  });

  it('does not convert short calls', async () => {
    const s = await setup();
    const c = await call(s.t, s.number, { talkSec: 30 });
    expect(c).toMatchObject({ status: 'COMPLETED', converted: false, revenue: '0', payout: '0' });
  });

  it('uses a per-buyer revenue override', async () => {
    const s = await setup([{ revenueOverride: 55 }]);
    const c = await call(s.t, s.number);
    expect(Number(c.revenue)).toBe(55);
  });

  it('fails over to the next buyer when one does not answer or is busy', async () => {
    const s = await setup([{ name: 'First' }, { name: 'Second' }, { name: 'Third' }]);
    const c = await call(s.t, s.number, { outcomes: ['no_answer', 'busy', 'answer'] });
    expect(c).toMatchObject({ status: 'COMPLETED', attempts: 3, converted: true });
    expect(c.buyer.name).toBe('Third');
  });

  it('tells the caller nobody is available when every buyer fails', async () => {
    const s = await setup([{}, {}]);
    const c = await call(s.t, s.number, { outcomes: ['no_answer', 'busy'] });
    expect(c).toMatchObject({ status: 'NO_ANSWER', rejectReason: 'no_buyer_available', attempts: 2, converted: false });
  });

  it('sends unsold calls to the fallback number (unpaid)', async () => {
    const s = await setup([{}], { fallbackNumber: '+12125559999' });
    const c = await call(s.t, s.number, { outcomes: ['no_answer', 'answer'] });
    expect(c).toMatchObject({ status: 'COMPLETED', rejectReason: 'sent_to_fallback', converted: false, attempts: 2, buyer: null });
  });

  it('respects daily caps and notifies once', async () => {
    const s = await setup([{ name: 'Capped', dailyCap: 1 }, { name: 'Backup' }]);
    const first = await call(s.t, s.number);
    const second = await call(s.t, s.number);
    const third = await call(s.t, s.number);
    expect([first.buyer.name, second.buyer.name, third.buyer.name]).toEqual(['Capped', 'Backup', 'Backup']);

    const notes = await api(s.t).get('/notifications').expect(200);
    expect(notes.body.items.filter((n: { type: string }) => n.type === 'cap_reached')).toHaveLength(1);
  });

  it('reports buyer capacity (fullest first)', async () => {
    const s = await setup([{ name: 'Capped', dailyCap: 2 }, { name: 'Open' }]);
    await call(s.t, s.number);
    const cap = await api(s.t).get('/reports/capacity').expect(200);
    expect(cap.body[0]).toMatchObject({ buyer: { name: 'Capped' }, today: 1, dailyCap: 2, live: 0, fill: 0.5 });
    expect(cap.body[1]).toMatchObject({ buyer: { name: 'Open' }, today: 0, dailyCap: null });
  });

  it('gives back the cap when a buyer does not answer', async () => {
    const s = await setup([{ name: 'Capped', dailyCap: 1 }, { name: 'Backup' }]);
    await call(s.t, s.number, { outcomes: ['no_answer', 'answer'] }); // Capped didn't pick up
    const next = await call(s.t, s.number);
    expect(next.buyer.name).toBe('Capped');
  });

  it('enforces concurrency caps atomically', async () => {
    const caps = app.get(CapsService);
    const route = `test-${uid()}`;
    const limits = { concurrencyCap: 1, hourlyCap: null, dailyCap: null, monthlyCap: null };
    const results = await Promise.all([1, 2, 3].map(() => caps.reserve(route, limits, 'America/New_York')));
    expect(results.filter((r) => r === null)).toHaveLength(1);
    await caps.releaseConcurrency(route);
    expect(await caps.reserve(route, limits, 'America/New_York')).toBeNull();
  });

  it('skips buyers outside their business hours', async () => {
    const { day } = localTime(new Date(), 'America/New_York');
    const tomorrow = DAYS[(DAYS.indexOf(day) + 1) % 7];
    const s = await setup([{ name: 'Closed today', schedule: { [tomorrow]: [['00:00', '23:59']] } }, { name: 'Open' }]);
    const c = await call(s.t, s.number);
    expect(c.buyer.name).toBe('Open');
  });

  it('routes by caller state', async () => {
    const s = await setup([{ name: 'Texas only', geoRules: { allowStates: ['TX'] } }, { name: 'Everyone' }]);
    const ca = await call(s.t, s.number, { from: '+14155551234' });
    const tx = await call(s.t, s.number, { from: '+15125551234' });
    expect(ca).toMatchObject({ callerState: 'CA' });
    expect(ca.buyer.name).toBe('Everyone');
    expect(tx.buyer.name).toBe('Texas only');
  });

  it('routes repeat callers but does not pay for them', async () => {
    const s = await setup();
    const first = await call(s.t, s.number, { from: '+13055550111' });
    const again = await call(s.t, s.number, { from: '+13055550111' });
    expect(first).toMatchObject({ converted: true, duplicate: false });
    expect(again).toMatchObject({ status: 'COMPLETED', converted: false, duplicate: true, payout: '0' });
  });

  it('rejects blocked callers without charging', async () => {
    const s = await setup();
    await api(s.t).post('/blocked-numbers', { e164: '+13055550666', reason: 'Spam' }).expect(201);
    const c = await call(s.t, s.number, { from: '+13055550666' });
    expect(c).toMatchObject({ status: 'REJECTED', rejectReason: 'blocked_caller', attempts: 0 });
    expect(await wallet(s.t)).toBe(100);
  });

  it('rejects calls when the wallet is empty and alerts the customer', async () => {
    const s = await setup();
    await prisma.tenant.update({ where: { subdomain: s.t.sub }, data: { walletBalance: 0 } });
    const c = await call(s.t, s.number);
    expect(c).toMatchObject({ status: 'REJECTED', rejectReason: 'no_balance' });
    const notes = await api(s.t).get('/notifications').expect(200);
    expect(notes.body.items[0]).toMatchObject({ type: 'low_balance', title: expect.stringContaining('empty') });
    // Admins were emailed too.
    let subjects: string[] = [];
    for (let i = 0; i < 30 && !subjects.some((x) => x.includes('empty')); i++) {
      const found = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:"${s.t.email}"`)}`).then((r) => r.json());
      subjects = (found.messages ?? []).map((m: { Subject: string }) => m.Subject);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(subjects.some((x) => x.includes('Your wallet is empty'))).toBe(true);
  });

  it('rejects calls for paused campaigns', async () => {
    const s = await setup();
    await api(s.t).patch(`/campaigns/${s.campaignId}`, { active: false }).expect(200);
    const c = await call(s.t, s.number);
    expect(c).toMatchObject({ status: 'REJECTED', rejectReason: 'campaign_paused' });
  });

  it('does not route simulated calls to numbers the customer does not own', async () => {
    const a = await setup();
    const b = await setup();
    await api(b.t).post('/simulator/calls', { to: a.number, from: '+13055550100' }).expect(400);
  });
});

describe('Targets & repeat callers', () => {
  it('validates targets and target routes', async () => {
    const t = await signupTenant(app);
    const buyer = await api(t).post('/buyers', { name: 'Big Buyer', destination: '+12125550100' }).expect(201);
    await api(t).post('/targets', { name: 'Bad', destination: '555' }).expect(400);
    await api(t).post('/targets', { name: 'Ghost', destination: '+12125550101', buyerId: '00000000-0000-4000-8000-000000000000' }).expect(404);
    const east = await api(t).post('/targets', { name: 'East center', buyerId: buyer.body.id, destination: '+12125550102', concurrencyCap: 3 }).expect(201);
    const own = await api(t).post('/targets', { name: 'Our agents', destinationType: 'SIP', destination: 'sip:queue@pbx.example.com' }).expect(201);

    const camp = await api(t).post('/campaigns', { name: 'Camp' }).expect(201);
    const url = `/campaigns/${camp.body.id}/routes`;
    await api(t).post(url, {}).expect(400);
    await api(t).post(url, { buyerId: buyer.body.id, targetId: east.body.id }).expect(400);
    await api(t).post(url, { buyerId: buyer.body.id }).expect(201); // buyer's main line
    await api(t).post(url, { targetId: east.body.id, priority: 2 }).expect(201); // and one of its centers
    await api(t).post(url, { targetId: east.body.id }).expect(400); // same target twice
    await api(t).post(url, { targetId: own.body.id, priority: 3 }).expect(201);

    const detail = await api(t).get(`/campaigns/${camp.body.id}`).expect(200);
    expect(detail.body.routes.map((r: { buyerId: string | null; target: { name: string } | null }) => [r.buyerId, r.target?.name ?? null])).toEqual([
      [buyer.body.id, null],
      [buyer.body.id, 'East center'],
      [null, 'Our agents'],
    ]);
    const list = await api(t).get('/targets').expect(200);
    expect(list.body.find((x: { id: string }) => x.id === east.body.id)).toMatchObject({ buyer: { name: 'Big Buyer' }, liveCalls: 0, _count: { routes: 1 } });
  });

  it("🔒 can't use another customer's target", async () => {
    const a = await signupTenant(app);
    const b = await signupTenant(app);
    const bt = await api(b).post('/targets', { name: 'B target', destination: '+12125550103' }).expect(201);
    const camp = await api(a).post('/campaigns', { name: 'A camp' }).expect(201);
    await api(a).post(`/campaigns/${camp.body.id}/routes`, { targetId: bt.body.id }).expect(404);
    await api(a).patch(`/targets/${bt.body.id}`, { name: 'Mine now' }).expect(404);
  });

  it("routes to a buyer's target and to a direct target; buyer logins see their target calls", async () => {
    const s = await setup([]);
    const buyer = await api(s.t).post('/buyers', { name: 'Target Buyer', destination: '+12125550110' }).expect(201);
    const center = await api(s.t).post('/targets', { name: 'West center', buyerId: buyer.body.id, destination: '+12125550111' }).expect(201);
    const own = await api(s.t).post('/targets', { name: 'In-house team', destination: '+12125550112' }).expect(201);
    await api(s.t).post(`/campaigns/${s.campaignId}/routes`, { targetId: center.body.id, priority: 1 }).expect(201);
    await api(s.t).post(`/campaigns/${s.campaignId}/routes`, { targetId: own.body.id, priority: 2 }).expect(201);

    const first = await call(s.t, s.number);
    expect(first).toMatchObject({ status: 'COMPLETED', converted: true, revenue: '40', buyer: { name: 'Target Buyer' }, target: { name: 'West center' } });

    const second = await call(s.t, s.number, { outcomes: ['no_answer', 'answer'] });
    expect(second).toMatchObject({ status: 'COMPLETED', converted: true, attempts: 2, buyer: null, target: { name: 'In-house team' } });

    const csv = await api(s.t).get('/calls/export.csv?columns=caller,buyer,target').expect(200);
    expect(csv.text).toContain('Target Buyer,West center');
    const byTarget = await api(s.t).get('/reports/summary?groupBy=target').expect(200);
    expect(byTarget.body.breakdown.map((b: { name: string }) => b.name).sort()).toEqual(['In-house team', 'West center']);
  });

  it("shares a target's lines across campaigns and skips it when they are all busy", async () => {
    const s = await setup([{ name: 'Backup buyer', priority: 2 }]);
    const busy = await api(s.t).post('/targets', { name: 'One line', destination: '+12125550120', concurrencyCap: 1 }).expect(201);
    await api(s.t).post(`/campaigns/${s.campaignId}/routes`, { targetId: busy.body.id, priority: 1 }).expect(201);

    const caps = app.get(CapsService);
    const scope = `t:${busy.body.id}`;
    const none = { concurrencyCap: null, hourlyCap: null, dailyCap: null, monthlyCap: null };
    expect(await caps.reserve(scope, none, 'America/New_York')).toBeNull(); // a call from another campaign is on the line
    const c = await call(s.t, s.number);
    expect(c.buyer.name).toBe('Backup buyer');

    await caps.releaseConcurrency(scope);
    const next = await call(s.t, s.number);
    expect(next.target.name).toBe('One line');
    const list = await api(s.t).get('/targets').expect(200);
    expect(list.body[0]).toMatchObject({ liveCalls: 0 }); // freed when the call ended
    expect(list.body[0].usage.day).toBe(2); // counted today (the fake call and the real one)
  });

  it('accepts numbers and IP addresses as destinations', async () => {
    const t = await signupTenant(app);
    const ip = await api(t).post('/targets', { name: 'PBX', destinationType: 'SIP', destination: '203.0.113.10:5060' }).expect(201);
    expect(ip.body.destination).toBe('sip:203.0.113.10:5060');
    const uri = await api(t).post('/targets', { name: 'Agent', destinationType: 'SIP', destination: 'sip:agent@pbx.example.com' }).expect(201);
    expect(uri.body.destination).toBe('sip:agent@pbx.example.com');
    await api(t).post('/targets', { name: 'Bad IP', destinationType: 'SIP', destination: 'not an ip' }).expect(400);
    await api(t).post('/targets', { name: 'Bad number', destinationType: 'PHONE', destination: '203.0.113.10' }).expect(400);
    const buyer = await api(t).post('/buyers', { name: 'IP buyer', destinationType: 'SIP', destination: '198.51.100.7' }).expect(201);
    expect(buyer.body.destination).toBe('sip:198.51.100.7');
  });

  it("uses the target's priority when it's added to a campaign", async () => {
    const t = await signupTenant(app);
    const camp = await api(t).post('/campaigns', { name: 'Priority test' }).expect(201);
    const t3 = await api(t).post('/targets', { name: 'Third', destination: '+12125550130', priority: 3 }).expect(201);
    const t5 = await api(t).post('/targets', { name: 'Fifth', destination: '+12125550131', priority: 5 }).expect(201);
    await api(t).post(`/campaigns/${camp.body.id}/routes`, { targetId: t3.body.id }).expect(201);
    await api(t).post(`/campaigns/${camp.body.id}/routes`, { targetId: t5.body.id, priority: 1 }).expect(201); // override
    const detail = await api(t).get(`/campaigns/${camp.body.id}`).expect(200);
    expect(detail.body.routes.map((r: { priority: number; target: { name: string } }) => [r.target.name, r.priority])).toEqual([['Fifth', 1], ['Third', 3]]);
  });

  it("applies a target's daily cap across every campaign and notifies once", async () => {
    const a = await setup([{ name: 'Backup buyer', priority: 2 }]);
    const capped = await api(a.t).post('/targets', { name: 'Two a day', destination: '+12125550140', dailyCap: 2 }).expect(201);
    await api(a.t).post(`/campaigns/${a.campaignId}/routes`, { targetId: capped.body.id, priority: 1 }).expect(201);
    // A second campaign on the same account shares the target's cap.
    const camp2 = await api(a.t).post('/campaigns', { name: 'Second campaign', revenue: 10 }).expect(201);
    await api(a.t).post(`/campaigns/${camp2.body.id}/routes`, { targetId: capped.body.id }).expect(201);
    const found = await api(a.t).get('/numbers/available?type=LOCAL&areaCode=415').expect(200);
    const num2 = await api(a.t).post('/numbers', { e164: found.body.find((n: { e164: string }) => n.e164 !== a.number).e164 }).expect(201);
    await api(a.t).patch(`/numbers/${num2.body.id}`, { campaignId: camp2.body.id }).expect(200);

    expect((await call(a.t, a.number)).target.name).toBe('Two a day');
    expect((await call(a.t, num2.body.e164)).target.name).toBe('Two a day');
    const third = await call(a.t, a.number);
    expect(third).toMatchObject({ buyer: { name: 'Backup buyer' }, target: null });
    await call(a.t, a.number);
    const notes = await api(a.t).get('/notifications').expect(200);
    expect(notes.body.items.filter((n: { title: string }) => n.title === 'Two a day reached its daily cap across all campaigns')).toHaveLength(1);
  });

  it("applies a buyer's caps to its main line and all its targets", async () => {
    const s = await setup([]);
    const buyer = await api(s.t).post('/buyers', { name: 'Capped buyer', destination: '+12125550150', hourlyCap: 1 }).expect(201);
    const center = await api(s.t).post('/targets', { name: 'Capped buyer center', buyerId: buyer.body.id, destination: '+12125550151' }).expect(201);
    const other = await api(s.t).post('/targets', { name: 'Direct overflow', destination: '+12125550152' }).expect(201);
    await api(s.t).post(`/campaigns/${s.campaignId}/routes`, { buyerId: buyer.body.id, priority: 1 }).expect(201);
    await api(s.t).post(`/campaigns/${s.campaignId}/routes`, { targetId: center.body.id, priority: 2 }).expect(201);
    await api(s.t).post(`/campaigns/${s.campaignId}/routes`, { targetId: other.body.id, priority: 3 }).expect(201);

    expect((await call(s.t, s.number)).buyer.name).toBe('Capped buyer');
    const next = await call(s.t, s.number); // main line and its center are both over the buyer's hourly cap
    expect(next).toMatchObject({ buyer: null, target: { name: 'Direct overflow' } });
    const list = await api(s.t).get('/buyers').expect(200);
    expect(list.body[0]).toMatchObject({ hourlyCap: 1, usage: { hour: 1 } });
  });

  it('sends repeat callers to a buyer that has not had them yet, who pays; the publisher is not paid again', async () => {
    const s = await setup([{ name: 'Buyer A' }, { name: 'Buyer B' }]);
    const from = '+13055550222';
    const first = await call(s.t, s.number, { from });
    expect(first).toMatchObject({ buyer: { name: 'Buyer A' }, converted: true, duplicate: false, payout: '25' });

    const second = await call(s.t, s.number, { from });
    expect(second).toMatchObject({ buyer: { name: 'Buyer B' }, converted: true, duplicate: true, revenue: '40', payout: '0' });

    // Both have had the caller now: normal order, and no one pays twice.
    const third = await call(s.t, s.number, { from });
    expect(third).toMatchObject({ buyer: { name: 'Buyer A' }, converted: false, duplicate: true, revenue: '0' });
  });

  it('can keep repeat callers with the same buyer, or ignore history', async () => {
    const same = await setup([{ name: 'Buyer A' }, { name: 'Buyer B' }], { repeatRouting: 'SAME' });
    await call(same.t, same.number, { from: '+13055550333', outcomes: ['no_answer', 'answer'] }); // Buyer B took it
    const again = await call(same.t, same.number, { from: '+13055550333' });
    expect(again).toMatchObject({ buyer: { name: 'Buyer B' }, converted: false, duplicate: true });

    const normal = await setup([{ name: 'Buyer A' }, { name: 'Buyer B' }], { repeatRouting: 'NORMAL' });
    await call(normal.t, normal.number, { from: '+13055550444' });
    const repeat = await call(normal.t, normal.number, { from: '+13055550444' });
    expect(repeat).toMatchObject({ buyer: { name: 'Buyer A' }, converted: false });

    await api(normal.t).patch(`/campaigns/${normal.campaignId}`, { repeatRouting: 'SOMETIMES' }).expect(400);
  });
});

describe('Conversions & postbacks (Module 7)', () => {
  it('fires the publisher postback with filled-in values', async () => {
    const s = await setup();
    const c = await call(s.t, s.number, { talkSec: 100 });
    for (let i = 0; i < 100 && !hooks.some((h) => h.includes(c.id)); i++) await new Promise((r) => setTimeout(r, 30));
    const hit = hooks.find((h) => h.includes(c.id))!;
    expect(hit).toBe(`/cb?id=${c.id}&p=25.00&d=110&c=Auto%20Insurance`);

    let detail;
    for (let i = 0; i < 50; i++) {
      detail = (await api(s.t).get(`/calls/${c.id}`).expect(200)).body;
      if (detail.postbacks[0]?.succeededAt) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(detail.postbacks[0]).toMatchObject({ statusCode: 200, attempts: 1 });
  });

  it('does not fire postbacks for unconverted calls', async () => {
    const s = await setup();
    const c = await call(s.t, s.number, { talkSec: 10 });
    await new Promise((r) => setTimeout(r, 200));
    expect(hooks.some((h) => h.includes(c.id))).toBe(false);
  });
});

describe('Call logs, reports & partner logins (Module 6)', () => {
  it('reports totals and breakdowns that match the calls', async () => {
    const s = await setup([{ name: 'Alpha' }, { name: 'Beta' }]);
    await call(s.t, s.number, { talkSec: 120 }); // converted → Alpha
    await call(s.t, s.number, { talkSec: 20 }); // not converted → Alpha
    await call(s.t, s.number, { outcomes: ['busy', 'answer'], talkSec: 95 }); // converted → Beta

    const r = await api(s.t).get('/reports/summary?groupBy=buyer').expect(200);
    expect(r.body.totals).toMatchObject({ calls: 3, answered: 3, converted: 2 });
    expect(Number(r.body.totals.revenue)).toBe(80);
    expect(Number(r.body.totals.payout)).toBe(50);
    const byName = Object.fromEntries(r.body.breakdown.map((b: { name: string; calls: number }) => [b.name, b.calls]));
    expect(byName).toEqual({ Alpha: 2, Beta: 1 });
    expect(r.body.daily.reduce((sum: number, d: { calls: number }) => sum + d.calls, 0)).toBe(3);
    expect(r.body.hourly).toHaveLength(24);
    expect(r.body.hourly.reduce((sum: number, h: { calls: number }) => sum + h.calls, 0)).toBe(3);
    expect(r.body.hourly.reduce((sum: number, h: { revenue: number }) => sum + h.revenue, 0)).toBe(80);

    const csv = await api(s.t).get('/calls/export.csv').expect(200);
    expect(csv.text).toContain('Call ID,Started (America/New_York),Caller');
    expect(csv.text.trim().split('\r\n')).toHaveLength(4);

    const list = await api(s.t).get('/calls?converted=true').expect(200);
    expect(list.body.total).toBe(2);
  });

  it('filters calls by state, talk time, repeat callers and tracking number', async () => {
    const s = await setup([{ name: 'Alpha' }]);
    await call(s.t, s.number, { from: '+15125550101', talkSec: 150 }); // TX, long
    await call(s.t, s.number, { from: '+14155550102', talkSec: 20 }); // CA, short
    await call(s.t, s.number, { from: '+14155550102', talkSec: 20 }); // CA repeat

    const q = async (qs: string) => (await api(s.t).get(`/calls?${qs}`).expect(200)).body.total;
    expect(await q('state=TX')).toBe(1);
    expect(await q('state=ca')).toBe(2);
    expect(await q('minTalk=100')).toBe(1);
    expect(await q('duplicate=true')).toBe(1);
    expect(await q('recorded=true')).toBe(3);
    expect(await q(`number=${s.number.slice(2, 8)}`)).toBe(3);
    expect(await q('number=9999999')).toBe(0);
    const longest = await api(s.t).get('/calls?sort=longest').expect(200);
    expect(longest.body.items[0].connectedSec).toBe(150);
  });

  it('exports CDRs with chosen columns and times in the chosen timezone', async () => {
    const s = await setup();
    await call(s.t, s.number, { talkSec: 120 });

    const cols = await api(s.t).get('/calls/columns').expect(200);
    expect(cols.body.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['call_id', 'hangup_cause', 'profit']));

    const csv = await api(s.t).get('/calls/export.csv?columns=caller,started,talk_sec,profit,bogus&tz=Asia/Kolkata').expect(200);
    const [header, row] = csv.text.replace(/^﻿/, '').split('\r\n');
    expect(header).toBe('Caller,Started (Asia/Kolkata),Talk time (s),Profit');
    expect(row).toMatch(/^\+1305\d{7},\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},120,\d+\.\d{2}$/);
    expect(csv.headers['content-disposition']).toMatch(/cdr-\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.csv/);
    await api(s.t).get('/calls/export.csv?columns=bogus').expect(400);
    await api(s.t).get('/calls/export.csv?tz=Mars/Base').expect(400);
  });

  it('downloads summary reports by day, hour, buyer and state; "All time" starts at the first call', async () => {
    const s = await setup([{ name: 'Alpha' }]);
    await call(s.t, s.number, { from: '+15125550101', talkSec: 120 });
    await call(s.t, s.number, { from: '+14155550102', talkSec: 120 });

    const allTime = `from=2000-01-01T00:00:00.000Z&to=${new Date().toISOString()}`;
    const r = await api(s.t).get(`/reports/summary?${allTime}&groupBy=state`).expect(200);
    expect(r.body.totals.calls).toBe(2);
    expect(r.body.daily.length).toBeLessThan(5); // not one row per day since 2000
    expect(r.body.breakdown.map((b: { name: string }) => b.name).sort()).toEqual(['CA', 'TX']);

    const byBuyer = await api(s.t).get(`/reports/summary.csv?groupBy=buyer&${allTime}`).expect(200);
    const lines = byBuyer.text.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('Buyer,Calls,Converted,Conversion %,Talk time (s),Revenue,Payout,Usage cost,Profit');
    expect(lines[1]).toMatch(/^Alpha,2,2,100\.0,240,80\.00,50\.00,/);
    expect(lines.at(-1)).toMatch(/^Total,2,2,/);

    const byHour = await api(s.t).get('/reports/summary.csv?groupBy=hour').expect(200);
    expect(byHour.text.split('\r\n')).toHaveLength(1 + 24 + 1);
  });

  it('publisher and buyer logins only see their own calls and money', async () => {
    const s = await setup([{ name: 'Alpha' }, { name: 'Beta' }]);
    await call(s.t, s.number, { talkSec: 120 }); // → Alpha
    await call(s.t, s.number, { outcomes: ['no_answer', 'answer'], talkSec: 120 }); // → Beta

    // Invite a publisher login and a buyer login (for Beta).
    const inviteAndLogin = async (body: object, email: string) => {
      await api(s.t).post('/team/invite', { email, name: 'Partner Person', ...body }).expect(201);
      const token = await tokenFromEmail(email, '/accept-invite');
      const res = await portal(app, s.t.sub).post('/auth/accept-invite', { token, password: 'Partner123' }).expect(200);
      return portal(app, s.t.sub, res.body.token);
    };
    const pub = await inviteAndLogin({ role: 'PUBLISHER', publisherId: s.publisherId }, `pub${uid()}@x.test`);
    const buyer = await inviteAndLogin({ role: 'BUYER', buyerId: s.buyerIds[1] }, `buy${uid()}@x.test`);

    const pubCalls = await pub.get('/calls').expect(200);
    expect(pubCalls.body.total).toBe(2);
    expect(pubCalls.body.items[0].payout).toBeDefined();
    expect(pubCalls.body.items[0].revenue).toBeUndefined();
    expect(pubCalls.body.items[0].buyer).toBeNull();

    const buyerCalls = await buyer.get('/calls').expect(200);
    expect(buyerCalls.body.total).toBe(1);
    expect(buyerCalls.body.items[0].revenue).toBeDefined();
    expect(buyerCalls.body.items[0].payout).toBeUndefined();

    await pub.get('/reports/summary?groupBy=buyer').expect(403);
    await pub.get('/reports/summary?groupBy=target').expect(403);
    await buyer.get('/reports/summary?groupBy=publisher').expect(403);
    const report = await buyer.get('/reports/summary').expect(200);
    expect(report.body.totals.payout).toBeUndefined();
    expect(report.body.daily[0].payout).toBeUndefined();

    // Partners can't manage anything.
    await pub.get('/campaigns').expect(403);
    await buyer.post('/buyers', { name: 'x', destination: '+12125550000' }).expect(403);
    await pub.get('/team').expect(403);
  });

  it('blocks a caller from the call log', async () => {
    const s = await setup();
    const c = await call(s.t, s.number, { from: '+13055550777' });
    await api(s.t).post(`/calls/${c.id}/block-caller`).expect(200);
    const again = await call(s.t, s.number, { from: '+13055550777' });
    expect(again.rejectReason).toBe('blocked_caller');
  });
});
