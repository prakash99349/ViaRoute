import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import request from 'supertest';
import { prisma } from '@viaroute/db';
import { ProvidersService } from '../src/telephony/providers.service';
import { createApp, portal, resetDb, signupTenant, tokenFromEmail, uid, verifyEmail } from './helpers';

let app: INestApplication;
const realFetch = global.fetch;
const telnyx: { path: string; body: Record<string, unknown> }[] = [];
const twilio: { url: string; body: string }[] = [];

beforeAll(async () => {
  await resetDb();
  app = await createApp();
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://api.telnyx.com/v2/')) {
      const path = url.replace('https://api.telnyx.com/v2', '');
      telnyx.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      if (path === '/telephony_credentials') return ok({ data: { id: 'cred-1', sip_username: 'gencredAbC123', sip_password: 'sipPass!9' } });
      if (path.endsWith('/token')) return new Response('eyJ.telnyx.jwt', { status: 201, headers: { 'Content-Type': 'text/plain' } });
      return ok({ data: path === '/calls' ? { call_control_id: 'tx-agent-out' } : { result: 'ok' } });
    }
    if (url.startsWith('https://api.twilio.com/')) {
      twilio.push({ url, body: String(init?.body ?? '') });
      return ok(url.endsWith('/Calls.json') ? { sid: 'CA-agent-out' } : {});
    }
    return realFetch(input, init);
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await prisma.$disconnect();
});

type Session = Awaited<ReturnType<typeof signupTenant>>;
const api = (t: Session) => portal(app, t.sub, t.token);

/** Owner + an invited agent login, a campaign with the agent first and a backup buyer, and a test number. */
async function setup() {
  const t = await signupTenant(app);
  await verifyEmail(app, t);
  await prisma.tenant.update({ where: { subdomain: t.sub }, data: { walletBalance: 100 } });
  const email = `agent-${uid()}@x.test`;
  await api(t).post('/team/invite', { email, name: 'Ana Agent', role: 'AGENT' }).expect(201);
  const token = await tokenFromEmail(email, '/accept-invite');
  const login = await portal(app, t.sub).post('/auth/accept-invite', { token, password: 'AgentPass123' }).expect(200);
  const agentApi = portal(app, t.sub, login.body.token);

  const users = await api(t).get('/team').expect(200);
  const agentUser = users.body.members.find((u: { email: string }) => u.email === email);
  const agent = await api(t).post('/agents', { userId: agentUser.id, ringTimeoutSec: 5 }).expect(201);

  const camp = await api(t).post('/campaigns', { name: 'Agents first', revenue: 10, recordCalls: false }).expect(201);
  await api(t).post(`/campaigns/${camp.body.id}/routes`, { targetId: agent.body.targetId, priority: 1 }).expect(201);
  const buyer = await api(t).post('/buyers', { name: 'Backup buyer', destination: '+12125550188' }).expect(201);
  await api(t).post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyer.body.id, priority: 2 }).expect(201);
  const found = await api(t).get('/numbers/available?type=LOCAL&areaCode=415').expect(200);
  const num = await api(t).post('/numbers', { e164: found.body[0].e164 }).expect(201);
  await api(t).patch(`/numbers/${num.body.id}`, { campaignId: camp.body.id }).expect(200);
  return { t, agentApi, agent: agent.body as { id: string; targetId: string }, number: num.body.e164 as string, campaignId: camp.body.id as string };
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const place = (t: Session, to: string) => api(t).post('/simulator/calls', { to, from: '+13055550177', talkSec: 30, stepMs: 5 }).expect(201).then((r) => r.body.callId as string);
const callOf = (t: Session, id: string) => api(t).get(`/calls/${id}`).expect(200).then((r) => r.body);

describe('Agent logins', () => {
  it('only reach their softphone and their own calls', async () => {
    const s = await setup();
    await s.agentApi.get('/campaigns').expect(403);
    await s.agentApi.get('/reports/summary').expect(403);
    await s.agentApi.get('/team').expect(403);
    await s.agentApi.get('/buyers').expect(403);
    await s.agentApi.get('/tenant').expect(200);
    const me = await s.agentApi.get('/agent/me').expect(200);
    expect(me.body).toMatchObject({ agent: { targetId: s.agent.targetId, name: 'Ana Agent' }, available: false, legs: [] });
    const phone = await s.agentApi.get('/agent/me/softphone').expect(200);
    expect(phone.body).toMatchObject({ mode: 'simulator' });
    await s.agentApi.post('/agents', { userId: me.body.agent.id }).expect(403); // can't manage agents
  });
});

describe('Agents on the test carrier', () => {
  it('skip agents who are away; ring, answer and hang up when available', async () => {
    const s = await setup();
    // Away → the backup buyer takes it.
    const away = await place(s.t, s.number);
    const c1 = await waitFor(async () => { const c = await callOf(s.t, away); return c.endedAt && c; });
    expect(c1).toMatchObject({ status: 'COMPLETED', buyer: { name: 'Backup buyer' } });

    await s.agentApi.put('/agent/me/status', { available: true }).expect(200);
    const callId = await place(s.t, s.number);
    const ringing = await waitFor(async () => (await s.agentApi.get('/agent/me').expect(200)).body.legs[0]);
    expect(ringing).toMatchObject({ callId, caller: '+13055550177', campaign: 'Agents first', state: 'ringing', simulated: true });

    await s.agentApi.post(`/agent/me/legs/${ringing.legId}`, { action: 'answer' }).expect(200);
    await waitFor(async () => (await callOf(s.t, callId)).status === 'IN_PROGRESS');
    const active = (await s.agentApi.get('/agent/me').expect(200)).body.legs[0];
    expect(active.state).toBe('active');

    // The agent sees this call in their log, but no money.
    const mine = await s.agentApi.get('/calls').expect(200);
    expect(mine.body.items.map((c: { id: string }) => c.id)).toEqual([callId]);
    expect(mine.body.items[0].revenue).toBeUndefined();

    await s.agentApi.post(`/agent/me/legs/${ringing.legId}`, { action: 'hangup' }).expect(200);
    const done = await waitFor(async () => { const c = await callOf(s.t, callId); return c.endedAt && c; });
    expect(done).toMatchObject({ status: 'COMPLETED', target: { name: 'Ana Agent' }, buyer: null });
    expect((await s.agentApi.get('/agent/me').expect(200)).body.legs).toEqual([]);

    const list = await api(s.t).get('/agents').expect(200);
    expect(list.body[0]).toMatchObject({ available: true, callsToday: 1, user: { name: 'Ana Agent', role: 'AGENT' } });
  });

  it('declined or unanswered calls go to the next buyer', async () => {
    const s = await setup();
    await s.agentApi.put('/agent/me/status', { available: true }).expect(200);
    const declined = await place(s.t, s.number);
    const leg = await waitFor(async () => (await s.agentApi.get('/agent/me').expect(200)).body.legs[0]);
    await s.agentApi.post(`/agent/me/legs/${leg.legId}`, { action: 'decline' }).expect(200);
    const c = await waitFor(async () => { const x = await callOf(s.t, declined); return x.endedAt && x; });
    expect(c).toMatchObject({ status: 'COMPLETED', buyer: { name: 'Backup buyer' }, attempts: 2 });

    // Ring time (5 s) runs out.
    const ignored = await place(s.t, s.number);
    await waitFor(async () => (await s.agentApi.get('/agent/me').expect(200)).body.legs[0]);
    const timedOut = await waitFor(async () => { const x = await callOf(s.t, ignored); return x.endedAt && x; }, 15_000);
    expect(timedOut).toMatchObject({ buyer: { name: 'Backup buyer' }, attempts: 2 });
  }, 30_000);
});

describe('Agents on real carriers', () => {
  it('Twilio: softphone token for the Voice SDK, and calls ring client:<agent>', async () => {
    const s = await setup();
    const carrier = await prisma.provider.create({
      data: { name: 'Twilio agents', type: 'TWILIO', ...ProvidersService.seal({ accountSid: 'ACagents', authToken: 'tok', apiKeySid: 'SKkey1', apiKeySecret: 'secret_1', webhookToken: 'tw_agents_token_1234567890' }) },
    });
    const tenant = await prisma.tenant.update({ where: { subdomain: s.t.sub }, data: { providerId: carrier.id } });
    const phone = await s.agentApi.get('/agent/me/softphone').expect(200);
    expect(phone.body.mode).toBe('twilio');
    const [h, p, sig] = (phone.body.token as string).split('.');
    expect(createHmac('sha256', 'secret_1').update(`${h}.${p}`).digest('base64url')).toBe(sig);
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload).toMatchObject({ iss: 'SKkey1', sub: 'ACagents', grants: { identity: phone.body.identity, voice: { incoming: { allow: true } } } });

    // A call on a Twilio number rings the agent's browser.
    await prisma.phoneNumber.create({ data: { tenantId: tenant.id, e164: '+14155550171', status: 'ACTIVE', provider: 'twilio', providerId: carrier.id, campaignId: s.campaignId } });
    await s.agentApi.put('/agent/me/status', { available: true }).expect(200);
    const base = `/webhooks/voice/${carrier.id}/tw_agents_token_1234567890`;
    twilio.length = 0;
    await request(app.getHttpServer()).post(`${base}/answer`).type('form').send({ CallSid: 'CA-agent-in', From: '+15125550100', To: '+14155550171' }).expect(200);
    expect(new URLSearchParams(twilio[0].body).get('To')).toBe(`client:${phone.body.identity}`);
  });

  it('Telnyx: SIP login made once on the credential connection; calls ring sip:<login>@sip.telnyx.com', async () => {
    const s = await setup();
    const carrier = await prisma.provider.create({
      data: { name: 'Telnyx agents', type: 'TELNYX', ...ProvidersService.seal({ apiKey: 'KEYagents', publicKey: process.env.TELNYX_PUBLIC_KEY ?? '', connectionId: 'cc-1', sipConnectionId: 'sipconn-9' }) },
    });
    const tenant = await prisma.tenant.update({ where: { subdomain: s.t.sub }, data: { providerId: carrier.id } });
    telnyx.length = 0;
    const phone = await s.agentApi.get('/agent/me/softphone').expect(200);
    expect(phone.body).toEqual({ mode: 'telnyx', token: 'eyJ.telnyx.jwt', carrier: 'Telnyx agents' });
    expect(telnyx[0]).toMatchObject({ path: '/telephony_credentials', body: { connection_id: 'sipconn-9' } });
    await s.agentApi.get('/agent/me/softphone').expect(200);
    expect(telnyx.filter((c) => c.path === '/telephony_credentials')).toHaveLength(1); // made once

    const sip = await api(s.t).post(`/agents/${s.agent.id}/sip`).expect(200);
    expect(sip.body).toEqual({ username: 'gencredAbC123', password: 'sipPass!9', domain: 'sip.telnyx.com' });

    await prisma.phoneNumber.create({ data: { tenantId: tenant.id, e164: '+14155550172', status: 'ACTIVE', provider: 'telnyx', providerId: carrier.id, campaignId: s.campaignId } });
    await s.agentApi.put('/agent/me/status', { available: true }).expect(200);
    telnyx.length = 0;
    // Unsigned events are fine here: this test carrier has no webhook key check in test mode.
    const { sign } = await import('crypto');
    const { privateKey } = await import('./telnyx-keys');
    const raw = JSON.stringify({ data: { event_type: 'call.initiated', occurred_at: new Date().toISOString(), payload: { call_control_id: 'tx-agent-in', direction: 'incoming', from: '+15125550100', to: '+14155550172' } } });
    const ts = String(Math.floor(Date.now() / 1000));
    await request(app.getHttpServer())
      .post(`/webhooks/telnyx/${carrier.id}`)
      .set('Content-Type', 'application/json')
      .set('telnyx-timestamp', ts)
      .set('telnyx-signature-ed25519', sign(null, Buffer.from(`${ts}|${raw}`), privateKey).toString('base64'))
      .send(raw)
      .expect(200);
    expect(telnyx.find((c) => c.path === '/calls')!.body).toMatchObject({ to: 'sip:gencredAbC123@sip.telnyx.com' });
  });
});
