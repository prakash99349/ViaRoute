import { privateKey } from './telnyx-keys';
import type { INestApplication } from '@nestjs/common';
import { sign } from 'crypto';
import request from 'supertest';
import { prisma } from '@viaroute/db';
import { ProvidersService } from '../src/telephony/providers.service';
import { createApp, portal, resetDb, signupTenant, verifyEmail } from './helpers';

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
      return ok({ data: path === '/calls' ? { call_control_id: 'tx-out-1' } : { result: 'ok' } });
    }
    if (url.startsWith('https://api.twilio.com/')) {
      twilio.push({ url, body: String(init?.body ?? '') });
      return ok(url.endsWith('/Calls.json') ? { sid: 'CA-out-1' } : {});
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

/** A customer with two buyers (Sales, Support) on one campaign and a test number. */
async function setup(campaign: Record<string, unknown> = {}) {
  const t = await signupTenant(app);
  await verifyEmail(app, t);
  await prisma.tenant.update({ where: { subdomain: t.sub }, data: { walletBalance: 100 } });
  const camp = await api(t).post('/campaigns', { name: 'IVR campaign', revenue: 10, ...campaign }).expect(201);
  const sales = await api(t).post('/buyers', { name: 'Sales team', destination: '+12125550101' }).expect(201);
  const support = await api(t).post('/buyers', { name: 'Support team', destination: '+12125550102' }).expect(201);
  await api(t).post(`/campaigns/${camp.body.id}/routes`, { buyerId: sales.body.id, priority: 1 }).expect(201);
  await api(t).post(`/campaigns/${camp.body.id}/routes`, { buyerId: support.body.id, priority: 2 }).expect(201);
  const found = await api(t).get('/numbers/available?type=LOCAL&areaCode=415').expect(200);
  const num = await api(t).post('/numbers', { e164: found.body[0].e164 }).expect(201);
  await api(t).patch(`/numbers/${num.body.id}`, { campaignId: camp.body.id }).expect(200);
  return { t, campaignId: camp.body.id as string, number: num.body.e164 as string, sales: sales.body.id as string, support: support.body.id as string };
}

const menu = (sales: string, support: string) => ({
  enabled: true,
  start: 'main',
  nodes: [
    {
      id: 'main',
      type: 'menu',
      name: 'Main menu',
      prompt: 'For sales press 1. For support press 2. For a quote press 3.',
      options: [
        { digit: '1', label: 'Sales', action: { type: 'route', buyerIds: [sales] } },
        { digit: '2', label: 'Support', action: { type: 'route', buyerIds: [support] } },
        { digit: '3', label: 'Quote', action: { type: 'goto', node: 'zip' } },
      ],
      retries: 1,
      invalidPrompt: "Sorry, I didn't get that.",
      fallback: { type: 'hangup', message: 'Goodbye.' },
    },
    { id: 'zip', type: 'collect', name: 'ZIP', prompt: 'Enter your 5 digit ZIP code.', variable: 'zip', minDigits: 5, maxDigits: 5, retries: 1, next: { type: 'goto', node: 'thanks' }, fallback: { type: 'route' } },
    { id: 'thanks', type: 'say', name: 'Thanks', text: 'Thanks, connecting you now.', next: { type: 'route' } },
  ],
});

async function call(t: Session, to: string, digits: string[], extra: Record<string, unknown> = {}) {
  const res = await api(t).post('/simulator/calls', { to, from: `+1305555${Math.floor(1000 + Math.random() * 8999)}`, talkSec: 40, stepMs: 5, digits, ...extra }).expect(201);
  for (let i = 0; i < 400; i++) {
    const c = await api(t).get(`/calls/${res.body.callId}`).expect(200);
    if (c.body.endedAt) return c.body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('call never finished');
}

describe('IVR setup', () => {
  it('validates the flow, including buyers from other customers', async () => {
    const s = await setup();
    const other = await setup();
    const url = `/campaigns/${s.campaignId}`;
    const bad = (ivr: object) => api(s.t).patch(url, { ivr }).expect(400);
    await bad({ enabled: true, start: 'x', nodes: [] });
    await bad({ ...menu(s.sales, s.support), start: 'nope' });
    await bad({ enabled: true, start: 'm', nodes: [{ id: 'm', type: 'menu', name: 'M', prompt: 'Hi', options: [{ digit: '1', label: 'A', action: { type: 'goto', node: 'missing' } }], fallback: { type: 'hangup' } }] });
    await bad({ enabled: true, start: 'm', nodes: [{ id: 'm', type: 'menu', name: 'M', prompt: 'Hi', options: [{ digit: '1', label: 'A', action: { type: 'hangup' } }, { digit: '1', label: 'B', action: { type: 'hangup' } }], fallback: { type: 'hangup' } }] });
    await bad({ enabled: true, start: 'c', nodes: [{ id: 'c', type: 'collect', name: 'C', prompt: 'Hi', variable: 'Zip Code', minDigits: 5, maxDigits: 5, next: { type: 'route' }, fallback: { type: 'route' } }] });
    const res = await bad(menu(other.sales, s.support)); // someone else's buyer
    expect(res.body.message).toContain('unknown buyer');

    await api(s.t).patch(url, { ivr: menu(s.sales, s.support), whisperText: 'Call about {choice}' }).expect(200);
    const c = await api(s.t).get(url).expect(200);
    expect(c.body.ivr.nodes).toHaveLength(3);
    expect(c.body.whisperText).toBe('Call about {choice}');
    await api(s.t).patch(url, { ivr: null }).expect(200);
    expect((await api(s.t).get(url).expect(200)).body.ivr).toBeNull();
  });
});

describe('IVR calls (simulated)', () => {
  it('routes by the key pressed, only to the chosen buyers', async () => {
    const s = await setup();
    await api(s.t).patch(`/campaigns/${s.campaignId}`, { ivr: menu(s.sales, s.support) }).expect(200);
    const support = await call(s.t, s.number, ['2']);
    expect(support).toMatchObject({ status: 'COMPLETED', buyer: { name: 'Support team' }, ivrPath: 'Main menu: Support' });
    const sales = await call(s.t, s.number, ['1']);
    expect(sales.buyer.name).toBe('Sales team');
  });

  it('collects digits, plays a message, then routes; the data is on the call', async () => {
    const s = await setup();
    await api(s.t).patch(`/campaigns/${s.campaignId}`, { ivr: menu(s.sales, s.support) }).expect(200);
    const c = await call(s.t, s.number, ['3', '33101']);
    expect(c).toMatchObject({ status: 'COMPLETED', ivrPath: 'Main menu: Quote > ZIP: entered', ivrData: { zip: '33101' } });
    const csv = await api(s.t).get('/calls/export.csv?columns=caller,ivr_path,ivr_data').expect(200);
    expect(csv.text).toContain('Main menu: Quote > ZIP: entered,zip=33101');
  });

  it('asks again after a wrong key or silence, then uses the fallback', async () => {
    const s = await setup();
    await api(s.t).patch(`/campaigns/${s.campaignId}`, { ivr: menu(s.sales, s.support) }).expect(200);
    const retried = await call(s.t, s.number, ['9', '1']);
    expect(retried).toMatchObject({ status: 'COMPLETED', buyer: { name: 'Sales team' } });

    const gaveUp = await call(s.t, s.number, ['', '']);
    expect(gaveUp).toMatchObject({ status: 'NO_ANSWER', attempts: 0, buyer: null, ivrPath: 'Main menu: no answer', converted: false });

    // A short ZIP twice → the collect step's fallback (route to everyone).
    const shortZip = await call(s.t, s.number, ['3', '331', '12']);
    expect(shortZip).toMatchObject({ status: 'COMPLETED', ivrPath: 'Main menu: Quote > ZIP: no answer' });
  });

  it('switched off, the IVR is skipped', async () => {
    const s = await setup();
    await api(s.t).patch(`/campaigns/${s.campaignId}`, { ivr: { ...menu(s.sales, s.support), enabled: false } }).expect(200);
    const c = await call(s.t, s.number, []);
    expect(c).toMatchObject({ status: 'COMPLETED', buyer: { name: 'Sales team' }, ivrPath: null });
  });
});

// ---------------------------------------------------------------------------
// Real carrier commands

function telnyxEvent(type: string, payload: object) {
  const raw = JSON.stringify({ data: { event_type: type, occurred_at: new Date().toISOString(), payload } });
  const ts = String(Math.floor(Date.now() / 1000));
  return request(app.getHttpServer())
    .post('/webhooks/telnyx')
    .set('Content-Type', 'application/json')
    .set('telnyx-timestamp', ts)
    .set('telnyx-signature-ed25519', sign(null, Buffer.from(`${ts}|${raw}`), privateKey).toString('base64'))
    .send(raw);
}

async function carrierTenant(e164: string, provider: string, providerId?: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'starter' } });
  const tenant = await prisma.tenant.create({ data: { name: `IVR ${provider}`, subdomain: `ivr${provider}`, status: 'ACTIVE', walletBalance: 20, planId: plan.id } });
  const buyer = await prisma.buyer.create({ data: { tenantId: tenant.id, name: 'Only buyer', destination: '+12125550199' } });
  const campaign = await prisma.campaign.create({
    data: {
      tenantId: tenant.id,
      name: 'Solar',
      recordCalls: false,
      whisperText: 'Solar call, {choice}, ZIP {ivr_zip}',
      ivr: {
        enabled: true,
        start: 'main',
        nodes: [
          { id: 'main', type: 'menu', name: 'Main', prompt: 'Press 1 to continue.', options: [{ digit: '1', label: 'Homeowner', action: { type: 'goto', node: 'zip' } }], fallback: { type: 'hangup' } },
          { id: 'zip', type: 'collect', name: 'ZIP', prompt: 'Enter your ZIP.', variable: 'zip', minDigits: 5, maxDigits: 5, next: { type: 'route' }, fallback: { type: 'route' } },
        ],
      },
    },
  });
  await prisma.route.create({ data: { tenantId: tenant.id, campaignId: campaign.id, buyerId: buyer.id } });
  await prisma.phoneNumber.create({ data: { tenantId: tenant.id, e164, status: 'ACTIVE', provider, providerId, campaignId: campaign.id } });
  return tenant;
}

describe('IVR on carriers', () => {
  it('Telnyx: gather commands, then a whisper to the buyer before bridging', async () => {
    await carrierTenant('+14155550161', 'telnyx');
    telnyx.length = 0;
    await telnyxEvent('call.initiated', { call_control_id: 'tx-in-1', direction: 'incoming', from: '+15125550100', to: '+14155550161' }).expect(200);
    expect(telnyx.map((c) => c.path)).toEqual(['/calls/tx-in-1/actions/answer', '/calls/tx-in-1/actions/gather_using_speak']);
    expect(telnyx[1].body).toMatchObject({ payload: 'Press 1 to continue.', minimum_digits: 1, maximum_digits: 1, terminating_digit: '#' });

    await telnyxEvent('call.gather.ended', { call_control_id: 'tx-in-1', digits: '1', status: 'valid' }).expect(200);
    expect(telnyx[2]).toMatchObject({ path: '/calls/tx-in-1/actions/gather_using_speak', body: { payload: 'Enter your ZIP.', minimum_digits: 5, maximum_digits: 5 } });

    await telnyxEvent('call.gather.ended', { call_control_id: 'tx-in-1', digits: '94107#', status: 'valid' }).expect(200);
    expect(telnyx[3]).toMatchObject({ path: '/calls', body: { to: '+12125550199' } });

    // Buyer answers: they hear the whisper first; the bridge waits for it to finish.
    await telnyxEvent('call.answered', { call_control_id: 'tx-out-1' }).expect(200);
    expect(telnyx[4]).toMatchObject({ path: '/calls/tx-out-1/actions/speak', body: { payload: 'Solar call, Homeowner, ZIP 9 4 1 0 7' } });
    expect(telnyx.some((c) => c.path.endsWith('/bridge'))).toBe(false);
    await telnyxEvent('call.speak.ended', { call_control_id: 'tx-out-1' }).expect(200);
    expect(telnyx.at(-1)).toMatchObject({ path: '/calls/tx-in-1/actions/bridge', body: { call_control_id: 'tx-out-1' } });

    const c = await prisma.call.findFirstOrThrow({ where: { telnyxCallId: 'tx-in-1' } });
    expect(c).toMatchObject({ status: 'IN_PROGRESS', ivrPath: 'Main: Homeowner > ZIP: entered', ivrData: { zip: '94107' } });
  });

  it('Twilio: <Gather> in the answer, keys through the gathered hook, whisper before joining', async () => {
    const carrier = await prisma.provider.create({ data: { name: 'Twilio IVR', type: 'TWILIO', ...ProvidersService.seal({ accountSid: 'ACivr', authToken: 'tok', webhookToken: 'tok_ivr_test_1234567890' }) } });
    await carrierTenant('+14155550162', 'twilio', carrier.id);
    const base = `/webhooks/voice/${carrier.id}/tok_ivr_test_1234567890`;
    const post = (path: string, body: Record<string, string>) => request(app.getHttpServer()).post(`${base}/${path}`).type('form').send(body).expect(200);

    const answer = await post('answer', { CallSid: 'CA-in-1', From: '+15125550100', To: '+14155550162' });
    expect(answer.text).toMatch(/<Gather input="dtmf" numDigits="1" timeout="6" finishOnKey="#" actionOnEmptyResult="true" action="[^"]+\/gathered\?call=CA-in-1" method="POST"><Say [^>]*>Press 1 to continue.<\/Say><\/Gather>/);

    const zip = await post('gathered?call=CA-in-1', { CallSid: 'CA-in-1', Digits: '1' });
    expect(zip.text).toContain('numDigits="5"');

    twilio.length = 0;
    const hold = await post('gathered?call=CA-in-1', { CallSid: 'CA-in-1', Digits: '10001' });
    expect(hold.text).toContain('>vr-CA-in-1</Conference>'); // caller waits while the buyer rings
    expect(twilio[0].url).toMatch(/\/Calls\.json$/);

    const whisper = await post('join?room=vr-CA-in-1', { CallSid: 'CA-out-1' });
    expect(whisper.text).toMatch(/<Say [^>]*>Solar call, Homeowner, ZIP 1 0 0 0 1<\/Say><Redirect method="POST">[^<]+\/flow\?call=CA-out-1<\/Redirect>/);
    const joined = await post('flow?call=CA-out-1', { CallSid: 'CA-out-1' });
    expect(joined.text).toContain('>vr-CA-in-1</Conference>');
    expect((await prisma.call.findFirstOrThrow({ where: { telnyxCallId: 'CA-in-1' } })).status).toBe('IN_PROGRESS');
  });
});
