'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Headphones, Mic, MicOff, Phone, PhoneIncoming, PhoneOff } from 'lucide-react';
import { api, formatPhone } from '@/lib/api';

export interface AgentLeg {
  legId: string;
  callId: string;
  caller: string;
  callerState: string | null;
  campaign: string | null;
  ivrPath: string | null;
  state: 'ringing' | 'active';
  since: string;
  simulated: boolean;
}

interface Me {
  agent: { id: string; targetId: string; name: string; active: boolean } | null;
  available?: boolean;
  legs?: AgentLeg[];
}

type Mode = 'simulator' | 'telnyx' | 'twilio';

/** The carrier SDK's call, reduced to what the softphone needs. */
interface SdkCall {
  answer(): void;
  reject(): void;
  hangup(): void;
  mute(on: boolean): void;
}

const POLL_MS = 2500;
const HEARTBEAT_MS = 20_000;

/** A soft two-tone ring while a call is waiting (Web Audio, no files). */
function useRinger(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const ring = () => {
      if (!ctx) return;
      for (const [f, t] of [[480, 0], [440, 0.25]] as const) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.value = 0.05;
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t);
        o.stop(ctx.currentTime + t + 0.2);
      }
    };
    ring();
    const id = setInterval(ring, 2000);
    return () => {
      clearInterval(id);
      void ctx?.close();
    };
  }, [on]);
}

/**
 * Browser softphone for agents. Shows availability, rings for incoming calls, and connects the audio
 * through the carrier's SDK (Telnyx WebRTC or Twilio Voice). On the Test carrier it runs the same
 * flow without audio, through ViaRoute.
 */
export function Softphone() {
  const [me, setMe] = useState<Me | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const sdkCall = useRef<SdkCall | null>(null);
  const [sdkRinging, setSdkRinging] = useState(false);
  const teardown = useRef<(() => void) | null>(null);
  const notAgent = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const m = await api<Me>('/agent/me');
      notAgent.current = !m.agent; // most staff aren't agents: stop polling for them
      setMe(m);
    } catch {
      /* not an agent, or offline for a moment */
    }
  }, []);

  // Who am I, and poll my calls.
  useEffect(() => {
    let stop = false;
    const tick = () => !stop && !notAgent.current && refresh();
    tick();
    const id = setInterval(tick, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(id);
      clearInterval(clock);
    };
  }, [refresh]);

  const isAgent = !!me?.agent;
  const available = !!me?.available;

  // Keep "Available" alive while this tab is open.
  useEffect(() => {
    if (!isAgent || !available) return;
    const id = setInterval(() => void api('/agent/me/heartbeat', { method: 'POST' }).catch(() => {}), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [isAgent, available]);

  // Connect the carrier SDK once we know we're an agent.
  useEffect(() => {
    if (!isAgent) return;
    let cancelled = false;
    (async () => {
      let phone: { mode: Mode; token?: string };
      try {
        phone = await api('/agent/me/softphone');
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      if (cancelled) return;
      setMode(phone.mode);
      if (phone.mode === 'simulator') {
        setSdkReady(true);
        return;
      }
      try {
        if (phone.mode === 'telnyx') {
          const { TelnyxRTC } = await import('@telnyx/webrtc');
          const client = new TelnyxRTC({ login_token: phone.token });
          client.remoteElement = 'vr-softphone-audio';
          client.on('telnyx.ready', () => setSdkReady(true));
          client.on('telnyx.error', (e: unknown) => setError(`Softphone: ${String((e as { error?: { message?: string } })?.error?.message ?? 'connection error')}`));
          client.on('telnyx.notification', (n: { type?: string; call?: { state: string; direction?: string; answer(): Promise<void>; hangup(): Promise<void>; muteAudio(): void; unmuteAudio(): void } }) => {
            if (n.type !== 'callUpdate' || !n.call) return;
            const c = n.call;
            if (c.state === 'ringing' && c.direction === 'inbound') {
              sdkCall.current = { answer: () => void c.answer(), reject: () => void c.hangup(), hangup: () => void c.hangup(), mute: (on) => (on ? c.muteAudio() : c.unmuteAudio()) };
              setSdkRinging(true);
            }
            if (c.state === 'active') setSdkRinging(false);
            if (c.state === 'hangup' || c.state === 'destroy') {
              sdkCall.current = null;
              setSdkRinging(false);
              setMuted(false);
            }
          });
          await client.connect();
          teardown.current = () => void client.disconnect();
        } else {
          const { Device } = await import('@twilio/voice-sdk');
          const device = new Device(phone.token!, { closeProtection: true });
          device.on('registered', () => setSdkReady(true));
          device.on('error', (e: { message?: string }) => setError(`Softphone: ${e.message ?? 'error'}`));
          device.on('tokenWillExpire', async () => {
            const fresh = await api<{ token: string }>('/agent/me/softphone').catch(() => null);
            if (fresh?.token) device.updateToken(fresh.token);
          });
          device.on('incoming', (call: { accept(): void; reject(): void; disconnect(): void; mute(on: boolean): void; on(ev: string, fn: () => void): void }) => {
            sdkCall.current = { answer: () => call.accept(), reject: () => call.reject(), hangup: () => call.disconnect(), mute: (on) => call.mute(on) };
            setSdkRinging(true);
            const done = () => {
              sdkCall.current = null;
              setSdkRinging(false);
              setMuted(false);
            };
            call.on('accept', () => setSdkRinging(false));
            call.on('disconnect', done);
            call.on('cancel', done);
            call.on('reject', done);
          });
          await device.register();
          teardown.current = () => device.destroy();
        }
      } catch (e) {
        setError(`Could not start the softphone: ${(e as Error).message}. Check microphone permission.`);
      }
    })();
    return () => {
      cancelled = true;
      teardown.current?.();
      teardown.current = null;
    };
  }, [isAgent]);

  const leg = me?.legs?.[0];
  const ringing = leg?.state === 'ringing' || sdkRinging;
  useRinger(!!ringing && available);

  if (!isAgent) return null;

  async function setStatus(v: boolean) {
    setBusy(true);
    setError('');
    try {
      if (v && mode !== 'simulator') {
        // Ask for the microphone up front, so the first call isn't lost to a permission prompt.
        await navigator.mediaDevices?.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
      }
      await api('/agent/me/status', { method: 'PUT', json: { available: v } });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(action: 'answer' | 'decline' | 'hangup') {
    setError('');
    const sdk = sdkCall.current;
    if (mode !== 'simulator' && sdk) {
      if (action === 'answer') sdk.answer();
      else if (action === 'decline') sdk.reject();
      else sdk.hangup();
    } else if (leg) {
      await api(`/agent/me/legs/${leg.legId}`, { method: 'POST', json: { action } }).catch((e) => setError((e as Error).message));
    }
    setTimeout(refresh, 300);
  }

  const elapsed = leg ? Math.max(0, Math.round((now - new Date(leg.since).getTime()) / 1000)) : 0;
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const showCall = !!leg || sdkRinging;

  return (
    <div className="fixed bottom-20 right-3 z-40 w-[min(340px,calc(100vw-1.5rem))] lg:bottom-5 lg:right-5" role="region" aria-label="Softphone">
      <audio id="vr-softphone-audio" autoPlay />
      <div className={`overflow-hidden rounded-2xl border bg-card shadow-2xl ${ringing ? 'border-success ring-4 ring-success/20' : 'border-border'}`}>
        {/* Header / status */}
        <div className="flex items-center gap-2 px-4 py-3">
          <Headphones size={16} className="text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{me?.agent?.name}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => setStatus(!available)}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${available ? 'bg-success-bg text-success' : 'bg-subtle text-muted'}`}
            aria-pressed={available}
          >
            <span className={`h-2 w-2 rounded-full ${available ? 'bg-success' : 'bg-faint'}`} />
            {available ? 'Available' : 'Away'}
          </button>
          <button type="button" onClick={() => setOpen(!open)} aria-label={open ? 'Minimise softphone' : 'Open softphone'} className="rounded-md p-1 text-muted hover:bg-subtle">
            {open ? <ChevronDown size={16} aria-hidden /> : <ChevronUp size={16} aria-hidden />}
          </button>
        </div>

        {(open || showCall) && (
          <div className="border-t border-border px-4 py-3 text-sm">
            {error && <p className="mb-2 rounded-md bg-danger-bg px-2.5 py-1.5 text-xs text-danger">{error}</p>}
            {showCall ? (
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${ringing ? 'animate-pulse bg-success-bg text-success' : 'bg-subtle'}`}>
                    <PhoneIncoming size={18} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-base font-semibold">{leg ? (/^\+\d+$/.test(leg.caller) ? formatPhone(leg.caller) : leg.caller) : 'Incoming call'}</div>
                    <div className="truncate text-xs text-muted">
                      {[leg?.campaign, leg?.callerState].filter(Boolean).join(' · ') || '—'}
                    </div>
                    {leg?.ivrPath && <div className="mt-1 truncate text-xs text-muted" title={leg.ivrPath}>IVR: {leg.ivrPath}</div>}
                  </div>
                  <span className="font-mono text-xs text-muted tabular">{ringing ? 'Ringing' : clock}</span>
                </div>
                {ringing ? (
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => act('decline')} className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-danger-bg font-medium text-danger hover:opacity-90">
                      <PhoneOff size={16} aria-hidden /> Decline
                    </button>
                    <button type="button" onClick={() => act('answer')} className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-success font-medium text-white hover:opacity-90">
                      <Phone size={16} aria-hidden /> Answer
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={mode === 'simulator'}
                      onClick={() => {
                        sdkCall.current?.mute(!muted);
                        setMuted(!muted);
                      }}
                      className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-border-strong font-medium hover:bg-subtle disabled:opacity-50"
                    >
                      {muted ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />} {muted ? 'Unmute' : 'Mute'}
                    </button>
                    <button type="button" onClick={() => act('hangup')} className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-danger font-medium text-white hover:opacity-90">
                      <PhoneOff size={16} aria-hidden /> Hang up
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted">
                {available
                  ? mode === 'simulator'
                    ? 'Waiting for calls. Test carrier: calls ring here without audio — place a test call from a campaign.'
                    : sdkReady
                      ? 'Waiting for calls. Keep this tab open.'
                      : 'Connecting the softphone…'
                  : 'You are away: calls go to the next buyer or agent. Switch to Available to take calls.'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
