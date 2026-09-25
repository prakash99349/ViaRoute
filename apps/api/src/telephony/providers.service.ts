import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { NumberType, prisma, ProviderStatus, ProviderType, type Provider, type Tenant } from '@viaroute/db';
import { decrypt, encrypt } from '../common/crypto';
import { REDIS } from '../common/redis.module';
import { config } from '../config';
import type { CallControl } from '../routing/call-control.types';
import { TelnyxCallControl } from '../routing/telnyx.call-control';
import { CustomCallControl, CustomNumbersProvider } from './custom.carrier';
import { BandwidthDialect, PlivoDialect, TwimlDialect, VonageDialect } from './markup/dialects';
import { MarkupCallControl, MarkupNumbers } from './markup/markup.call-control';
import type { Kv, MarkupDialect, MarkupUrls } from './markup/markup.types';
import { ProviderError } from './telephony.types';
import { MockTelephonyProvider } from './mock.provider';
import { TelnyxProvider } from './telnyx.provider';
import type { TelephonyProvider } from './telephony.types';

/** Carrier account secrets. Stored encrypted; never sent to the browser. */
export interface Credentials {
  apiKey?: string;
  /** Telnyx public key (base64) for checking webhook signatures. */
  publicKey?: string;
  /** Telnyx Call Control application id that numbers and outbound calls use. */
  connectionId?: string;
  /** Custom carriers: API base URL, e.g. https://switch.example.com/viaroute/v1 */
  baseUrl?: string;
  /** Custom carriers: shared secret that signs their webhooks (HMAC-SHA256). */
  webhookSecret?: string;
  /** Custom carriers: implements the optional /numbers endpoints. */
  numbersApi?: boolean;
  /** Markup carriers: secret part of our webhook URLs. */
  webhookToken?: string;
  // Twilio
  accountSid?: string;
  authToken?: string; // Twilio and Plivo
  // SignalWire
  spaceUrl?: string;
  projectId?: string;
  apiToken?: string;
  // Plivo
  authId?: string;
  appId?: string;
  // Bandwidth
  accountId?: string;
  username?: string;
  password?: string;
  applicationId?: string; // Bandwidth and Vonage
  // Vonage
  apiSecret?: string;
  privateKey?: string;
}

/** Carriers driven by markup documents; they share one adapter and webhook controller. */
export const MARKUP_TYPES = new Set<ProviderType>([ProviderType.TWILIO, ProviderType.SIGNALWIRE, ProviderType.PLIVO, ProviderType.BANDWIDTH, ProviderType.VONAGE]);

const CACHE_MS = 15_000;

/** Map a carrier type to the name stored on numbers ("telnyx" | "mock"). */
export const numberProviderName = (p: Provider | null) =>
  p?.type === ProviderType.TEST ? 'mock' : p ? p.type.toLowerCase() : config.telnyxApiKey ? 'telnyx' : 'mock';

/**
 * The platform's carrier accounts, managed in the admin panel.
 * Builds one API client per account from its own credentials. When no carrier exists yet, one is
 * created from the .env settings (Telnyx if TELNYX_API_KEY is set, otherwise the Test carrier).
 */
@Injectable()
export class ProvidersService {
  private readonly log = new Logger(ProvidersService.name);
  private cache: { at: number; rows: Provider[] } | null = null;
  private seeding: Promise<void> | null = null;
  private clients = new Map<string, { version: number; numbers: TelephonyProvider; calls: CallControl | null; dialect?: MarkupDialect }>();

  /** Shared store for markup carriers (Redis, so any API server can answer a carrier's webhook). */
  readonly kv: Kv;

  constructor(@Inject(REDIS) redis: Redis) {
    this.kv = {
      get: (k) => redis.get(`carrier:${k}`),
      set: async (k, v, ttl) => {
        await redis.set(`carrier:${k}`, v, 'EX', ttl);
      },
    };
  }
  private readonly mock = new MockTelephonyProvider();
  private legacy: { numbers: TelephonyProvider; calls: TelnyxCallControl } | null = null;

  // --- Lookup ---------------------------------------------------------------------

  async all(): Promise<Provider[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rows;
    let rows = await prisma.provider.findMany({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    if (!rows.length) {
      await this.seedFromEnv();
      rows = await prisma.provider.findMany({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    }
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  /** Call after any change to carriers. */
  invalidate() {
    this.cache = null;
  }

  async byId(id: string | null | undefined): Promise<Provider | null> {
    if (!id) return null;
    return (await this.all()).find((p) => p.id === id) ?? (await prisma.provider.findUnique({ where: { id } }));
  }

  /** The platform default carrier (always exists; created from .env the first time). */
  async defaultProvider(): Promise<Provider> {
    const rows = await this.all();
    return rows.find((p) => p.isDefault) ?? rows[0];
  }

  /** Where this customer's next number is bought: their own carrier, else the default, else any active one. */
  async forNewNumber(tenant: Pick<Tenant, 'providerId'>): Promise<Provider> {
    const rows = await this.all();
    const active = (p?: Provider | null) => (p && p.status === ProviderStatus.ACTIVE ? p : null);
    const chosen =
      active(rows.find((p) => p.id === tenant.providerId)) ?? active(rows.find((p) => p.isDefault)) ?? rows.find((p) => p.status === ProviderStatus.ACTIVE);
    if (!chosen) throw new Error('No active carrier. Turn one on under Admin → Carriers.');
    return chosen;
  }

  // --- Clients ----------------------------------------------------------------------

  /** Numbers API (search / buy / release) for a carrier; null = legacy numbers from before carriers existed. */
  numbersApi(p: Provider | null): TelephonyProvider {
    if (!p) return this.legacyClients().numbers;
    return this.clientsFor(p).numbers;
  }

  /** Call-control API for a carrier account (Telnyx or Custom); null = legacy (.env) Telnyx account. */
  callControl(p: Provider | null): CallControl {
    if (!p) return this.legacyClients().calls;
    const c = this.clientsFor(p).calls;
    if (!c) throw new Error(`${p.name} is a test carrier; its calls go through the simulator`);
    return c;
  }

  /** The markup dialect of a Twilio / SignalWire / Plivo / Bandwidth / Vonage carrier (null for others). */
  dialect(p: Provider): MarkupDialect | null {
    return MARKUP_TYPES.has(p.type) ? this.clientsFor(p).dialect ?? null : null;
  }

  /** Our webhook addresses for a markup carrier. */
  markupUrls(p: Provider): MarkupUrls {
    const base = `${config.apiOrigin}/webhooks/voice/${p.id}/${this.credentials(p).webhookToken ?? 'missing'}`;
    const q = encodeURIComponent;
    return {
      answer: () => `${base}/answer`,
      status: () => `${base}/status`,
      flow: (callId) => `${base}/flow?call=${q(callId)}`,
      join: (room) => `${base}/join?room=${q(room)}`,
      recording: (callId) => `${base}/recording?call=${q(callId)}`,
      markup: (key) => `${base}/markup?k=${q(key)}`,
    };
  }

  credentials(p: Provider): Credentials {
    if (!p.credentials) return {};
    try {
      return JSON.parse(decrypt(p.credentials)) as Credentials;
    } catch {
      this.log.error(`Could not decrypt credentials for carrier ${p.name}`);
      return {};
    }
  }

  /** Webhook signing key: the carrier's own, or the .env key for the legacy URL. */
  publicKey(p: Provider | null): string {
    return p ? this.credentials(p).publicKey ?? '' : config.telnyxPublicKey;
  }

  /** What a number costs us per month on this carrier when the carrier's quote doesn't say. */
  numberCost(p: Provider | null, type: NumberType): number {
    if (!p) return 0;
    return Number(type === NumberType.TOLL_FREE ? p.numberTollFreeMonthly : p.numberLocalMonthly);
  }

  // --- Health -------------------------------------------------------------------------

  async markWebhook(p: Provider) {
    // At most one write a minute per carrier.
    if (p.lastWebhookAt && Date.now() - p.lastWebhookAt.getTime() < 60_000) return;
    p.lastWebhookAt = new Date();
    await prisma.provider.update({ where: { id: p.id }, data: { lastWebhookAt: p.lastWebhookAt } }).catch(() => {});
  }

  async markError(p: Provider | null, message: string) {
    if (!p) return;
    await prisma.provider.update({ where: { id: p.id }, data: { lastErrorAt: new Date(), lastError: message.slice(0, 500) } }).catch(() => {});
    this.invalidate();
  }

  // --- Secrets --------------------------------------------------------------------------

  static seal(c: Credentials): { credentials: string; credentialHint: string | null } {
    const clean = Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'boolean' || (typeof v === 'string' && v.trim()))) as Credentials;
    const id = clean.apiKey ?? clean.accountSid ?? clean.projectId ?? clean.authId ?? clean.accountId ?? clean.applicationId;
    return { credentials: encrypt(JSON.stringify(clean)), credentialHint: id ? `${id.slice(0, 3)}…${id.slice(-4)}` : null };
  }

  // ---------------------------------------------------------------------------------------

  private clientsFor(p: Provider): { version: number; numbers: TelephonyProvider; calls: CallControl | null; dialect?: MarkupDialect } {
    const version = p.updatedAt.getTime();
    const hit = this.clients.get(p.id);
    if (hit && hit.version === version) return hit;
    const creds = this.credentials(p);
    const made =
      p.type === ProviderType.TEST
        ? { version, numbers: this.mock, calls: null }
        : MARKUP_TYPES.has(p.type)
          ? this.markupClients(p, creds, version)
          : p.type === ProviderType.CUSTOM
          ? (() => {
              const auth = { baseUrl: (creds.baseUrl ?? '').replace(/\/$/, ''), apiKey: creds.apiKey ?? '', numbersApi: !!creds.numbersApi };
              return { version, numbers: new CustomNumbersProvider(auth), calls: new CustomCallControl(auth) };
            })()
          : {
            version,
            numbers: new TelnyxProvider({ apiKey: creds.apiKey ?? '', connectionId: creds.connectionId }),
            calls: new TelnyxCallControl({ apiKey: creds.apiKey ?? '', connectionId: creds.connectionId }),
          };
    this.clients.set(p.id, made);
    return made;
  }

  private markupClients(p: Provider, c: Credentials, version: number) {
    const urls = this.markupUrls(p);
    let dialect: MarkupDialect;
    try {
      dialect =
        p.type === ProviderType.TWILIO ? new TwimlDialect('twilio', { accountSid: c.accountSid ?? '', token: c.authToken ?? '' }, urls)
        : p.type === ProviderType.SIGNALWIRE ? new TwimlDialect('signalwire', { accountSid: c.projectId ?? '', token: c.apiToken ?? '', space: c.spaceUrl }, urls)
        : p.type === ProviderType.PLIVO ? new PlivoDialect({ authId: c.authId ?? '', authToken: c.authToken ?? '', appId: c.appId }, urls, this.kv)
        : p.type === ProviderType.BANDWIDTH
          ? new BandwidthDialect({ accountId: c.accountId ?? '', username: c.username ?? '', password: c.password ?? '', applicationId: c.applicationId ?? '' }, urls, this.kv)
          : new VonageDialect({ applicationId: c.applicationId ?? '', privateKey: c.privateKey ?? '', apiKey: c.apiKey, apiSecret: c.apiSecret }, urls);
    } catch (e) {
      // Missing credentials: every use reports what's missing.
      const fail = () => Promise.reject(e instanceof ProviderError ? e : new ProviderError((e as Error).message));
      const broken = { testConnection: fail, searchNumbers: fail, purchaseNumber: fail, checkOrder: fail, releaseNumber: fail, name: 'custom' as const };
      return { version, numbers: broken, calls: null };
    }
    return { version, numbers: new MarkupNumbers(dialect), calls: new MarkupCallControl(dialect, urls), dialect };
  }

  private legacyClients() {
    this.legacy ??= {
      numbers: config.telnyxApiKey ? new TelnyxProvider({ apiKey: config.telnyxApiKey, connectionId: config.telnyxConnectionId }) : this.mock,
      calls: new TelnyxCallControl({ apiKey: config.telnyxApiKey, connectionId: config.telnyxConnectionId }),
    };
    return this.legacy;
  }

  /** First run: turn the .env settings into a carrier row and attach existing numbers to it. */
  private seedFromEnv() {
    this.seeding ??= (async () => {
      if (await prisma.provider.count()) return;
      const telnyx = !!config.telnyxApiKey;
      const p = await prisma.provider.create({
        data: telnyx
          ? {
              name: 'Telnyx',
              type: ProviderType.TELNYX,
              isDefault: true,
              ...ProvidersService.seal({ apiKey: config.telnyxApiKey, publicKey: config.telnyxPublicKey, connectionId: config.telnyxConnectionId }),
              notes: 'Created from the server .env settings.',
            }
          : {
              name: 'Test carrier',
              type: ProviderType.TEST,
              isDefault: true,
              // Example costs so margin reports have something to show in test mode.
              inboundPerMinute: 0.0035,
              outboundPerMinute: 0.005,
              numberLocalMonthly: 1,
              numberTollFreeMonthly: 1.5,
              notes: 'Simulated numbers and calls for testing. Add a real carrier before going live.',
            },
      });
      await prisma.phoneNumber.updateMany({ where: { providerId: null, provider: telnyx ? 'telnyx' : 'mock' }, data: { providerId: p.id } });
      this.log.log(`Created carrier "${p.name}" from .env settings`);
    })().finally(() => {
      this.seeding = null;
    });
    return this.seeding;
  }
}
