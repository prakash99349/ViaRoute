import { Controller, ForbiddenException, Get, Global, Module, Param, Query, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators';
import { contentType, safeName, StorageService } from '../common/storage.service';
import { CALL_CONTROLS, type CallControls } from './call-control.types';
import { CallEngine } from './call-engine.service';
import { SettingsService } from '../common/settings.service';
import { CapsService } from './caps.service';
import { AgentsController, AgentMeController } from './agents.controller';
import { RecordingsService } from './recordings.service';
import { AgentsService } from './agents.service';
import { SpamController } from './spam.controller';
import { SpamService } from './spam.service';
import { PostbackService } from './postback.service';
import { SimulatorCallControl } from './simulator.call-control';
import { SimulatorController } from './simulator.controller';
import { TelnyxWebhookController } from './telnyx-webhook.controller';
import { CarrierWebhookController } from './carrier-webhook.controller';
import { VoiceWebhookController } from './voice-webhook.controller';

/** Serves private files (recordings) through short-lived signed links. */
@SkipThrottle() // signed, short-lived links; audio players make range requests
@Controller('files')
class FilesController {
  constructor(private storage: StorageService) {}

  @Public()
  @Get('*path')
  async serve(@Param('path') path: string | string[], @Query('exp') exp: string, @Query('sig') sig: string, @Query('dl') dl: string | undefined, @Res() res: Response) {
    const key = Array.isArray(path) ? path.join('/') : path;
    if (!this.storage.verify(key, Number(exp), sig)) throw new ForbiddenException('Link expired');
    // Bucket storage: hand the browser a short-lived bucket link; the audio doesn't pass through us.
    if (this.storage.driver === 's3') return res.redirect(302, await this.storage.bucketUrl(key, dl));
    if (!(await this.storage.exists(key))) throw new ForbiddenException('Link expired');
    res.setHeader('Content-Type', contentType(key));
    res.setHeader('Cache-Control', 'private, max-age=600');
    if (dl) res.setHeader('Content-Disposition', `attachment; filename="${safeName(dl)}"`);
    // Portals (other origins) play these in <audio>; the signed link is the access check.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    this.storage.read(key).pipe(res);
  }
}

@Global()
@Module({
  controllers: [TelnyxWebhookController, CarrierWebhookController, VoiceWebhookController, SimulatorController, SpamController, AgentsController, AgentMeController, FilesController],
  providers: [
    StorageService,
    CapsService,
    PostbackService,
    SettingsService,
    SpamService,
    AgentsService,
    RecordingsService,
    SimulatorCallControl,
    CallEngine,
    {
      provide: CALL_CONTROLS,
      inject: [SimulatorCallControl],
      // Telnyx clients are per carrier account (ProvidersService); only the simulator is shared.
      useFactory: (simulator: SimulatorCallControl): Pick<CallControls, 'simulator'> => ({ simulator }),
    },
  ],
  exports: [StorageService, CapsService, PostbackService, CallEngine, SimulatorCallControl, SettingsService, SpamService, AgentsService, RecordingsService],
})
export class RoutingModule {}
