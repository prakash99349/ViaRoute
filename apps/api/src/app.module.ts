import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminController } from './admin/admin.controller';
import { CustomersController } from './admin/customers.controller';
import { ProvidersController } from './admin/providers.controller';
import { AdminSpamController } from './admin/spam.controller';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { CallsModule } from './calls/calls.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { AuthGuard } from './common/auth.guard';
import { RedisModule } from './common/redis.module';
import { TenantMiddleware } from './common/tenant.middleware';
import { config } from './config';
import { HealthController } from './health.controller';
import { MailModule } from './mail/mail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { NumbersModule } from './numbers/numbers.module';
import { RoutingModule } from './routing/routing.module';
import { TeamController } from './team/team.controller';
import { TelephonyModule } from './telephony/telephony.module';
import { TenantController } from './tenant/tenant.controller';

@Module({
  imports: [
    JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { expiresIn: config.jwtExpiresIn as any } }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
      skipIf: () => process.env.DISABLE_THROTTLE === '1', // automated tests only
    }),
    RedisModule,
    MailModule,
    BillingModule,
    NotificationsModule,
    RoutingModule,
    TelephonyModule,
    AuthModule,
    NumbersModule,
    CampaignsModule,
    CallsModule,
  ],
  controllers: [HealthController, TenantController, AdminController, CustomersController, ProvidersController, AdminSpamController, TeamController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Public carrier webhooks and signed file links don't belong to a portal.
    consumer.apply(TenantMiddleware).exclude('health', 'webhooks/*path', 'files/*path', 'internal/*path').forRoutes('*');
  }
}
