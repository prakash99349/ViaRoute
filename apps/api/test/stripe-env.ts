// Imported first by stripe.e2e-spec.ts: turns on Stripe mode before config loads.
export const WEBHOOK_SECRET = 'whsec_test_viaroute';
process.env.STRIPE_SECRET_KEY = 'sk_test_viaroute_dummy';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
