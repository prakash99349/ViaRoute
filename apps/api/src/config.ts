import { config as loadEnv } from 'dotenv';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

loadEnv({ path: resolve(__dirname, '../../../.env'), quiet: true });

const GENERATED: Record<string, () => string> = {
  JWT_SECRET: () => randomBytes(48).toString('hex'),
  ENCRYPTION_KEY: () => randomBytes(32).toString('hex'),
};

/**
 * With SECRETS_DIR set (one-port Docker setup), secrets missing from the environment are generated
 * once and kept in that folder (a Docker volume), so the app starts with no configuration.
 */
function generatedSecret(name: string): string | undefined {
  const dir = process.env.SECRETS_DIR;
  if (!dir || !GENERATED[name]) return undefined;
  const file = join(dir, 'secrets.json');
  const saved: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!saved[name]) {
    saved[name] = GENERATED[name]();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }
  return saved[name];
}

function required(name: string): string {
  const v = process.env[name] || generatedSecret(name);
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  rootDomain: (process.env.ROOT_DOMAIN ?? 'localhost').toLowerCase(),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  /** Public URL of this API (for carrier webhook URLs), e.g. https://api.yourdomain.com */
  apiOrigin: (process.env.API_ORIGIN ?? `http://localhost:${process.env.API_PORT ?? 4000}`).replace(/\/$/, ''),
  smtpUrl: process.env.SMTP_URL ?? 'smtp://localhost:1025',
  mailFrom: process.env.MAIL_FROM ?? 'ViaRoute <no-reply@viaroute.local>',
  encryptionKey: required('ENCRYPTION_KEY'),
  telnyxApiKey: process.env.TELNYX_API_KEY ?? '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  trialDays: Number(process.env.TRIAL_DAYS ?? 14),
  /** Base64 public key for verifying webhooks (Telnyx portal → Keys & Credentials → Public Key). */
  telnyxPublicKey: process.env.TELNYX_PUBLIC_KEY ?? '',
  /** Telnyx Call Control application that new numbers are attached to (Module 5). */
  telnyxConnectionId: process.env.TELNYX_CONNECTION_ID ?? '',
  /** What customers pay per number per month (the carrier's cost must be lower). */
  numberPrice: {
    LOCAL: Number(process.env.NUMBER_PRICE_LOCAL ?? 2),
    TOLL_FREE: Number(process.env.NUMBER_PRICE_TOLL_FREE ?? 3),
  },
  /** Customers point their custom domain here with a CNAME record. */
  customDomainTarget: (process.env.CUSTOM_DOMAIN_TARGET ?? `domains.${process.env.ROOT_DOMAIN ?? 'localhost'}`).toLowerCase(),
};

/** Subdomains customers can never claim. */
export const RESERVED_SUBDOMAINS = new Set([
  'www', 'app', 'api', 'admin', 'staging', 'status', 'mail', 'docs', 'help', 'support', 'billing', 'static', 'cdn',
]);

/** Usage price per minute when neither the plan nor the customer sets one. */
export const DEFAULT_PER_MINUTE = 0.025;

/** Public URL of a portal: the tenant's own domain/subdomain, or the main site. */
export function portalOrigin(
  tenant: { subdomain: string; customDomain?: string | null; customDomainVerifiedAt?: Date | null } | null,
): string {
  const web = new URL(config.webOrigin);
  if (!tenant) return web.origin;
  // Custom domains always use HTTPS (Caddy issues the certificate).
  if (tenant.customDomain && tenant.customDomainVerifiedAt) return `https://${tenant.customDomain}`;
  return `${web.protocol}//${tenant.subdomain}.${web.host}`;
}
