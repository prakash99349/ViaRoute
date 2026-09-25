/**
 * Carrier-independent call control. The router only talks to this interface; Telnyx and the
 * built-in simulator both implement it and both feed events back into CallEngine.
 */

import type { MarkupKind } from '../telephony/markup/markup.types';

export type ProviderName = 'telnyx' | 'custom' | 'simulator' | MarkupKind;

export interface DialRequest {
  /** Inbound leg this outbound leg belongs to. */
  linkTo: string;
  to: string;
  /** Caller ID shown to the buyer. */
  from: string;
  timeoutSec: number;
}

export interface CallControl {
  readonly name: ProviderName;
  answer(callControlId: string): Promise<void>;
  /** Plays text-to-speech; the carrier later sends a speak-ended event. */
  speak(callControlId: string, text: string): Promise<void>;
  /** Starts a new leg to a buyer; returns its call control id. */
  dial(req: DialRequest): Promise<string>;
  bridge(a: string, b: string): Promise<void>;
  recordStart(callControlId: string): Promise<void>;
  hangup(callControlId: string): Promise<void>;
  /** Refuses an unanswered inbound call. */
  reject(callControlId: string): Promise<void>;
}

// --- Normalised events ----------------------------------------------------------

export interface InboundEvent {
  callControlId: string;
  from: string;
  to: string;
  at: Date;
}

export interface LegEvent {
  callControlId: string;
  at: Date;
}

export interface HangupEvent extends LegEvent {
  cause: string;
}

export interface RecordingEvent {
  callControlId: string;
  /** Headers needed to download `url` (carriers that protect recordings). */
  headers?: Record<string, string>;
  /** Temporary carrier URL to download the audio from. */
  url?: string;
  /** Or the audio itself (simulator). */
  audio?: Buffer;
  contentType: string;
}

export const CALL_CONTROLS = Symbol('CALL_CONTROLS');
export type CallControls = Record<ProviderName, CallControl>;
/** The shared adapters; Telnyx adapters come from ProvidersService per carrier account. */
export type SharedCallControls = Pick<CallControls, 'simulator'>;
