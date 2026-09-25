import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { prisma, type Campaign } from '@viaroute/db';
import { REDIS } from '../common/redis.module';
import { SettingsService } from '../common/settings.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Reject reasons from spam protection (plus the customer's own blocklist). */
export const SPAM_REASONS = ['blocked_caller', 'spam_global_block', 'spam_anonymous', 'spam_prefix', 'spam_rate_limit', 'spam_attestation', 'spam_reputation'] as const;

export const IPQS_KEY = 'spam.ipqs_api_key';
const REPUTATION_TTL = 7 * 86400;
const LOOKUP_TIMEOUT_MS = 1500;
const HIDDEN = new Set(['anonymous', 'restricted', 'private', 'unknown', 'unavailable', 'blocked', '0', '']);
const ATTESTATION_RANK: Record<string, number> = { A: 1, B: 2, C: 3 };

export interface Reputation {
  score: number | null;
  lineType: string | null;
}

type SpamPolicy = Pick<Campaign, 'id' | 'blockAnonymous' | 'callerRateLimit' | 'callerRateWindowMin' | 'blockedPrefixes' | 'minAttestation' | 'maxSpamScore' | 'autoBlockShortCalls' | 'shortCallSec'>;

/** "+1 (415) 555-0100" / "14155550100" → "+14155550100"; returns null when it can't be a real number. */
export function normalizeCaller(from: string | undefined | null): string | null {
  const raw = (from ?? '').trim().toLowerCase();
  if (HIDDEN.has(raw) || raw.startsWith('sip:')) return null;
  let digits = raw.replace(/[^\d]/g, '');
  // "(305) 555-0100": a 10-digit North American number without the country code.
  if (digits.length === 10 && !raw.startsWith('+') && /^[2-9]/.test(digits)) digits = `1${digits}`;
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) return null;
  // North American numbers: area code and exchange can't start with 0 or 1.
  if (digits.length === 11 && digits.startsWith('1') && (/^1[01]/.test(digits) || /^1\d{3}[01]/.test(digits))) return null;
  return `+${digits}`;
}

export const normalizePrefix = (p: string) => `+${p.replace(/[^\d]/g, '')}`;

/**
 * Spam protection: decides whether an inbound call is rejected before any buyer is dialed.
 * Order: platform blocklist → hidden/invalid caller ID → blocked prefixes → calls per caller →
 * STIR/SHAKEN attestation → spam-score lookup. Lookups fail open: an outage never blocks real callers.
 */
@Injectable()
export class SpamService {
  private readonly log = new Logger(SpamService.name);
  private global: { at: number; exact: Set<string>; prefixes: string[] } | null = null;

  constructor(
    @Inject(REDIS) private redis: Redis,
    private settings: SettingsService,
    private notifications: NotificationsService,
  ) {}

  async screen(opts: { tenantId: string; campaign: SpamPolicy; callId: string; from: string; attestation?: string | null; at: Date }): Promise<{ reason: string | null } & Partial<Reputation>> {
    const { campaign: c } = opts;
    const caller = normalizeCaller(opts.from);

    if (caller && (await this.isGloballyBlocked(caller))) return { reason: 'spam_global_block' };
    if (!caller) return { reason: c.blockAnonymous ? 'spam_anonymous' : null };
    if (c.blockedPrefixes.some((p) => caller.startsWith(normalizePrefix(p)))) return { reason: 'spam_prefix' };

    if (c.callerRateLimit) {
      const since = new Date(opts.at.getTime() - c.callerRateWindowMin * 60_000);
      const recent = await prisma.call.count({
        where: { tenantId: opts.tenantId, campaignId: c.id, callerNumber: opts.from, id: { not: opts.callId }, startedAt: { gte: since } },
      });
      if (recent >= c.callerRateLimit) return { reason: 'spam_rate_limit' };
    }

    if (c.minAttestation) {
      const got = ATTESTATION_RANK[(opts.attestation ?? '').toUpperCase()] ?? 99; // unknown = not trusted
      if (got > (ATTESTATION_RANK[c.minAttestation] ?? 1)) return { reason: 'spam_attestation' };
    }

    if (c.maxSpamScore !== null) {
      const rep = await this.lookup(caller);
      if (rep) {
        if (rep.score !== null && rep.score >= c.maxSpamScore) return { reason: 'spam_reputation', ...rep };
        return { reason: null, ...rep };
      }
    }
    return { reason: null };
  }

  /** After a call: block callers who keep making very short calls (robo-dialers, pranks). */
  async afterCall(call: { tenantId: string; campaign: SpamPolicy | null; callerNumber: string; durationSec: number; converted: boolean }) {
    const c = call.campaign;
    if (!c?.autoBlockShortCalls || call.converted || call.durationSec >= c.shortCallSec) return;
    const caller = normalizeCaller(call.callerNumber);
    if (!caller) return;
    const short = await prisma.call.count({
      where: {
        tenantId: call.tenantId,
        campaignId: c.id,
        callerNumber: call.callerNumber,
        startedAt: { gte: new Date(Date.now() - 86400_000) },
        durationSec: { lt: c.shortCallSec },
        rejectReason: null,
      },
    });
    if (short < c.autoBlockShortCalls) return;
    const existing = await prisma.blockedNumber.findUnique({ where: { tenantId_e164: { tenantId: call.tenantId, e164: call.callerNumber } } });
    if (existing) return;
    await prisma.blockedNumber.create({
      data: { tenantId: call.tenantId, e164: call.callerNumber, auto: true, reason: `Auto-blocked: ${short} calls under ${c.shortCallSec}s in 24 hours` },
    });
    await this.notifications.notify(call.tenantId, {
      type: 'spam_blocked',
      title: `${call.callerNumber} was blocked automatically`,
      body: `${short} calls shorter than ${c.shortCallSec} seconds in 24 hours. Unblock it under Spam & blocking if this was a real caller.`,
      link: '/spam',
    });
  }

  // --- Platform blocklist ---------------------------------------------------------

  async isGloballyBlocked(caller: string) {
    if (!this.global || Date.now() - this.global.at > 30_000) {
      const rows = await prisma.globalBlock.findMany({ select: { pattern: true } });
      this.global = {
        at: Date.now(),
        exact: new Set(rows.filter((r) => !r.pattern.endsWith('*')).map((r) => r.pattern)),
        prefixes: rows.filter((r) => r.pattern.endsWith('*')).map((r) => r.pattern.slice(0, -1)),
      };
    }
    return this.global.exact.has(caller) || this.global.prefixes.some((p) => caller.startsWith(p));
  }

  invalidateGlobal() {
    this.global = null;
  }

  // --- Reputation (IPQualityScore) ------------------------------------------------------

  /** Spam score and line type for a number; cached for a week. null when not configured or unavailable. */
  async lookup(caller: string, fresh = false): Promise<Reputation | null> {
    const key = (await this.settings.getSecret(IPQS_KEY)) ?? process.env.IPQS_API_KEY ?? null;
    if (!key) return null;
    const cacheKey = `spam:rep:${caller}`;
    if (!fresh) {
      const hit = await this.redis.get(cacheKey);
      if (hit) return JSON.parse(hit) as Reputation;
    }
    try {
      const res = await fetch(
        `https://www.ipqualityscore.com/api/json/phone/${encodeURIComponent(key)}/${caller.slice(1)}?strictness=1`,
        { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
      );
      const j = (await res.json()) as { success?: boolean; message?: string; fraud_score?: number; line_type?: string; VOIP?: boolean; spammer?: boolean };
      if (!j.success) throw new Error(j.message ?? `HTTP ${res.status}`);
      const rep: Reputation = {
        // A known spammer is at least 90 whatever the fraud score says.
        score: Math.max(Number(j.fraud_score ?? 0), j.spammer ? 90 : 0),
        lineType: j.VOIP ? 'voip' : j.line_type ? j.line_type.toLowerCase().replace(/\s+/g, '_') : null,
      };
      await this.redis.set(cacheKey, JSON.stringify(rep), 'EX', REPUTATION_TTL);
      return rep;
    } catch (e) {
      this.log.warn(`Spam lookup for ${caller} failed (call allowed): ${(e as Error).message}`);
      if (fresh) throw e;
      return null;
    }
  }
}
