import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { CarrierAuth } from '../telephony/telephony.types';
import type { CallControl, DialRequest } from './call-control.types';

const BASE = 'https://api.telnyx.com/v2';

/**
 * Telnyx Call Control commands.
 * Docs: https://developers.telnyx.com/api-reference/call-commands/dial
 */
export class TelnyxCallControl implements CallControl {
  readonly name = 'telnyx' as const;
  private readonly log = new Logger(TelnyxCallControl.name);

  constructor(private auth: CarrierAuth) {}

  answer(id: string) {
    return this.action(id, 'answer');
  }

  speak(id: string, text: string) {
    return this.action(id, 'speak', { payload: text, voice: 'female', language: 'en-US' });
  }

  async dial(req: DialRequest): Promise<string> {
    const res = await this.request<{ data: { call_control_id: string } }>('POST', '/calls', {
      connection_id: this.auth.connectionId,
      to: req.to,
      from: req.from,
      timeout_secs: req.timeoutSec,
      link_to: req.linkTo,
      command_id: randomUUID(),
    });
    return res.data.call_control_id;
  }

  bridge(a: string, b: string) {
    return this.action(a, 'bridge', { call_control_id: b });
  }

  recordStart(id: string) {
    return this.action(id, 'record_start', { format: 'mp3', channels: 'dual' });
  }

  async hangup(id: string) {
    // The leg may already be gone; that's fine.
    await this.action(id, 'hangup').catch((e) => this.log.debug(`hangup ${id}: ${(e as Error).message}`));
  }

  reject(id: string) {
    return this.action(id, 'reject', { cause: 'CALL_REJECTED' });
  }

  private async action(id: string, name: string, body: Record<string, unknown> = {}) {
    await this.request('POST', `/calls/${encodeURIComponent(id)}/actions/${name}`, { ...body, command_id: randomUUID() });
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.auth.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (json as { errors?: { detail?: string }[] }).errors?.[0]?.detail;
      throw new Error(`Telnyx ${path.split('/actions/')[1] ?? path} failed (${res.status}): ${detail ?? JSON.stringify(json).slice(0, 300)}`);
    }
    return json as T;
  }
}
