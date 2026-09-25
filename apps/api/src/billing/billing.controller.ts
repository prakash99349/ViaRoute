import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { prisma, Role, TransactionType, type Tenant } from '@viaroute/db';
import { CurrentTenant, Public, Roles } from '../common/decorators';
import { BillingService } from './billing.service';

class TopupDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(10) @Max(10_000)
  amount: number;
}

class PlanDto {
  @IsString()
  code: string;
}

class SettingsDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100_000)
  lowBalanceThreshold: number;
}

class TxQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}$/)
  month?: string;

  @IsOptional() @IsIn(Object.values(TransactionType))
  type?: TransactionType;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;
}

@Roles(Role.TENANT_ADMIN)
@Controller('billing')
export class BillingController {
  constructor(private billing: BillingService) {}

  @Get()
  overview(@CurrentTenant() tenant: Tenant) {
    return this.billing.overview(tenant);
  }

  @Get('transactions')
  async transactions(@CurrentTenant() tenant: Tenant, @Query() q: TxQuery) {
    const where = {
      tenantId: tenant.id,
      ...(q.type ? { type: q.type } : {}),
      ...(q.month
        ? (() => {
            const [y, m] = q.month.split('-').map(Number);
            return { createdAt: { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) } };
          })()
        : {}),
    };
    const page = q.page ?? 1;
    const [items, total] = await Promise.all([
      prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50 }),
      prisma.transaction.count({ where }),
    ]);
    return { items, total, page, pageSize: 50 };
  }

  @Get('statements/:month')
  statement(@CurrentTenant() tenant: Tenant, @Param('month') month: string) {
    return this.billing.statement(tenant, month);
  }

  @HttpCode(200)
  @Post('topup')
  topup(@CurrentTenant() tenant: Tenant, @Body() dto: TopupDto) {
    return this.billing.startTopup(tenant, dto.amount);
  }

  @HttpCode(200)
  @Post('plan')
  async plan(@CurrentTenant() tenant: Tenant, @Body() dto: PlanDto) {
    const plan = await this.billing.changePlan(tenant, dto.code);
    return { plan: { code: plan.code, name: plan.name } };
  }

  @Patch('settings')
  async settings(@CurrentTenant() tenant: Tenant, @Body() dto: SettingsDto) {
    await prisma.tenant.update({ where: { id: tenant.id }, data: { lowBalanceThreshold: dto.lowBalanceThreshold, lowBalanceNotifiedAt: null } });
    return { ok: true };
  }
}

@SkipThrottle()
@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(private billing: BillingService) {}

  @Public()
  @HttpCode(200)
  @Post()
  receive(@Req() req: Request & { rawBody?: Buffer }, @Headers('stripe-signature') signature?: string) {
    return this.billing.handleStripeWebhook(req.rawBody, signature);
  }
}
