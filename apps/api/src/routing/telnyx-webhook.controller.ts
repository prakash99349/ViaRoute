import { Controller, ForbiddenException, Headers, HttpCode, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { createPublicKey, verify } from 'crypto';
import type { Request } from 'express';
import { Public } from '../common/decorators';
import { ProviderType, type Provider } from '@viaroute/db';
import { ProvidersService } from '../telephony/providers.service';
import { CallEngine } from './call-engine.service';

interface TelnyxEvent {
  data?: {
    event_type?: string;
    occurred_at?: string;
    payload?: {
      call_control_id?: string;
      direction?: 'incoming' | 'outgoing';
      from?: string;
      to?: string;
      hangup_cause?: string;
      end_time?: string;
      recording_urls?: { mp3?: string; wav?: string };
      shaken_stir_attestation?: string;
      digits?: string;
    };
  };
}

const MAX_SKEW_SEC = 300;

/**
 * Receives Telnyx Call Control webhooks.
 * Each carrier account has its own URL, https://api.<domain>/webhooks/telnyx/<carrier id>, checked with that
 * account's public key. The plain /webhooks/telnyx URL still works for the .env account.
 */
// Carrier events are signature-checked; a busy account sends many per second from few IPs.
@SkipThrottle()
@Controller('webhooks/telnyx')
export class TelnyxWebhookController {
  private readonly log = new Logger(TelnyxWebhookController.name);

  constructor(private engine: CallEngine, private providers: ProvidersService) {}

  /** Legacy URL: the account from .env (or the default Telnyx carrier). */
  @Public()
  @HttpCode(200)
  @Post()
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('telnyx-signature-ed25519') signature?: string,
    @Headers('telnyx-timestamp') timestamp?: string,
  ) {
    let carrier: Provider | null = null;
    let key = this.providers.publicKey(null);
    if (!key) {
      const d = await this.providers.defaultProvider();
      if (d.type === ProviderType.TELNYX) {
        carrier = d;
        key = this.providers.publicKey(d);
      }
    }
    this.verify(key, req.rawBody, signature, timestamp);
    return this.handle(req.body as TelnyxEvent, carrier);
  }

  @Public()
  @HttpCode(200)
  @Post(':providerId')
  async receiveFor(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('telnyx-signature-ed25519') signature?: string,
    @Headers('telnyx-timestamp') timestamp?: string,
  ) {
    const carrier = await this.providers.byId(providerId);
    if (!carrier || carrier.type !== ProviderType.TELNYX) throw new NotFoundException();
    this.verify(this.providers.publicKey(carrier), req.rawBody, signature, timestamp);
    await this.providers.markWebhook(carrier);
    return this.handle(req.body as TelnyxEvent, carrier);
  }

  private async handle(body: TelnyxEvent, carrier: Provider | null) {
    const type = body.data?.event_type;
    const p = body.data?.payload;
    if (!type || !p?.call_control_id) return { ok: true };

    const at = new Date(body.data?.occurred_at ?? Date.now());
    const id = p.call_control_id;
    try {
      switch (type) {
        case 'call.initiated':
          if (p.direction === 'incoming' && p.from && p.to) await this.engine.onInbound('telnyx', { callControlId: id, from: p.from, to: p.to, at, attestation: p.shaken_stir_attestation }, carrier?.id);
          break;
        case 'call.answered':
          await this.engine.onAnswered({ callControlId: id, at });
          break;
        case 'call.speak.ended':
          await this.engine.onSpeakEnded({ callControlId: id, at });
          break;
        case 'call.gather.ended':
          await this.engine.onGathered({ callControlId: id, digits: p.digits ?? '', at });
          break;
        case 'call.hangup':
          await this.engine.onHangup({ callControlId: id, cause: p.hangup_cause ?? 'unknown', at: new Date(p.end_time ?? at) });
          break;
        case 'call.recording.saved':
          await this.engine.onRecordingSaved({ callControlId: id, url: p.recording_urls?.mp3 ?? p.recording_urls?.wav, contentType: p.recording_urls?.mp3 ? 'audio/mpeg' : 'audio/wav' });
          break;
      }
    } catch (e) {
      // Always 200: Telnyx retrying a half-processed event would do more harm than good.
      this.log.error(`${type} for ${id} failed: ${(e as Error).message}`);
      await this.providers.markError(carrier, `${type}: ${(e as Error).message}`);
    }
    return { ok: true };
  }

  /** Ed25519 over "timestamp|raw body", with the public key from Telnyx portal → Keys & Credentials. */
  private verify(publicKey: string, raw: Buffer | undefined, signature?: string, timestamp?: string) {
    if (!publicKey) {
      if (process.env.NODE_ENV === 'production') throw new ForbiddenException('Webhook verification is not configured');
      return; // local development without a key
    }
    if (!raw || !signature || !timestamp) throw new ForbiddenException('Missing signature');
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SEC) throw new ForbiddenException('Stale webhook');

    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    const ok = verify(null, Buffer.concat([Buffer.from(`${timestamp}|`), raw]), key, Buffer.from(signature, 'base64'));
    if (!ok) throw new ForbiddenException('Invalid signature');
  }
}
