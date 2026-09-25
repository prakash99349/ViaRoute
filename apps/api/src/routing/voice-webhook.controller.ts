import { All, Controller, ForbiddenException, HttpCode, Logger, NotFoundException, Param, ParseUUIDPipe, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators';
import { captureMarkup } from '../telephony/markup/markup.call-control';
import { room, type Hook, type Verb } from '../telephony/markup/markup.types';
import { ProvidersService } from '../telephony/providers.service';
import { CallEngine } from './call-engine.service';

const HOOKS = new Set<Hook>(['answer', 'status', 'flow', 'join', 'recording', 'markup', 'gathered']);

/**
 * Webhooks for markup carriers (Twilio, SignalWire, Plivo, Bandwidth, Vonage):
 *   /webhooks/voice/<carrier id>/<secret token>/<hook>
 * The unguessable token in the URL authenticates the carrier (the same way for every carrier, and
 * unaffected by proxies rewriting the URL, which breaks some carriers' signature schemes).
 * Answers are markup (TwiML, Plivo XML, BXML or NCCO) telling the call what to do next.
 */
@SkipThrottle()
@Controller('webhooks/voice')
export class VoiceWebhookController {
  private readonly log = new Logger(VoiceWebhookController.name);

  constructor(private engine: CallEngine, private providers: ProvidersService) {}

  @Public()
  @HttpCode(200)
  @All(':providerId/:token/:hook')
  async receive(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Param('token') token: string,
    @Param('hook') hook: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const carrier = await this.providers.byId(providerId);
    if (!carrier || !HOOKS.has(hook as Hook)) throw new NotFoundException();
    const dialect = this.providers.dialect(carrier);
    if (!dialect) throw new NotFoundException();
    const expected = Buffer.from(this.providers.credentials(carrier).webhookToken ?? '');
    const given = Buffer.from(token);
    if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ForbiddenException();
    await this.providers.markWebhook(carrier);

    const body = { ...(req.query as Record<string, string>), ...((req.body ?? {}) as Record<string, string>) };
    const query = req.query as Record<string, string>;
    const send = (verbs: Verb[]) => {
      const out = dialect.render(verbs);
      res.type(out.contentType).send(out.body);
    };

    try {
      const ev = await dialect.parse(hook as Hook, stringify(body), query);
      const at = new Date();
      switch (hook as Hook) {
        case 'answer': {
          if (!ev.callId || !ev.from || !ev.to) return send([{ t: 'reject' }]);
          const id = ev.callId;
          const ctx = await captureMarkup(id, () => this.engine.onInbound(dialect.kind, { callControlId: id, from: ev.from!, to: ev.to!, at, attestation: ev.attestation }, carrier.id));
          return send(ctx.verbs.length ? ctx.verbs : [{ t: 'join', room: room(id) }]); // wait in the room while buyers ring
        }
        case 'flow':
        case 'gathered': {
          if (!ev.callId) return send([{ t: 'hangup' }]);
          const id = ev.callId;
          const role = await this.engine.legRole(id);
          const ctx = await captureMarkup(id, () =>
            hook === 'gathered' ? this.engine.onGathered({ callControlId: id, digits: ev.digits ?? '', at }) : this.engine.onSpeakEnded({ callControlId: id, at }),
          );
          // A buyer's whisper ended → join the caller; the caller → keep waiting in their room.
          if (ctx.joinRoom) return send([...ctx.verbs, { t: 'join', room: ctx.joinRoom }]);
          return send(ctx.verbs.length ? ctx.verbs : role === 'buyer' ? [{ t: 'hangup' }] : [{ t: 'join', room: room(id) }]);
        }
        case 'join': {
          if (!ev.callId) return send([{ t: 'hangup' }]);
          const id = ev.callId;
          const ctx = await captureMarkup(id, () => this.engine.onAnswered({ callControlId: id, at }));
          if (ctx.joinRoom) return send([{ t: 'join', room: ctx.joinRoom }]);
          // Whisper to the buyer first; its end (flow hook) joins them to the caller.
          if (ctx.verbs.length) return send(ctx.verbs);
          return send([{ t: 'hangup' }]); // the caller is no longer waiting for this buyer
        }
        case 'status':
          if (ev.callId && ev.ended) await this.engine.onHangup({ callControlId: ev.callId, cause: ev.cause ?? 'unknown', at });
          return send([]);
        case 'recording':
          if (ev.callId && ev.recordingUrl) {
            await this.engine.onRecordingSaved({
              callControlId: ev.callId,
              url: ev.recordingUrl,
              contentType: /\.wav($|\?)/.test(ev.recordingUrl) ? 'audio/wav' : 'audio/mpeg',
              headers: await dialect.recordingHeaders(),
            });
          }
          return send([]);
        case 'markup': {
          const stored = ev.markupKey ? await this.providers.kv.get(`markup:${ev.markupKey}`) : null;
          return send(stored ? (JSON.parse(stored) as Verb[]) : [{ t: 'hangup' }]);
        }
      }
    } catch (e) {
      this.log.error(`${dialect.kind} ${hook} failed: ${(e as Error).message}`);
      await this.providers.markError(carrier, `${hook}: ${(e as Error).message}`);
      // Keep the caller's call alive where possible; the engine already cleaned up what it could.
      if (!res.headersSent) send(hook === 'status' || hook === 'recording' ? [] : [{ t: 'hangup' }]);
    }
  }
}

/** Form bodies are strings already; JSON bodies may carry numbers. */
function stringify(o: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)]));
}
