import { Controller, ForbiddenException, Headers, HttpCode, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { ProviderType } from '@viaroute/db';
import { Public } from '../common/decorators';
import { ProvidersService } from '../telephony/providers.service';
import { CallEngine } from './call-engine.service';

/** ViaRoute Carrier API v1 events (see docs/CARRIER_API.md). */
interface CarrierEvent {
  event?: 'call.inbound' | 'call.answered' | 'call.speak_ended' | 'call.hangup' | 'call.recording_saved';
  callId?: string;
  from?: string;
  to?: string;
  at?: string;
  cause?: string;
  recordingUrl?: string;
  /** STIR/SHAKEN attestation of call.inbound: "A" | "B" | "C" */
  attestation?: string;
}

const MAX_SKEW_SEC = 300;

/**
 * Receives events from Custom API carriers at /webhooks/carrier/<carrier id>.
 * Signed with the carrier's webhook secret: header `X-ViaRoute-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`.
 */
@SkipThrottle()
@Controller('webhooks/carrier')
export class CarrierWebhookController {
  private readonly log = new Logger(CarrierWebhookController.name);

  constructor(private engine: CallEngine, private providers: ProvidersService) {}

  @Public()
  @HttpCode(200)
  @Post(':providerId')
  async receive(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-viaroute-signature') signature?: string,
  ) {
    const carrier = await this.providers.byId(providerId);
    if (!carrier || carrier.type !== ProviderType.CUSTOM) throw new NotFoundException();
    this.verify(this.providers.credentials(carrier).webhookSecret ?? '', req.rawBody, signature);
    await this.providers.markWebhook(carrier);

    const e = req.body as CarrierEvent;
    if (!e.event || !e.callId) return { ok: true };
    const at = e.at ? new Date(e.at) : new Date();
    if (Number.isNaN(at.getTime())) return { ok: true };
    try {
      switch (e.event) {
        case 'call.inbound':
          if (e.from && e.to) await this.engine.onInbound('custom', { callControlId: e.callId, from: e.from, to: e.to, at, attestation: e.attestation }, carrier.id);
          break;
        case 'call.answered':
          await this.engine.onAnswered({ callControlId: e.callId, at });
          break;
        case 'call.speak_ended':
          await this.engine.onSpeakEnded({ callControlId: e.callId, at });
          break;
        case 'call.hangup':
          await this.engine.onHangup({ callControlId: e.callId, cause: e.cause ?? 'unknown', at });
          break;
        case 'call.recording_saved':
          if (e.recordingUrl) await this.engine.onRecordingSaved({ callControlId: e.callId, url: e.recordingUrl, contentType: e.recordingUrl.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg' });
          break;
      }
    } catch (err) {
      // Always 200: a retried, half-processed event would do more harm than good.
      this.log.error(`${e.event} for ${e.callId} failed: ${(err as Error).message}`);
      await this.providers.markError(carrier, `${e.event}: ${(err as Error).message}`);
    }
    return { ok: true };
  }

  private verify(secret: string, raw: Buffer | undefined, header?: string) {
    if (!secret) throw new ForbiddenException('This carrier has no webhook secret');
    const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.trim().split('=') as [string, string]));
    const t = Number(parts.t);
    if (!raw || !parts.v1 || !t) throw new ForbiddenException('Missing signature');
    if (Math.abs(Date.now() / 1000 - t) > MAX_SKEW_SEC) throw new ForbiddenException('Stale webhook');
    const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
    const given = Buffer.from(parts.v1, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ForbiddenException('Invalid signature');
  }
}
