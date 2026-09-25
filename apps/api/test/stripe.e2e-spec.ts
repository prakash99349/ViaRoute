import { WEBHOOK_SECRET } from './stripe-env';
import type { INestApplication } from '@nestjs/common';
import Stripe from 'stripe';
import request from 'supertest';
import { prisma } from '@viaroute/db';
import { createApp, resetDb } from './helpers';

let app: INestApplication;
const stripe = new Stripe('sk_test_viaroute_dummy');

beforeAll(async () => {
  await resetDb();
  app = await createApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function send(event: object, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return request(app.getHttpServer()).post('/webhooks/stripe').set('Content-Type', 'application/json').set('stripe-signature', header).send(payload);
}

const paidSession = (tenantId: string, id: string, cents: number) => ({
  id: `evt_${id}`,
  object: 'event',
  type: 'checkout.session.completed',
  data: { object: { id, object: 'checkout.session', payment_status: 'paid', amount_total: cents, metadata: { tenantId, purpose: 'wallet_topup' } } },
});

describe('Stripe webhooks', () => {
  it('credits a paid top-up exactly once', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Pay Co', subdomain: 'payco', walletBalance: 5 } });
    await send(paidSession(tenant.id, 'cs_test_1', 12_550)).expect(200);
    await send(paidSession(tenant.id, 'cs_test_1', 12_550)).expect(200); // Stripe retries
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(Number(t.walletBalance)).toBe(130.5);
    expect(await prisma.transaction.count({ where: { tenantId: tenant.id, stripeRef: 'cs_test_1' } })).toBe(1);
  });

  it('ignores unpaid sessions', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Unpaid Co', subdomain: 'unpaid' } });
    const ev = paidSession(tenant.id, 'cs_test_2', 5000);
    (ev.data.object as { payment_status: string }).payment_status = 'unpaid';
    await send(ev).expect(200);
    expect(Number((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).walletBalance)).toBe(0);
  });

  it('rejects forged webhooks', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Forge Co', subdomain: 'forge' } });
    await send(paidSession(tenant.id, 'cs_test_3', 999_999), 'whsec_wrong').expect(400);
    await request(app.getHttpServer()).post('/webhooks/stripe').send(paidSession(tenant.id, 'cs_test_4', 999_999)).expect(400);
    expect(Number((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).walletBalance)).toBe(0);
  });
});
