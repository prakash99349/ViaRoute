import { AsyncLocalStorage } from 'async_hooks';
import type { CallControl, DialRequest } from '../../routing/call-control.types';
import type { AvailableNumber, NumberSearch, PurchaseResult, TelephonyProvider } from '../telephony.types';
import { ProviderError } from '../telephony.types';
import { room, type MarkupDialect, type MarkupKind, type MarkupUrls, type Verb } from './markup.types';

/** The carrier request being answered right now: commands for its call become the response markup. */
interface Capture {
  callId: string;
  verbs: Verb[];
  /** Set when the engine bridges this (buyer) leg to a caller: join their room. */
  joinRoom?: string;
}

const capture = new AsyncLocalStorage<Capture>();

/** Runs `fn` while a carrier waits for markup for `callId`, and returns the verbs it produced. */
export async function captureMarkup(callId: string, fn: () => Promise<unknown>): Promise<Capture> {
  const ctx: Capture = { callId, verbs: [] };
  await capture.run(ctx, fn);
  return ctx;
}

const current = (callId: string) => {
  const ctx = capture.getStore();
  return ctx && ctx.callId === callId ? ctx : null;
};

/**
 * CallControl for markup carriers. Commands for the call whose webhook is being answered are returned
 * as markup; commands for any other call go through the carrier's REST API.
 */
export class MarkupCallControl implements CallControl {
  readonly name: MarkupKind;

  constructor(private dialect: MarkupDialect, private urls: MarkupUrls) {
    this.name = dialect.kind;
  }

  /** Markup carriers answer by returning markup. */
  async answer() {}

  async speak(id: string, text: string) {
    const verbs: Verb[] = [{ t: 'say', text }, { t: 'speakEnded', callId: id }];
    const ctx = current(id);
    if (ctx) ctx.verbs.push(...verbs);
    else await this.dialect.updateCall(id, verbs);
  }

  dial(req: DialRequest): Promise<string> {
    return this.dialect.createCall({ to: req.to, from: req.from, timeoutSec: req.timeoutSec, answerUrl: this.urls.join(room(req.linkTo)), statusUrl: this.urls.status() });
  }

  /** The buyer's answer webhook is being handled: tell it to join the caller's room. */
  async bridge(callerId: string, buyerId: string) {
    const ctx = current(buyerId);
    if (ctx) ctx.joinRoom = room(callerId);
    else await this.dialect.updateCall(buyerId, [{ t: 'join', room: room(callerId) }]);
  }

  recordStart(id: string) {
    return this.dialect.startRecording(id, room(id));
  }

  async hangup(id: string) {
    const ctx = current(id);
    if (ctx) ctx.verbs.push({ t: 'hangup' });
    else await this.dialect.hangupCall(id).catch(() => {}); // the leg may already be gone
  }

  async reject(id: string) {
    const ctx = current(id);
    if (ctx) ctx.verbs.push({ t: 'reject' });
    else await this.dialect.hangupCall(id);
  }
}

/** Numbers API for markup carriers (Bandwidth has none: numbers are added by the admin). */
export class MarkupNumbers implements TelephonyProvider {
  readonly name: 'telnyx' | 'custom' | 'mock';

  constructor(private dialect: MarkupDialect) {
    this.name = 'custom'; // only used for display in logs; the number's carrier row says which one
  }

  testConnection() {
    return this.dialect.testConnection();
  }

  searchNumbers(q: NumberSearch): Promise<AvailableNumber[]> {
    this.require();
    return this.dialect.searchNumbers(q.type, q.areaCode, q.limit);
  }

  purchaseNumber(e164: string): Promise<PurchaseResult> {
    this.require();
    return this.dialect.purchaseNumber(e164);
  }

  async checkOrder(providerOrderId: string): Promise<PurchaseResult> {
    return { status: 'ACTIVE', providerOrderId, providerNumberId: providerOrderId };
  }

  async releaseNumber(e164: string, providerNumberId?: string | null) {
    if (!this.dialect.hasNumbersApi) return; // added by the admin: just taken out of use here
    await this.dialect.releaseNumber(e164, providerNumberId);
  }

  private require() {
    if (!this.dialect.hasNumbersApi) throw new ProviderError('Numbers on this carrier are added by the platform team. Please contact support.');
  }
}
