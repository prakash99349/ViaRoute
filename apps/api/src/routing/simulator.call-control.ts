import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'crypto';
import type { CallControl, DialRequest } from './call-control.types';
import type { CallEngine } from './call-engine.service';

export type BuyerOutcome = 'answer' | 'no_answer' | 'busy';

export interface SimScenario {
  to: string;
  from: string;
  /** What each buyer tried does, in order. Missing entries answer. */
  outcomes?: BuyerOutcome[];
  /** Simulated talk time once a buyer answers. */
  talkSec?: number;
  /** Who ends the conversation. */
  hangupBy?: 'caller' | 'buyer';
  /** Real milliseconds between simulated events (small in tests, ~400 for a watchable demo). */
  stepMs?: number;
  /** STIR/SHAKEN grade the simulated carrier reports (A | B | C). */
  attestation?: string;
  /** Keys the caller presses at each IVR prompt, in order ("" = presses nothing). */
  digits?: string[];
}

const SPEAK_SEC = 4;
const RING_SEC = 6;
const BUSY_SEC = 2;

interface Session {
  scenario: Required<Omit<SimScenario, 'to' | 'from' | 'attestation'>>;
  inboundId: string;
  attempt: number;
  /** Simulated clock (ms). Starts in the past so the call ends about "now". */
  clock: number;
  chain: Promise<void>;
  ended: Set<string>;
  /** Agent legs answered from the softphone. */
  agentAnswered: Set<string>;
  recording: boolean;
  talkSec: number;
}

/**
 * A fake carrier for test mode. Implements the same CallControl interface as Telnyx and sends
 * the same kinds of events back to the CallEngine, with simulated timestamps.
 */
@Injectable()
export class SimulatorCallControl implements CallControl {
  readonly name = 'simulator' as const;
  private readonly log = new Logger(SimulatorCallControl.name);
  private readonly sessions = new Map<string, Session>(); // by leg id
  private engineRef?: CallEngine;

  constructor(private moduleRef: ModuleRef) {}

  private get engine(): CallEngine {
    // Resolved lazily: the engine also depends on this class.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.engineRef ??= this.moduleRef.get(require('./call-engine.service').CallEngine, { strict: false });
    return this.engineRef!;
  }

  /** Places a simulated inbound call. Resolves with the call id once routing has started. */
  async start(s: SimScenario): Promise<string | null> {
    const scenario = { outcomes: s.outcomes ?? [], talkSec: s.talkSec ?? 95, hangupBy: s.hangupBy ?? 'caller', stepMs: s.stepMs ?? 400, digits: [...(s.digits ?? [])] };
    const estimate =
      SPEAK_SEC +
      scenario.outcomes.reduce((sum, o) => sum + (o === 'busy' ? BUSY_SEC : o === 'no_answer' ? 20 : RING_SEC), 0) +
      RING_SEC + scenario.talkSec;
    const inboundId = `sim_in_${randomUUID()}`;
    const session: Session = {
      scenario,
      inboundId,
      attempt: 0,
      clock: Date.now() - estimate * 1000,
      chain: Promise.resolve(),
      ended: new Set(),
      agentAnswered: new Set(),
      recording: false,
      talkSec: 0,
    };
    this.sessions.set(inboundId, session);
    return this.engine.onInbound('simulator', { callControlId: inboundId, from: s.from, to: s.to, at: new Date(session.clock), attestation: s.attestation });
  }

  /** Resolves when every queued event of the call has been delivered (used by tests). */
  async settle(inboundId: string) {
    let last: Promise<void> | undefined;
    while (this.sessions.get(inboundId) && last !== this.sessions.get(inboundId)!.chain) {
      last = this.sessions.get(inboundId)!.chain;
      await last;
    }
  }

  // --- CallControl -------------------------------------------------------------

  async answer() {}

  async speak(id: string) {
    this.after(id, SPEAK_SEC, (at) => this.engine.onSpeakEnded({ callControlId: id, at }));
  }

  async dial(req: DialRequest): Promise<string> {
    const s = this.session(req.linkTo);
    const outId = `sim_out_${randomUUID()}`;
    this.sessions.set(outId, s);
    // An agent's softphone: rings (in real time) until answered, declined or the ring time runs out.
    if (req.to.startsWith('agent:')) {
      s.attempt++;
      setTimeout(() => {
        if (!s.agentAnswered.has(outId) && !s.ended.has(outId)) void this.deliverHangup(outId, 'timeout', new Date());
      }, req.timeoutSec * 1000).unref();
      return outId;
    }
    const outcome = s.scenario.outcomes[s.attempt++] ?? 'answer';

    if (outcome === 'answer') {
      this.after(outId, RING_SEC, async (at) => {
        await this.engine.onAnswered({ callControlId: outId, at });
        // Conversation, then someone hangs up.
        const who = s.scenario.hangupBy === 'buyer' ? outId : s.inboundId;
        s.talkSec = s.scenario.talkSec;
        this.after(who, s.scenario.talkSec, (at2) => this.deliverHangup(who, 'normal_clearing', at2));
      });
    } else {
      const wait = outcome === 'busy' ? BUSY_SEC : req.timeoutSec;
      this.after(outId, wait, (at) => this.deliverHangup(outId, outcome === 'busy' ? 'busy' : 'timeout', at));
    }
    return outId;
  }

  async bridge() {}

  /** The agent pressed Answer. The caller stays on until someone hangs up. */
  agentAnswer(legId: string) {
    const s = this.session(legId);
    if (s.agentAnswered.has(legId) || s.ended.has(legId)) return;
    s.agentAnswered.add(legId);
    void this.engine.onAnswered({ callControlId: legId, at: new Date() });
  }

  /** The agent declined or hung up. */
  agentEnd(legId: string, cause: string) {
    void this.deliverHangup(legId, cause, new Date());
  }

  async gather(id: string) {
    const s = this.session(id);
    const digits = s.scenario.digits.shift() ?? '';
    this.after(id, SPEAK_SEC + 2, (at) => this.engine.onGathered({ callControlId: id, digits, at }));
  }

  async recordStart(id: string) {
    this.session(id).recording = true;
  }

  async hangup(id: string) {
    if (this.session(id).ended.has(id)) return;
    this.after(id, 0, (at) => this.deliverHangup(id, 'normal_clearing', at));
  }

  async reject(id: string) {
    this.after(id, 0, (at) => this.deliverHangup(id, 'call_rejected', at));
  }

  // --- internals ---------------------------------------------------------------

  private async deliverHangup(id: string, cause: string, at: Date) {
    const s = this.session(id);
    if (s.ended.has(id)) return;
    s.ended.add(id);
    await this.engine.onHangup({ callControlId: id, cause, at });

    if (id === s.inboundId && s.recording) {
      this.after(id, 1, () => this.engine.onRecordingSaved({ callControlId: id, audio: toneWav(Math.min(s.talkSec, 8)), contentType: 'audio/wav' }));
    }
    if (id === s.inboundId) {
      // Forget the session once everything queued has run.
      void s.chain.then(() =>
        setTimeout(() => [...this.sessions].forEach(([k, v]) => v === s && this.sessions.delete(k)), 5000).unref(),
      );
    }
  }

  /** Queues an event `sec` simulated seconds later; events of one call run strictly in order. */
  private after(legId: string, sec: number, fn: (at: Date) => Promise<void> | void) {
    const s = this.session(legId);
    s.chain = s.chain
      .then(() => new Promise<void>((r) => setTimeout(r, s.scenario.stepMs)))
      .then(async () => {
        s.clock += sec * 1000;
        await fn(new Date(s.clock));
      })
      .catch((e) => this.log.error(`Simulated event failed: ${(e as Error).message}`));
  }

  private session(legId: string): Session {
    const s = this.sessions.get(legId);
    if (!s) throw new Error(`Unknown simulated call leg ${legId}`);
    return s;
  }
}

/** A short, quiet two-tone WAV standing in for a call recording. */
export function toneWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.max(1, Math.round(rate * Math.max(seconds, 1)));
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const freq = Math.floor(t) % 2 === 0 ? 440 : 523;
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * t) * 3000), 44 + i * 2);
  }
  return buf;
}
