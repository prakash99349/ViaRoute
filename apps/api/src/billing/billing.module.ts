import { Global, Module } from '@nestjs/common';
import { BillingController, StripeWebhookController } from './billing.controller';
import { BillingService } from './billing.service';
import { WalletService } from './wallet.service';

@Global()
@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: [WalletService, BillingService],
  exports: [WalletService, BillingService],
})
export class BillingModule {}
