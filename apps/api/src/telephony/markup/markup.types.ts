import type { NumberType } from '@viaroute/db';
import type { AvailableNumber, PurchaseResult } from '../telephony.types';

/**
 * Carriers that drive calls with markup documents (TwiML, Plivo XML, BXML, NCCO) instead of commands.
 * One adapter serves all of them: each call gets a conference room named after the caller's leg; the
 * caller waits there while buyers are dialed, and a buyer who answers is joined to the same room.
 */
export type MarkupKind = 'twilio' | 'signalwire' | 'plivo' | 'bandwidth' | 'vonage';

/** What a call should do next, independent of the carrier. */
export type Verb =
  | { t: 'say'; text: string }
  /** Tell ViaRoute the message before it finished (→ CallEngine.onSpeakEnded). */
  | { t: 'speakEnded'; callId: string }
  /** Wait in / join the call's conference room; `record` starts a recording (carriers without a REST recorder). */
  | { t: 'join'; room: string; record?: { callId: string } }
  | { t: 'hangup' }
  | { t: 'reject' };

/** Our webhook addresses for one carrier account. */
export interface MarkupUrls {
  answer(): string;
  status(): string;
  flow(callId: string): string;
  join(room: string): string;
  recording(callId: string): string;
  markup(key: string): string;
}

/** Small shared store (Redis) for data a webhook needs later, across API servers. */
export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
}

/** A normalised webhook from a markup carrier. */
export interface MarkupEvent {
  callId?: string;
  from?: string;
  to?: string;
  /** The leg is over (any reason). */
  ended?: boolean;
  cause?: string;
  recordingUrl?: string;
  /** Stored markup to serve (Plivo transfers, Bandwidth redirects). */
  markupKey?: string;
}

export type Hook = 'answer' | 'status' | 'flow' | 'join' | 'recording' | 'markup';

export interface MarkupDialect {
  readonly kind: MarkupKind;
  render(verbs: Verb[]): { body: string; contentType: string };
  /** Reads a webhook; `body` is the parsed form or JSON, `query` the URL query. */
  parse(hook: Hook, body: Record<string, string>, query: Record<string, string>): Promise<MarkupEvent>;

  // Live-call REST operations
  createCall(req: { to: string; from: string; timeoutSec: number; answerUrl: string; statusUrl: string }): Promise<string>;
  /** Plays new markup on a live call. */
  updateCall(callId: string, verbs: Verb[]): Promise<void>;
  hangupCall(callId: string): Promise<void>;
  startRecording(callId: string, room: string): Promise<void>;
  /** Headers needed to download a recording (carriers that protect them). */
  recordingHeaders(): Promise<Record<string, string>>;

  // Account & numbers
  testConnection(): Promise<string>;
  readonly hasNumbersApi: boolean;
  searchNumbers(type: NumberType, areaCode: string | undefined, limit: number): Promise<AvailableNumber[]>;
  purchaseNumber(e164: string): Promise<PurchaseResult>;
  releaseNumber(e164: string, providerNumberId?: string | null): Promise<void>;
}

export const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** "14155550100" / "+14155550100" → "+14155550100"; SIP URIs untouched. */
export const e164 = (n?: string) => (!n ? n : n.startsWith('sip:') || n.startsWith('+') ? n : /^\d{8,15}$/.test(n) ? `+${n}` : n);
export const digits = (n: string) => n.replace(/^\+/, '');
export const room = (callId: string) => `vr-${callId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
