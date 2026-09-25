import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { CallStatus, NumberStatus, Prisma, prisma, RepeatRouting, TenantStatus, TransactionType } from '@viaroute/db';
import { WalletService } from '../billing/wallet.service';
import { REDIS } from '../common/redis.module';
import { ProvidersService } from '../telephony/providers.service';
import { DEFAULT_PER_MINUTE } from '../config';
import { StorageService } from '../common/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { stateForNumber } from './area-codes';
import { SpamService } from './spam.service';
import { CALL_CONTROLS, type CallControl, type SharedCallControls, type HangupEvent, type InboundEvent, type LegEvent, type ProviderName, type RecordingEvent } from './call-control.types';
import { CapsService, type CapLimits } from './caps.service';
import { fillMacros, PostbackService } from './postback.service';
import { geoAllows, isOpen, orderByPriorityAndWeight, type GeoRules, type Schedule } from './rules';

export const RECORDING_NOTICE = 'This call may be recorded for quality assurance.';
export const NO_AGENT_MESSAGE = 'Sorry, no one is available to take your call right now. Please try again later.';
const STATE_TTL = 12 * 3600;

interface Candidate {
  routeId: string;
  buyerId: string | null;
  targetId: string | null;
  buyerName: string;
  destination: string;
  ringTimeoutSec: number;
  limits: CapLimits;
  /** Caps shared by every campaign: the target's, and the buyer's (main line + all its targets). */
  targetName: string | null;
  targetLimits: CapLimits | null;
  ownerName: string | null;
  buyerLimits: CapLimits | null;
}

const limitsOf = (x: { concurrencyCap: number | null; hourlyCap: number | null; dailyCap: number | null; monthlyCap: number | null }): CapLimits => ({
  concurrencyCap: x.concurrencyCap,
  hourlyCap: x.hourlyCap,
  dailyCap: x.dailyCap,
  monthlyCap: x.monthlyCap,
});

/** Who "had" a call, for repeat callers: the buyer, or the target when it has no buyer. */
const ownerKey = (x: { buyerId: string | null; targetId: string | null }) => (x.buyerId ? `b:${x.buyerId}` : x.targetId ? `t:${x.targetId}` : null);

/**
 * Repeat callers: DIFFERENT tries buyers/targets that haven't had this caller first (the others stay
 * as a last resort); SAME tries the one that had their last call first; NORMAL leaves the order alone.
 * `seen` is newest first.
 */
export function orderForRepeat<T extends { buyerId: string | null; targetId: string | null }>(candidates: T[], seen: string[], mode: RepeatRouting): T[] {
  if (!seen.length || mode === RepeatRouting.NORMAL) return candidates;
  if (mode === RepeatRouting.SAME) {
    const last = seen[0];
    return [...candidates.filter((c) => ownerKey(c) === last), ...candidates.filter((c) => ownerKey(c) !== last)];
  }
  const had = new Set(seen);
  return [...candidates.filter((c) => !had.has(ownerKey(c)!)), ...candidates.filter((c) => had.has(ownerKey(c)!))];
}

/** Live state of one call, kept in Redis while it's in progress. */
interface CallState {
  callId: string;
  tenantId: string;
  provider: ProviderName;
  /** Carrier account the call came in on (null = legacy .env account or simulator without one). */
  providerId?: string | null;
  timeZone: string;
  inboundId: string;
  trackingNumber: string;
  recordCalls: boolean;
  startedAt: string;
  candidates: Candidate[];
  /** Buyers/targets that already talked to this caller in the duplicate window, newest first. */
  seen: string[];
  next: number;
  fallback: string | null;
  usingFallback: boolean;
  outboundId?: string;
  currentRouteId?: string;
  /** Counted against the account's concurrent-call limit (released when the call ends). */
  accountLine?: boolean;
  /** Cap scopes counted for the current dial: route id, "t:<target>", "b:<buyer>". */
  reservedScopes?: string[];
  reservedAt?: string;
  bridged: boolean;
  answeredAt?: string;
  connectedEndedAt?: string;
  /** greeting = playing the recording notice; closing = playing the "no one available" message. */
  phase: 'greeting' | 'dialing' | 'connected' | 'closing' | 'ended';
}

/**
 * The call router. Every carrier event for a call is processed one at a time (per-call lock):
 *
 *   inbound → checks (number, account, wallet, blocklist) → answer → [recording notice]
 *   → dial best buyer (priority, weight, hours, states, caps) → no answer? next buyer → … → fallback
 *   → buyer answers → bridge + record → hangup → duration, conversion, payout, usage charge, postback
 */
@Injectable()
export class CallEngine {
  private readonly log = new Logger(CallEngine.name);

  constructor(
    @Inject(CALL_CONTROLS) private controls: SharedCallControls,
    private providers: ProvidersService,
    private spam: SpamService,
    @Inject(REDIS) private redis: Redis,
    private caps: CapsService,
    private wallet: WalletService,
    private postbacks: PostbackService,
    private notifications: NotificationsService,
    private storage: StorageService,
  ) {}

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /** `viaProviderId`: the carrier account whose webhook URL received the event (if known). */
  async onInbound(provider: ProviderName, ev: InboundEvent, viaProviderId?: string): Promise<string | null> {
    if (await this.redis.get(legKey(ev.callControlId))) return null; // duplicate webhook

    const number = await prisma.phoneNumber.findFirst({
      where: { e164: ev.to, status: NumberStatus.ACTIVE },
      include: {
        tenant: { include: { plan: true } },
        campaign: { include: { routes: { where: { active: true }, include: { buyer: true, target: { include: { buyer: true } } } } } },
      },
    });
    const carrier = await this.providers.byId(number?.providerId ?? viaProviderId);
    const cc = await this.controlFor(provider, carrier);
    if (!number) {
      this.log.warn(`Inbound call to unknown number ${ev.to}, rejecting`);
      await cc.reject(ev.callControlId).catch(() => {});
      return null;
    }

    const { tenant, campaign } = number;
    const call = await prisma.call.create({
      data: {
        tenantId: tenant.id,
        campaignId: campaign?.id,
        phoneNumberId: number.id,
        publisherId: number.publisherId,
        telnyxCallId: ev.callControlId,
        provider,
        providerId: carrier?.id,
        callerNumber: ev.from,
        attestation: ev.attestation?.toUpperCase().slice(0, 1) || null,
        callerState: stateForNumber(ev.from),
        dialedNumber: ev.to,
        startedAt: ev.at,
      },
    });
    await this.redis.set(legKey(ev.callControlId), call.id, 'EX', STATE_TTL);

    // --- Hard rejections (caller hears nothing billable) ---
    const blocked = await prisma.blockedNumber.findUnique({ where: { tenantId_e164: { tenantId: tenant.id, e164: ev.from } } });
    let reason: string | null =
      carrier?.status === 'DISABLED' ? 'carrier_disabled'
      : tenant.status === TenantStatus.SUSPENDED || tenant.status === TenantStatus.CLOSED ? 'account_suspended'
      : tenant.walletBalance.lte(0) ? 'no_balance'
      : !campaign ? 'number_not_assigned'
      : !campaign.active ? 'campaign_paused'
      : blocked ? 'blocked_caller'
      : null;

    // --- Spam protection: platform blocklist, hidden IDs, prefixes, caller rate, STIR/SHAKEN, spam score ---
    if (!reason && campaign) {
      const verdict = await this.spam.screen({ tenantId: tenant.id, campaign, callId: call.id, from: ev.from, attestation: ev.attestation, at: ev.at });
      reason = verdict.reason;
      if (verdict.score !== undefined || verdict.lineType !== undefined) {
        await prisma.call.update({ where: { id: call.id }, data: { spamScore: verdict.score ?? null, lineType: verdict.lineType ?? null } });
      }
    }
    if (reason) {
      await prisma.call.update({ where: { id: call.id }, data: { status: CallStatus.REJECTED, rejectReason: reason, endedAt: ev.at } });
      await cc.reject(ev.callControlId).catch((e) => this.log.warn(`reject failed: ${e.message}`));
      if (reason === 'no_balance') await this.notifications.checkLowBalance(tenant.id);
      return call.id;
    }

    // --- Account-wide concurrent call limit (set by the platform admin) ---
    let accountLine = false;
    if (tenant.maxConcurrentCalls) {
      const none = { hourlyCap: null, dailyCap: null, monthlyCap: null };
      if (await this.caps.reserve(accountScope(tenant.id), { concurrencyCap: tenant.maxConcurrentCalls, ...none }, tenant.timezone, ev.at)) {
        await prisma.call.update({ where: { id: call.id }, data: { status: CallStatus.REJECTED, rejectReason: 'account_limit', endedAt: ev.at } });
        await cc.reject(ev.callControlId).catch((e) => this.log.warn(`reject failed: ${e.message}`));
        return call.id;
      }
      accountLine = true;
    }

    // --- Repeat caller: the publisher isn't paid again; a buyer only pays once per caller ---
    const history =
      campaign!.duplicateWindowSec > 0
        ? await prisma.call.findMany({
            where: {
              tenantId: tenant.id,
              campaignId: campaign!.id,
              callerNumber: ev.from,
              id: { not: call.id },
              startedAt: { gte: new Date(ev.at.getTime() - campaign!.duplicateWindowSec * 1000) },
            },
            select: { buyerId: true, targetId: true, answeredAt: true },
            orderBy: { startedAt: 'desc' },
            take: 100,
          })
        : [];
    const duplicate = history.length > 0;
    const seen = [...new Set(history.filter((h) => h.answeredAt).map(ownerKey).filter((k): k is string => !!k))];
    if (duplicate) await prisma.call.update({ where: { id: call.id }, data: { duplicate: true } });

    // --- Eligible buyers, best first ---
    const callerState = stateForNumber(ev.from);
    const eligible = campaign!.routes.filter((r) => {
      const owner = r.target ? r.target.buyer : r.buyer;
      if (r.target ? !r.target.active : !r.buyer) return false;
      if (owner && !owner.active) return false;
      return isOpen(r.schedule as Schedule | null, ev.at, tenant.timezone) && geoAllows(r.geoRules as GeoRules | null, callerState);
    });
    const ordered: Candidate[] = orderByPriorityAndWeight(eligible).map((r) => {
      const owner = r.target ? r.target.buyer : r.buyer;
      return {
        routeId: r.id,
        buyerId: owner?.id ?? null,
        targetId: r.targetId,
        buyerName: r.target ? (owner ? `${owner.name} · ${r.target.name}` : r.target.name) : r.buyer!.name,
        destination: r.target?.destination ?? r.buyer!.destination,
        ringTimeoutSec: r.target?.ringTimeoutSec ?? r.buyer!.ringTimeoutSec,
        limits: limitsOf(r),
        targetName: r.target?.name ?? null,
        targetLimits: r.target ? limitsOf(r.target) : null,
        ownerName: owner?.name ?? null,
        buyerLimits: owner ? limitsOf(owner) : null,
      };
    });
    const candidates = orderForRepeat(ordered, seen, campaign!.repeatRouting);

    const state: CallState = {
      callId: call.id,
      tenantId: tenant.id,
      provider,
      providerId: carrier?.id ?? null,
      timeZone: tenant.timezone,
      inboundId: ev.callControlId,
      trackingNumber: ev.to,
      recordCalls: campaign!.recordCalls,
      startedAt: ev.at.toISOString(),
      candidates,
      seen,
      accountLine,
      next: 0,
      fallback: campaign!.fallbackNumber,
      usingFallback: false,
      bridged: false,
      phase: 'greeting',
    };

    await this.withLock(call.id, async () => {
      await cc.answer(ev.callControlId);
      if (state.recordCalls) {
        await cc.speak(ev.callControlId, RECORDING_NOTICE); // dial when it finishes
        await this.save(state);
      } else {
        await this.dialNext(state);
      }
    });
    return call.id;
  }

  async onSpeakEnded(ev: LegEvent) {
    await this.withState(ev.callControlId, async (s) => {
      if (s.phase === 'greeting') await this.dialNext(s);
      else if (s.phase === 'closing') await (await this.cc(s)).hangup(s.inboundId);
    });
  }

  async onAnswered(ev: LegEvent) {
    await this.withState(ev.callControlId, async (s) => {
      if (ev.callControlId !== s.outboundId || s.bridged || s.phase === 'ended') return;
      const cc = await this.cc(s);
      await cc.bridge(s.inboundId, s.outboundId);
      s.bridged = true;
      s.answeredAt = ev.at.toISOString();
      s.phase = 'connected';
      await this.save(s);
      if (s.recordCalls) await cc.recordStart(s.inboundId).catch((e) => this.log.warn(`record_start: ${e.message}`));
      await prisma.call.update({ where: { id: s.callId }, data: { status: CallStatus.IN_PROGRESS, answeredAt: ev.at } });
    });
  }

  async onHangup(ev: HangupEvent) {
    await this.withState(ev.callControlId, async (s) => {
      if (s.phase === 'ended') return;
      const cc = await this.cc(s);

      if (ev.callControlId === s.inboundId) {
        // Caller hung up.
        if (s.outboundId) {
          if (!s.bridged) await this.releaseReservation(s);
          await cc.hangup(s.outboundId);
        }
        await this.finalize(s, ev);
        return;
      }

      if (ev.callControlId === s.outboundId) {
        if (s.bridged) {
          // Buyer hung up after talking: end the caller's leg; finalize on its hangup event.
          s.connectedEndedAt = ev.at.toISOString();
          await this.save(s);
          await cc.hangup(s.inboundId);
        } else {
          // Buyer didn't pick up (timeout, busy, rejected): try the next one.
          await this.releaseReservation(s);
          s.outboundId = undefined;
          await this.dialNext(s);
        }
      }
    });
  }

  async onRecordingSaved(ev: RecordingEvent) {
    const callId = await this.redis.get(legKey(ev.callControlId));
    if (!callId) return;
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { tenantId: true } });
    if (!call) return;
    const ext = ev.contentType.includes('wav') ? 'wav' : 'mp3';
    const key = `recordings/${call.tenantId}/${callId}.${ext}`;
    const saved = ev.audio ? await this.storage.put(key, ev.audio) : ev.url ? await this.storage.putFromUrl(key, ev.url, ev.headers) : null;
    if (saved) await prisma.call.update({ where: { id: callId }, data: { recordingUrl: saved } });
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  private async dialNext(s: CallState) {
    const cc = await this.cc(s);
    s.phase = 'dialing';

    while (s.next < s.candidates.length) {
      const c = s.candidates[s.next++];
      const now = new Date();
      // Campaign route caps, then the target's and the buyer's caps shared by every campaign.
      const scopes = [
        { key: c.routeId, limits: c.limits, name: c.buyerName, where: 'on this campaign' },
        ...(c.targetId && c.targetLimits ? [{ key: `t:${c.targetId}`, limits: c.targetLimits, name: c.targetName!, where: 'across all campaigns' }] : []),
        ...(c.buyerId && c.buyerLimits ? [{ key: `b:${c.buyerId}`, limits: c.buyerLimits, name: c.ownerName!, where: 'across all campaigns' }] : []),
      ];
      const taken: string[] = [];
      let blocked = false;
      for (const sc of scopes) {
        const full = await this.caps.reserve(sc.key, sc.limits, s.timeZone, now);
        if (full) {
          if (full !== 'concurrency') await this.notifyCapReached(s, sc.key, sc.name, sc.where, full);
          blocked = true;
          break;
        }
        taken.push(sc.key);
      }
      if (blocked) {
        for (const k of taken) await this.caps.releaseAll(k, s.timeZone, now);
        continue;
      }
      try {
        s.outboundId = await cc.dial({ linkTo: s.inboundId, to: c.destination, from: s.trackingNumber, timeoutSec: c.ringTimeoutSec });
      } catch (e) {
        this.log.warn(`Dial to ${c.buyerName} failed: ${(e as Error).message}`);
        for (const k of taken) await this.caps.releaseAll(k, s.timeZone, now);
        continue;
      }
      s.currentRouteId = c.routeId;
      s.reservedScopes = taken;
      s.reservedAt = now.toISOString();
      await this.redis.set(legKey(s.outboundId), s.callId, 'EX', STATE_TTL);
      await this.save(s);
      await prisma.call.update({
        where: { id: s.callId },
        data: { attempts: { increment: 1 }, buyerId: c.buyerId, targetId: c.targetId, routeId: c.routeId, outboundCallId: s.outboundId },
      });
      return;
    }

    // Every buyer tried: last resort is the campaign's fallback number.
    if (s.fallback && !s.usingFallback) {
      s.usingFallback = true;
      s.currentRouteId = undefined;
      s.reservedScopes = [];
      try {
        s.outboundId = await cc.dial({ linkTo: s.inboundId, to: s.fallback, from: s.trackingNumber, timeoutSec: 30 });
        await this.redis.set(legKey(s.outboundId), s.callId, 'EX', STATE_TTL);
        await this.save(s);
        await prisma.call.update({
          where: { id: s.callId },
          data: { attempts: { increment: 1 }, buyerId: null, targetId: null, routeId: null, outboundCallId: s.outboundId },
        });
        return;
      } catch (e) {
        this.log.warn(`Fallback dial failed: ${(e as Error).message}`);
      }
    }

    // Nobody can take it.
    s.phase = 'closing';
    s.outboundId = undefined;
    await this.save(s);
    await prisma.call.update({ where: { id: s.callId }, data: { rejectReason: 'no_buyer_available' } });
    await cc.speak(s.inboundId, NO_AGENT_MESSAGE);
  }

  private async releaseReservation(s: CallState) {
    if (s.currentRouteId && s.reservedAt && !s.usingFallback) {
      for (const k of scopesOf(s)) await this.caps.releaseAll(k, s.timeZone, new Date(s.reservedAt));
    }
  }

  // ---------------------------------------------------------------------------
  // Finishing a call: duration, conversion, money
  // ---------------------------------------------------------------------------

  private async finalize(s: CallState, ev: HangupEvent) {
    s.phase = 'ended';
    await this.save(s);
    if (s.accountLine) await this.caps.releaseConcurrency(accountScope(s.tenantId));
    if (s.bridged && s.currentRouteId && !s.usingFallback) {
      for (const k of scopesOf(s)) await this.caps.releaseConcurrency(k);
    }

    const call = await prisma.call.findUniqueOrThrow({
      where: { id: s.callId },
      include: { campaign: true, publisher: true, route: true, tenant: { include: { plan: true } }, phoneNumber: true, carrier: true },
    });

    const endAt = ev.at;
    const durationSec = Math.max(0, Math.round((endAt.getTime() - new Date(s.startedAt).getTime()) / 1000));
    const connectedEnd = s.connectedEndedAt ? new Date(s.connectedEndedAt) : endAt;
    const connectedSec = s.bridged && s.answeredAt ? Math.max(0, Math.round((connectedEnd.getTime() - new Date(s.answeredAt).getTime()) / 1000)) : 0;

    // A buyer pays once per caller: a repeat caller is a new sale only for a buyer/target that hasn't had them.
    // The publisher is paid once per caller, whoever takes the repeat call.
    const soldToBuyer = s.bridged && !s.usingFallback;
    const alreadyHad = (s.seen ?? []).includes(ownerKey(call) ?? '');
    const converted = soldToBuyer && !alreadyHad && !!call.campaign && connectedSec >= call.campaign.convertAfterSeconds;
    const revenue = converted ? call.route?.revenueOverride ?? call.campaign!.revenue : new Prisma.Decimal(0);
    const payout = converted && !call.duplicate && call.publisher ? call.publisher.payoutOverride ?? call.campaign!.payout : new Prisma.Decimal(0);

    // Usage: caller leg + buyer leg, each rounded up to the minute.
    const minutes = Math.ceil(durationSec / 60) + Math.ceil(connectedSec / 60);
    const rate = call.tenant.perMinuteRate ?? call.tenant.plan?.perMinuteRate ?? new Prisma.Decimal(DEFAULT_PER_MINUTE);
    const cost = rate.mul(minutes);
    // What the carrier charges us: the caller's leg inbound, the buyer's leg outbound.
    const carrierCost = call.carrier
      ? call.carrier.inboundPerMinute.mul(Math.ceil(durationSec / 60)).add(call.carrier.outboundPerMinute.mul(Math.ceil(connectedSec / 60)))
      : new Prisma.Decimal(0);

    // The call's result and its usage charge are saved together: a finished call is always billed.
    await prisma.$transaction(async (tx) => {
      await tx.call.update({
        where: { id: call.id },
        data: {
          status: s.bridged ? CallStatus.COMPLETED : CallStatus.NO_ANSWER,
          durationSec,
          connectedSec,
          converted,
          revenue,
          payout,
          cost,
          carrierCost,
          hangupCause: ev.cause,
          endedAt: endAt,
          ...(s.usingFallback && s.bridged ? { rejectReason: 'sent_to_fallback' } : {}),
        },
      });
      if (cost.gt(0)) {
        await this.wallet.charge(call.tenantId, cost, TransactionType.CALL_USAGE, `Call from ${call.callerNumber} (${minutes} min)`, call.id, tx);
      }
    });
    if (cost.gt(0)) await this.notifications.checkLowBalance(call.tenantId);
    await this.spam.afterCall({ tenantId: call.tenantId, campaign: call.campaign, callerNumber: call.callerNumber, durationSec, converted }).catch((e) => this.log.warn(`auto-block: ${(e as Error).message}`));

    if (payout.gt(0) && call.publisher?.postbackUrl) {
      const url = fillMacros(call.publisher.postbackUrl, {
        call_id: call.id,
        caller: call.callerNumber,
        duration: durationSec,
        connected: connectedSec,
        payout: payout.toFixed(2),
        revenue: revenue.toFixed(2),
        converted: 1,
        campaign: call.campaign!.name,
        campaign_id: call.campaign!.id,
        publisher: call.publisher.name,
        publisher_id: call.publisher.id,
        tracking_number: call.dialedNumber ?? '',
      });
      await this.postbacks.send(call.tenantId, call.id, url);
    }
  }

  private async notifyCapReached(s: CallState, scope: string, name: string, where: string, cap: string) {
    const period = new Date().toISOString().slice(0, cap === 'hourly' ? 13 : cap === 'daily' ? 10 : 7);
    await this.notifications.notify(s.tenantId, {
      type: 'cap_reached',
      title: `${name} reached its ${cap} cap ${where}`,
      body: 'Calls are going to the next buyer or target until the cap resets.',
      link: scope.startsWith('t:') ? '/targets' : scope.startsWith('b:') ? '/buyers' : '/campaigns',
      dedupeKey: `cap:${scope}:${cap}:${period}`,
      dedupeSec: 32 * 86400,
    });
  }

  // ---------------------------------------------------------------------------
  // State & locking
  // ---------------------------------------------------------------------------

  private async cc(s: CallState): Promise<CallControl> {
    return this.controlFor(s.provider, await this.providers.byId(s.providerId));
  }

  /** The simulator for simulated calls; otherwise the carrier account's own client (Telnyx or Custom API). */
  private async controlFor(provider: ProviderName, carrier: Awaited<ReturnType<ProvidersService['byId']>>): Promise<CallControl> {
    return provider === 'simulator' ? this.controls.simulator : this.providers.callControl(carrier);
  }

  private async save(s: CallState) {
    await this.redis.set(stateKey(s.callId), JSON.stringify(s), 'EX', STATE_TTL);
  }

  private async withState(callControlId: string, fn: (s: CallState) => Promise<void>) {
    const callId = await this.redis.get(legKey(callControlId));
    if (!callId) return;
    await this.withLock(callId, async () => {
      const raw = await this.redis.get(stateKey(callId));
      if (raw) await fn(JSON.parse(raw) as CallState);
    });
  }

  /** Carrier events for one call can arrive at the same time; handle them one by one. */
  private async withLock(callId: string, fn: () => Promise<void>) {
    const key = `lock:call:${callId}`;
    const token = Math.random().toString(36).slice(2);
    const deadline = Date.now() + 10_000;
    while (!(await this.redis.set(key, token, 'PX', 15_000, 'NX'))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock on call ${callId}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    try {
      await fn();
    } catch (e) {
      this.log.error(`Call ${callId}: ${(e as Error).message}`, (e as Error).stack);
    } finally {
      if ((await this.redis.get(key)) === token) await this.redis.del(key);
    }
  }
}

const legKey = (callControlId: string) => `leg:${callControlId}`;
const accountScope = (tenantId: string) => `acct:${tenantId}`;
/** Scopes to release; older call states only had the route. */
const scopesOf = (s: CallState) => s.reservedScopes ?? (s.currentRouteId ? [s.currentRouteId] : []);
const stateKey = (callId: string) => `callstate:${callId}`;
