#!/usr/bin/env node
/**
 * Load test: N simultaneous simulated calls through the real API (test mode).
 *
 *   node tools/load-test.mjs [calls=100]
 *
 * Needs the dev stack running (pnpm infra:up && pnpm dev) with TELNYX_API_KEY empty.
 * Creates a throwaway customer, so it never touches your demo data.
 * Checks: every call finishes, the concurrency cap is never exceeded, the wallet adds up,
 * and how fast the API accepts each inbound call.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const CALLS = Number(process.argv[2] ?? 100);
const CAP = 10; // concurrency cap on the first buyer

const sub = `load${Date.now().toString(36)}`;
const host = `${sub}.localhost:3000`;
let token = '';

async function call(method, path, body, { tenant = true } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tenant ? { 'X-Tenant-Host': host } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function mailLink(to, path) {
  for (let i = 0; i < 50; i++) {
    const s = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`).then((r) => r.json());
    for (const m of s.messages ?? []) {
      const msg = await fetch(`${MAILPIT}/api/v1/message/${m.ID}`).then((r) => r.json());
      const hit = msg.Text.match(new RegExp(`${path}#t=([A-Za-z0-9_-]+)`));
      if (hit) return hit[1];
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('verification email not found');
}

const pct = (arr, p) => arr.sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];

console.log(`\n📞 ViaRoute load test — ${CALLS} simultaneous calls\n`);

// --- Setup: a fresh customer with money, 2 buyers, a campaign and a number ---
const email = `owner@${sub}.test`;
const signup = await call('POST', '/auth/signup', { companyName: 'Load Test Co', subdomain: sub, name: 'Load Tester', email, password: 'LoadTest123' }, { tenant: false });
token = (await call('POST', '/auth/handoff', { handoffToken: signup.redirect.handoffToken })).token;
await call('POST', '/auth/verify-email', { token: await mailLink(email, '/verify-email') });
await call('POST', '/billing/topup', { amount: 1000 });

const capped = await call('POST', '/buyers', { name: 'Capped buyer', destination: '+12125550001' });
const overflow = await call('POST', '/buyers', { name: 'Overflow buyer', destination: '+12125550002' });
const campaign = await call('POST', '/campaigns', { name: 'Load test', revenue: 30, payout: 10, convertAfterSeconds: 60, duplicateWindowSec: 0, recordCalls: false });
await call('POST', `/campaigns/${campaign.id}/routes`, { buyerId: capped.id, priority: 1, concurrencyCap: CAP });
await call('POST', `/campaigns/${campaign.id}/routes`, { buyerId: overflow.id, priority: 2 });
const offer = (await call('GET', '/numbers/available?type=LOCAL&areaCode=702'))[0];
const number = await call('POST', '/numbers', { e164: offer.e164 });
await call('PATCH', `/numbers/${number.id}`, { campaignId: campaign.id });
console.log(`Setup done: ${sub}, number ${number.e164}, "Capped buyer" allows ${CAP} calls at once`);

// --- Fire all calls at once ---
const started = Date.now();
const latencies = [];
const results = await Promise.allSettled(
  Array.from({ length: CALLS }, async (_, i) => {
    const t0 = performance.now();
    const r = await call('POST', '/simulator/calls', { to: number.e164, from: `+1305${String(5550000 + i).padStart(7, '0')}`, talkSec: 120, stepMs: 400 });
    latencies.push(performance.now() - t0);
    return r.callId;
  }),
);
const ids = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
const failed = results.filter((r) => r.status === 'rejected');
console.log(`Accepted ${ids.length}/${CALLS} calls in ${Date.now() - started} ms` + (failed.length ? ` — ${failed.length} errors, e.g. ${failed[0].reason.message}` : ''));

// --- Watch live calls: the capped buyer must never exceed its cap ---
let peak = 0;
const deadline = Date.now() + 120_000;
let finished = [];
while (Date.now() < deadline) {
  const live = await call('GET', '/calls/live');
  const onCapped = live.filter((c) => c.status === 'IN_PROGRESS' && c.buyer?.id === capped.id).length;
  peak = Math.max(peak, onCapped);
  const page = await call('GET', `/calls?pageSize=200&from=${new Date(started - 3600_000).toISOString()}`);
  finished = page.items.filter((c) => ['COMPLETED', 'NO_ANSWER', 'REJECTED', 'FAILED'].includes(c.status));
  if (finished.length >= ids.length && live.length === 0) break;
  await new Promise((r) => setTimeout(r, 100));
}

// --- Verify ---
const completed = finished.filter((c) => c.status === 'COMPLETED');
const byBuyer = (id) => completed.filter((c) => c.buyer?.id === id).length;
const cost = finished.reduce((s, c) => s + Number(c.cost ?? 0), 0);
const billing = await call('GET', '/billing');
const usage = [];
for (let page = 1; ; page++) {
  const r = await call('GET', `/billing/transactions?type=CALL_USAGE&page=${page}`);
  usage.push(...r.items);
  if (usage.length >= r.total || !r.items.length) break;
}
const charged = usage.reduce((s, t) => s - Number(t.amount), 0);

const checks = [
  ['All calls finished', finished.length === ids.length, `${finished.length}/${ids.length}`],
  ['All calls connected', completed.length === ids.length, `${completed.length} completed`],
  [`Capped buyer never above ${CAP} at once`, peak <= CAP, `peak seen ${peak}`],
  ['Overflow buyer took the rest', byBuyer(capped.id) + byBuyer(overflow.id) === completed.length, `capped ${byBuyer(capped.id)} · overflow ${byBuyer(overflow.id)}`],
  ['Usage charged once per call', usage.length === ids.length && Math.abs(charged - cost) < 0.0001, `${usage.length} charges, $${charged.toFixed(4)}`],
  ['Wallet matches', Math.abs(1000 - Number(billing.walletBalance) - charged) < 0.0001, `$${Number(billing.walletBalance).toFixed(4)} left`],
];

console.log(`\nAPI accept time: p50 ${pct(latencies, 50).toFixed(0)} ms · p95 ${pct(latencies, 95).toFixed(0)} ms · max ${Math.max(...latencies).toFixed(0)} ms`);
console.log('');
for (const [name, ok, detail] of checks) console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`);
const allOk = checks.every((c) => c[1]) && !failed.length;
console.log(allOk ? '\n🎉 Load test passed\n' : '\n⚠️  Load test found problems\n');
process.exit(allOk ? 0 : 1);
