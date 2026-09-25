import { privateKey } from './telnyx-keys';
import type { INestApplication } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'crypto';
import request from 'supertest';
import { prisma } from '@viaroute/db';
import { createApp, portal, resetDb, signupTenant, verifyEmail } from './helpers';

let app: INestApplication;
let admin: ReturnType<typeof portal>;
const realFetch = global.fetch;
/** Telnyx API calls: path, body and which API key was used. */
const calls: { method: string; path: string; key: string; body: Record<string, unknown> }[] = [];
let balanceFails = false;
/** Custom API carrier calls (https://switch.example.com/v1). */
const custom: { method: string; path: string; key: string; body: Record<string, unknown> }[] = [];
let customHasNumbers = true;

beforeAll(async () => {
  await resetDb();
  app = await createApp();
  await prisma.user.create({ data: { email: 'root@viaroute.test', name: 'Root Admin', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash('RootPass123', 4) } });
  const res = await portal(app, null).post('/auth/login', { email: 'root@viaroute.test', password: 'RootPass123' }).expect(200);
  admin = portal(app, null, res.body.token);

  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://switch.example.com/v1/')) {
      const path = url.replace('https://switch.example.com/v1', '');
      const method = init?.method ?? 'GET';
      const key = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
      custom.push({ method, path, key, body: JSON.parse(String(init?.body ?? '{}')) });
      const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (path === '/health') return ok({ ok: true, message: '214 channels free' });
      if (path === '/calls') return ok({ callId: 'sw-out-1' });
      if (path.startsWith('/numbers/available')) return customHasNumbers ? ok({ numbers: [{ e164: '+13125550166', monthlyCost: 0.8, region: 'IL' }] }) : ok({ error: 'not found' }, 404);
      if (path === '/numbers') return ok({ status: 'active', id: 'sw-num-1' });
      return ok({});
    }
    if (!url.startsWith('https://api.telnyx.com/v2/')) return realFetch(input, init);
    const path = url.replace('https://api.telnyx.com/v2', '');
    const method = init?.method ?? 'GET';
    const key = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
    calls.push({ method, path, key, body: JSON.parse(String(init?.body ?? '{}')) });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/balance') return balanceFails ? new Response(JSON.stringify({ errors: [{ detail: 'Authentication failed' }] }), { status: 401 }) : json({ balance: '123.45', currency: 'USD' });
    if (path.startsWith('/available_phone_numbers')) return json([{ phone_number: '+14155550177', cost_information: { monthly_cost: '1.10', upfront_cost: '0', currency: 'USD' }, region_information: [] }]);
    if (path === '/number_orders') return json({ id: 'ord-1', status: 'success', phone_numbers: [] });
    if (path.startsWith('/phone_numbers?')) return json([{ id: 'pn-1', phone_number: '+14155550177' }]);
    if (path === '/calls') return json({ call_control_id: 'out-9' });
    return json({ result: 'ok' });
  });
});
afterAll(async () => {
  jest.restoreAllMocks();
  await app.close();
  await prisma.$disconnect();
});

const PUBLIC_KEY = process.env.TELNYX_PUBLIC_KEY!;
const other = generateKeyPairSync('ed25519');
const otherPublic = other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

function webhook(providerId: string, body: object, key: KeyObject = privateKey) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return request(app.getHttpServer())
    .post(`/webhooks/telnyx/${providerId}`)
    .set('Content-Type', 'application/json')
    .set('telnyx-timestamp', ts)
    .set('telnyx-signature-ed25519', sign(null, Buffer.from(`${ts}|${raw}`), key).toString('base64'))
    .send(raw);
}
const event = (type: string, payload: object, at = new Date()) => ({ data: { event_type: type, occurred_at: at.toISOString(), payload } });

async function addTelnyx(name: string, apiKey: string, extra: Record<string, unknown> = {}) {
  const res = await admin
    .post('/admin/providers', { name, type: 'TELNYX', credentials: { apiKey, publicKey: PUBLIC_KEY, connectionId: `conn-${name}` }, inboundPerMinute: 0.01, outboundPerMinute: 0.02, ...extra })
    .expect(201);
  return res.body as { id: string };
}

describe('Carriers', () => {
  it('starts with a Test carrier created from .env, and never returns secrets', async () => {
    const list = await admin.get('/admin/providers').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'Test carrier', type: 'TEST', isDefault: true, status: 'ACTIVE', webhookUrl: null });

    await admin.post('/admin/providers', { name: 'No key', type: 'TELNYX' }).expect(400);
    const t = await addTelnyx('Main', 'KEY_main_abcd');
    const all = await admin.get('/admin/providers').expect(200);
    const main = all.body.find((p: { id: string }) => p.id === t.id);
    expect(main).toMatchObject({ credentialHint: 'KEY…abcd', hasApiKey: true, hasPublicKey: true, connectionId: 'conn-Main', webhookUrl: `http://localhost:4000/webhooks/telnyx/${t.id}` });
    expect(JSON.stringify(all.body)).not.toContain('KEY_main_abcd');
    expect(main.credentials).toBeUndefined();

    // Customers can't see carriers.
    const c = await signupTenant(app);
    await portal(app, c.sub, c.token).get('/admin/providers').expect(403);
  });

  it('tests the connection and records errors', async () => {
    const t = await addTelnyx('Tested', 'KEY_tested_1111');
    const ok = await admin.post(`/admin/providers/${t.id}/test`).expect(200);
    expect(ok.body).toEqual({ ok: true, message: 'Connected · balance USD 123.45' });
    expect(calls.at(-1)).toMatchObject({ path: '/balance', key: 'KEY_tested_1111' });

    balanceFails = true;
    const bad = await admin.post(`/admin/providers/${t.id}/test`).expect(200);
    balanceFails = false;
    expect(bad.body).toEqual({ ok: false, message: 'Authentication failed' });
    const row = await prisma.provider.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.lastError).toBe('Connection test: Authentication failed');
  });

  it('changes keys without showing them, and guards the default', async () => {
    const t = await addTelnyx('Rotating', 'KEY_old_0000');
    await admin.patch(`/admin/providers/${t.id}`, { credentials: { apiKey: 'KEY_new_9999', publicKey: '' } }).expect(200);
    await admin.post(`/admin/providers/${t.id}/test`).expect(200);
    expect(calls.at(-1)!.key).toBe('KEY_new_9999');
    const row = (await admin.get('/admin/providers').expect(200)).body.find((p: { id: string }) => p.id === t.id);
    expect(row).toMatchObject({ credentialHint: 'KEY…9999', hasPublicKey: true }); // empty field kept the old public key

    await admin.patch(`/admin/providers/${t.id}`, { type: 'TEST' }).expect(400);
    await admin.patch(`/admin/providers/${t.id}`, { isDefault: true }).expect(200);
    const list = (await admin.get('/admin/providers').expect(200)).body;
    expect(list.filter((p: { isDefault: boolean }) => p.isDefault).map((p: { id: string }) => p.id)).toEqual([t.id]);
    await admin.patch(`/admin/providers/${t.id}`, { status: 'DISABLED' }).expect(400);
    await admin.delete(`/admin/providers/${t.id}`).expect(400);

    // Hand the default back to the Test carrier for the other tests.
    const test = list.find((p: { type: string }) => p.type === 'TEST');
    await admin.patch(`/admin/providers/${test.id}`, { isDefault: true }).expect(200);
  });
});

describe('Numbers and calls on a carrier account', () => {
  it("buys a customer's numbers on their own carrier, routes its calls with that account, and records carrier cost", async () => {
    const carrier = await addTelnyx('Dedicated', 'KEY_dedicated_7777');
    const c = await signupTenant(app);
    await verifyEmail(app, c);
    const tenant = await prisma.tenant.update({ where: { subdomain: c.sub }, data: { walletBalance: 100 } });
    await admin.patch(`/admin/tenants/${tenant.id}`, { providerId: carrier.id }).expect(200);

    const api = portal(app, c.sub, c.token);
    expect((await api.get('/numbers/overview').expect(200)).body.testMode).toBe(false);
    calls.length = 0;
    const found = await api.get('/numbers/available?type=LOCAL').expect(200);
    expect(found.body[0].e164).toBe('+14155550177');
    const bought = await api.post('/numbers', { e164: '+14155550177' }).expect(201);
    expect(calls.every((x) => x.key === 'KEY_dedicated_7777')).toBe(true);
    expect(calls.find((x) => x.path === '/number_orders')!.body).toMatchObject({ connection_id: 'conn-Dedicated' });
    const number = await prisma.phoneNumber.findUniqueOrThrow({ where: { id: bought.body.id } });
    expect(number).toMatchObject({ providerId: carrier.id, provider: 'telnyx', providerNumberId: 'pn-1' });
    expect(Number(number.carrierCost)).toBe(1.1);

    // A call to it, through this carrier's webhook URL.
    const camp = await api.post('/campaigns', { name: 'Camp', revenue: 20, convertAfterSeconds: 30 }).expect(201);
    const buyer = await api.post('/buyers', { name: 'Buyer B', destination: '+12125550111' }).expect(201);
    await api.post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyer.body.id }).expect(201);
    await api.patch(`/numbers/${number.id}`, { campaignId: camp.body.id }).expect(200);
    await api.patch(`/campaigns/${camp.body.id}`, { recordCalls: false }).expect(200);

    calls.length = 0;
    const t0 = new Date(Date.now() - 200_000);
    const at = (s: number) => new Date(t0.getTime() + s * 1000);
    await webhook(carrier.id, event('call.initiated', { call_control_id: 'in-9', direction: 'incoming', from: '+15125550100', to: '+14155550177' }, t0), other.privateKey).expect(403);
    await webhook(carrier.id, event('call.initiated', { call_control_id: 'in-9', direction: 'incoming', from: '+15125550100', to: '+14155550177' }, t0)).expect(200);
    expect(calls.map((x) => x.path)).toEqual(['/calls/in-9/actions/answer', '/calls']);
    expect(calls.every((x) => x.key === 'KEY_dedicated_7777')).toBe(true);
    expect(calls[1].body).toMatchObject({ connection_id: 'conn-Dedicated' });

    await webhook(carrier.id, event('call.answered', { call_control_id: 'out-9' }, at(10))).expect(200);
    await webhook(carrier.id, event('call.hangup', { call_control_id: 'in-9', hangup_cause: 'normal_clearing', end_time: at(130).toISOString() }, at(130))).expect(200);

    const call = await prisma.call.findFirstOrThrow({ where: { telnyxCallId: 'in-9' } });
    expect(call).toMatchObject({ providerId: carrier.id, status: 'COMPLETED', durationSec: 130, connectedSec: 120 });
    // 3 inbound minutes × $0.01 + 2 outbound minutes × $0.02
    expect(Number(call.carrierCost)).toBeCloseTo(0.07, 4);
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: carrier.id } })).lastWebhookAt).not.toBeNull();

    const list = (await admin.get('/admin/providers').expect(200)).body.find((p: { id: string }) => p.id === carrier.id);
    expect(list.stats).toMatchObject({ numbers: 1, customers: 1, calls30d: 1, usageCost30d: 0.07 });
    const detail = await admin.get(`/admin/tenants/${tenant.id}`).expect(200);
    expect(detail.body.carrier).toMatchObject({ name: 'Dedicated' });
    expect(detail.body.margin30d.usageCarrierCost).toBeCloseTo(0.07, 4);

    // Releasing uses the same account.
    calls.length = 0;
    await api.delete(`/numbers/${number.id}`).expect(200);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/phone_numbers/pn-1', key: 'KEY_dedicated_7777' });
  });

  it('draining carriers get no new numbers; disabled carriers refuse calls', async () => {
    const carrier = await addTelnyx('Old', 'KEY_old_5555');
    const c = await signupTenant(app);
    const tenant = await prisma.tenant.update({ where: { subdomain: c.sub }, data: { walletBalance: 50, providerId: carrier.id } });
    const api = portal(app, c.sub, c.token);
    expect((await api.get('/numbers/overview').expect(200)).body.testMode).toBe(false);

    await admin.patch(`/admin/providers/${carrier.id}`, { status: 'DRAINING' }).expect(200);
    expect((await api.get('/numbers/overview').expect(200)).body.testMode).toBe(true); // falls back to the default (Test)

    const camp = await prisma.campaign.create({ data: { tenantId: tenant.id, name: 'Old camp' } });
    await prisma.phoneNumber.create({ data: { tenantId: tenant.id, e164: '+14155550188', status: 'ACTIVE', provider: 'telnyx', providerId: carrier.id, campaignId: camp.id } });
    await admin.patch(`/admin/providers/${carrier.id}`, { status: 'DISABLED' }).expect(200);
    calls.length = 0;
    await webhook(carrier.id, event('call.initiated', { call_control_id: 'in-off', direction: 'incoming', from: '+15125550100', to: '+14155550188' })).expect(200);
    const call = await prisma.call.findFirstOrThrow({ where: { telnyxCallId: 'in-off' } });
    expect(call).toMatchObject({ status: 'REJECTED', rejectReason: 'carrier_disabled' });
    expect(calls.map((x) => x.path)).toEqual(['/calls/in-off/actions/reject']);

    await admin.delete(`/admin/providers/${carrier.id}`).expect(400); // still has a live number
  });

  it('records carrier cost for simulated calls and shows platform margin', async () => {
    const c = await signupTenant(app);
    await verifyEmail(app, c);
    const tenant = await prisma.tenant.update({ where: { subdomain: c.sub }, data: { walletBalance: 50 } });
    const api = portal(app, c.sub, c.token);
    const found = await api.get('/numbers/available?type=LOCAL&areaCode=415').expect(200);
    const num = await api.post('/numbers', { e164: found.body[0].e164 }).expect(201);
    const camp = await api.post('/campaigns', { name: 'Sim', revenue: 10 }).expect(201);
    const buyer = await api.post('/buyers', { name: 'Sim buyer', destination: '+12125550112' }).expect(201);
    await api.post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyer.body.id }).expect(201);
    await api.patch(`/numbers/${num.body.id}`, { campaignId: camp.body.id }).expect(200);

    const res = await api.post('/simulator/calls', { to: num.body.e164, from: '+13055550123', talkSec: 60, stepMs: 5 }).expect(201);
    let call;
    for (let i = 0; i < 200 && !call?.endedAt; i++) {
      await new Promise((r) => setTimeout(r, 25));
      call = await prisma.call.findUnique({ where: { id: res.body.callId } });
    }
    expect(call!.providerId).not.toBeNull();
    expect(Number(call!.carrierCost)).toBeGreaterThan(0); // Test carrier's example rates

    const stats = await admin.get('/admin/stats').expect(200);
    expect(Number(stats.body.carrierCostThisMonth)).toBeGreaterThan(0);
    expect(stats.body.daily.at(-1).carrierCost).toBeGreaterThan(0);
    expect(tenant.id).toBeTruthy();
  });
});

function carrierEvent(providerId: string, secret: string, body: object, opts: { ts?: number } = {}) {
  const raw = JSON.stringify(body);
  const t = opts.ts ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return request(app.getHttpServer())
    .post(`/webhooks/carrier/${providerId}`)
    .set('Content-Type', 'application/json')
    .set('X-ViaRoute-Signature', `t=${t},v1=${v1}`)
    .send(raw);
}

describe('Custom API carrier', () => {
  it('needs a base URL, shows the webhook secret once, and tests /health', async () => {
    await admin.post('/admin/providers', { name: 'Switch', type: 'CUSTOM', credentials: { apiKey: 'sw_key_1' } }).expect(400);
    const created = await admin
      .post('/admin/providers', { name: 'My switch', type: 'CUSTOM', credentials: { apiKey: 'sw_key_1', baseUrl: 'https://switch.example.com/v1', numbersApi: true } })
      .expect(201);
    expect(created.body.webhookSecret).toMatch(/^whsec_/);
    expect(created.body).toMatchObject({ baseUrl: 'https://switch.example.com/v1', numbersApi: true, hasWebhookSecret: true, webhookUrl: `http://localhost:4000/webhooks/carrier/${created.body.id}` });
    const list = await admin.get('/admin/providers').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(created.body.webhookSecret);

    const test = await admin.post(`/admin/providers/${created.body.id}/test`).expect(200);
    expect(test.body).toEqual({ ok: true, message: 'Connected · 214 channels free' });
    expect(custom.at(-1)).toMatchObject({ method: 'GET', path: '/health', key: 'sw_key_1' });

    const rotated = await admin.post(`/admin/providers/${created.body.id}/rotate-secret`).expect(200);
    expect(rotated.body.webhookSecret).not.toBe(created.body.webhookSecret);
    await carrierEvent(created.body.id, created.body.webhookSecret, { event: 'call.hangup', callId: 'x' }).expect(403); // old secret
    await carrierEvent(created.body.id, rotated.body.webhookSecret, { event: 'call.hangup', callId: 'x' }).expect(200);
  });

  it('buys numbers and runs a whole call through the Custom API', async () => {
    const carrier = await admin
      .post('/admin/providers', {
        name: 'Wholesale',
        type: 'CUSTOM',
        credentials: { apiKey: 'sw_key_2', baseUrl: 'https://switch.example.com/v1/', numbersApi: true },
        inboundPerMinute: 0.004,
        outboundPerMinute: 0.006,
      })
      .expect(201);
    const secret = carrier.body.webhookSecret as string;
    const c = await signupTenant(app);
    await verifyEmail(app, c);
    const tenant = await prisma.tenant.update({ where: { subdomain: c.sub }, data: { walletBalance: 100, providerId: carrier.body.id } });
    const api = portal(app, c.sub, c.token);

    custom.length = 0;
    const found = await api.get('/numbers/available?type=LOCAL&areaCode=312').expect(200);
    expect(custom[0].path).toBe('/numbers/available?country=US&type=local&limit=20&areaCode=312');
    await api.post('/numbers', { e164: found.body[0].e164 }).expect(201);
    expect(custom.at(-1)).toMatchObject({ method: 'POST', path: '/numbers', key: 'sw_key_2', body: { e164: '+13125550166', reference: `tenant:${tenant.id}` } });
    const number = await prisma.phoneNumber.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(number).toMatchObject({ provider: 'custom', providerId: carrier.body.id, status: 'ACTIVE', providerNumberId: 'sw-num-1' });

    const camp = await api.post('/campaigns', { name: 'Custom camp', revenue: 15, convertAfterSeconds: 30 }).expect(201);
    const buyer = await api.post('/buyers', { name: 'Custom buyer', destination: '+12125550144' }).expect(201);
    await api.post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyer.body.id }).expect(201);
    await api.patch(`/numbers/${number.id}`, { campaignId: camp.body.id }).expect(200);

    const t0 = new Date(Date.now() - 200_000);
    const at = (sec: number) => new Date(t0.getTime() + sec * 1000).toISOString();
    custom.length = 0;
    await carrierEvent(carrier.body.id, 'whsec_wrong', { event: 'call.inbound', callId: 'sw-in-1', from: '+15125550100', to: number.e164, at: at(0) }).expect(403);
    await carrierEvent(carrier.body.id, secret, { event: 'call.inbound', callId: 'sw-in-1', from: '+15125550100', to: number.e164, at: at(0) }).expect(200);
    expect(custom.map((x) => `${x.method} ${x.path}`)).toEqual(['POST /calls/sw-in-1/answer', 'POST /calls/sw-in-1/speak']);
    expect(custom[1].body).toMatchObject({ text: expect.stringContaining('recorded') });

    await carrierEvent(carrier.body.id, secret, { event: 'call.speak_ended', callId: 'sw-in-1', at: at(4) }).expect(200);
    expect(custom[2]).toMatchObject({ path: '/calls', key: 'sw_key_2', body: { to: '+12125550144', from: number.e164, timeoutSec: 20, linkTo: 'sw-in-1' } });

    await carrierEvent(carrier.body.id, secret, { event: 'call.answered', callId: 'sw-out-1', at: at(10) }).expect(200);
    expect(custom.slice(3).map((x) => x.path)).toEqual(['/calls/sw-in-1/bridge', '/calls/sw-in-1/record']);
    expect(custom[3].body).toEqual({ otherCallId: 'sw-out-1' });

    await carrierEvent(carrier.body.id, secret, { event: 'call.hangup', callId: 'sw-in-1', cause: 'normal_clearing', at: at(130) }).expect(200);
    expect(custom.at(-1)!.path).toBe('/calls/sw-out-1/hangup');

    const call = await prisma.call.findFirstOrThrow({ where: { telnyxCallId: 'sw-in-1' } });
    expect(call).toMatchObject({ provider: 'custom', providerId: carrier.body.id, status: 'COMPLETED', converted: true, durationSec: 130, connectedSec: 120 });
    expect(Number(call.carrierCost)).toBeCloseTo(3 * 0.004 + 2 * 0.006, 4);

    // Stale events are refused.
    await carrierEvent(carrier.body.id, secret, { event: 'call.hangup', callId: 'sw-out-1' }, { ts: Math.floor(Date.now() / 1000) - 3600 }).expect(403);
  });

  it('without a numbers API, customers cannot buy; the admin adds existing numbers', async () => {
    customHasNumbers = false;
    const carrier = await admin
      .post('/admin/providers', { name: 'Trunk only', type: 'CUSTOM', credentials: { apiKey: 'sw_key_3', baseUrl: 'https://switch.example.com/v1', numbersApi: false }, numberLocalMonthly: 0.5 })
      .expect(201);
    const c = await signupTenant(app);
    await verifyEmail(app, c);
    const tenant = await prisma.tenant.update({ where: { subdomain: c.sub }, data: { providerId: carrier.body.id } });
    const api = portal(app, c.sub, c.token);
    const res = await api.get('/numbers/available?type=LOCAL').expect(502);
    expect(res.body.message).toContain('added by the platform team');

    const added = await admin.post(`/admin/tenants/${tenant.id}/numbers`, { e164: '+13125550199', providerId: carrier.body.id, type: 'LOCAL', monthlyPrice: 3, label: 'Main line' }).expect(201);
    expect(added.body).toMatchObject({ status: 'ACTIVE', provider: 'custom', monthlyPrice: '3', carrierCost: '0.5' });
    await admin.post(`/admin/tenants/${tenant.id}/numbers`, { e164: '+13125550199', providerId: carrier.body.id, type: 'LOCAL', monthlyPrice: 3 }).expect(409);
    const mine = await api.get('/numbers').expect(200);
    expect(mine.body.map((n: { e164: string }) => n.e164)).toEqual(['+13125550199']);

    custom.length = 0;
    await api.delete(`/numbers/${added.body.id}`).expect(200); // no carrier call: nothing to release there
    expect(custom).toHaveLength(0);
    customHasNumbers = true;
  });
});
