import { Global, Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';

/** Carrier accounts (Telnyx, Test) and their API clients. */
@Global()
@Module({
  providers: [ProvidersService],
  exports: [ProvidersService],
})
export class TelephonyModule {}
