import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsDateString, IsEmail, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf,
} from 'class-validator';
import { AuthTokenType, NumberStatus, NumberType, Prisma, prisma, Role, TenantStatus, TransactionType, type Tenant } from '@viaroute/db';
import { AuthService, brandOf } from '../auth/auth.service';
import { TokensService } from '../auth/tokens.service';
import { WalletService } from '../billing/wallet.service';
import { CurrentUser, Roles } from '../common/decorators';
import type { AuthUser } from '../common/types';
import { IsTimeZone, Trim, TrimOrNull } from '../common/validation';
import { config, DEFAULT_PER_MINUTE, portalOrigin, RESERVED_SUBDOMAINS } from '../config';
import { MailService } from '../mail/mail.service';
import { numberProviderName, ProvidersService } from '../telephony/providers.service';
import { NumbersService } from '../numbers/numbers.service';

const LIVE_NUMBERS: NumberStatus[] = [NumberStatus.ACTIVE, NumberStatus.PENDING];
/** Money the platform earns from a customer (debits from their wallet). */
const INCOME: TransactionType[] = [TransactionType.SUBSCRIPTION, TransactionType.NUMBER_RENTAL, TransactionType.CALL_USAGE, TransactionType.RECORDING];
const REFUNDABLE: TransactionType[] = [...INCOME, TransactionType.ADJUSTMENT];

// ---------------------------------------------------------------------------
// DTOs

class CreateCustomerDto {
  @Trim() @IsString() @MinLength(2) @MaxLength(80)
  companyName: string;

  @Trim() @Matches(/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/, { message: 'Subdomain: 3–32 lowercase letters, numbers or dashes' })
  subdomain: string;

  @Trim() @IsString() @MinLength(2) @MaxLength(80)
  ownerName: string;

  @Trim() @IsEmail()
  ownerEmail: string;

  @IsOptional() @IsUUID()
  planId?: string;

  /** 0 = start as a paying (active) account. */
  @IsOptional() @IsInt() @Min(0) @Max(365)
  trialDays?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000)
  startingCredit?: number;

  @IsOptional() @IsTimeZone()
  timezone?: string;
}

class UpdateCustomerDto {
  @IsOptional() @Trim() @IsString() @MinLength(2) @MaxLength(80)
  name?: string;

  @IsOptional() @IsTimeZone()
  timezone?: string;

  @IsOptional() @IsUUID()
  planId?: string;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString()
  trialEndsAt?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString()
  billingRenewsAt?: string | null;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100_000)
  lowBalanceThreshold?: number;

  // Custom deal (null = use the plan / platform price)
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(10)
  perMinuteRate?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000)
  numberPriceLocal?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000)
  numberPriceTollFree?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(100_000)
  includedNumbers?: number | null;

  /** Carrier for this customer's new numbers (null = platform default). */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()
  providerId?: string | null;

  // Safety limits (null = no limit)
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(10_000)
  maxConcurrentCalls?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(100_000)
  maxNumbers?: number | null;
}

class StatusDto {
  @IsEnum(TenantStatus)
  status: TenantStatus;

  /** Required when suspending: shown to the customer. */
  @IsOptional() @TrimOrNull() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300)
  reason?: string | null;
}

class PageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize = 50;

  @IsOptional() @IsEnum(TransactionType)
  type?: TransactionType;
}

class UsageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  days = 30;
}

class RefundDto {
  @IsOptional() @Trim() @IsString() @MaxLength(200)
  note?: string;
}

class UserActionDto {
  @IsIn(['reset_password', 'resend_invite', 'disable_2fa', 'logout', 'disable', 'enable'])
  action: 'reset_password' | 'resend_invite' | 'disable_2fa' | 'logout' | 'disable' | 'enable';
}

class MoveNumberDto {
  @IsUUID()
  tenantId: string;
}

class ExistingNumberDto {
  @Trim() @Matches(/^\+[1-9]\d{7,14}$/, { message: 'Number must look like +14155550123' })
  e164: string;

  @IsUUID()
  providerId: string;

  @IsEnum(NumberType)
  type: NumberType;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000)
  monthlyPrice: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1000)
  carrierCost?: number;

  @IsOptional() @Trim() @IsString() @MaxLength(60)
  label?: string;
}

class NoteDto {
  @Trim() @IsString() @MinLength(1) @MaxLength(4000)
  body: string;
}

class CloseDto {
  @Trim() @IsString() @MinLength(3) @MaxLength(300)
  reason: string;

  /** Type the subdomain to confirm. */
  @IsString()
  confirm: string;
}

// ---------------------------------------------------------------------------

/** Platform admin: everything about running a customer's account. */
@Roles(Role.SUPER_ADMIN)
@Controller('admin')
export class CustomersController {
  constructor(
    private wallet: WalletService,
    private numbers: NumbersService,
    private auth: AuthService,
    private tokens: TokensService,
    private mail: MailService,
    private providers: ProvidersService,
  ) {}

  // --- List & create ------------------------------------------------------------

  @Get('tenants')
  async list() {
    const since = new Date(Date.now() - 30 * 86400_000);
    const [tenants, calls, lastCalls, income, owners, numbers] = await Promise.all([
      prisma.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, name: true, subdomain: true, status: true, walletBalance: true, lowBalanceThreshold: true, createdAt: true,
          trialEndsAt: true, billingRenewsAt: true, customDomain: true, customDomainVerifiedAt: true, suspendReason: true, branding: true,
          plan: { select: { id: true, name: true } },
          _count: { select: { users: true } },
        },
      }),
      prisma.call.groupBy({ by: ['tenantId'], where: { startedAt: { gte: since } }, _count: { _all: true } }),
      prisma.call.groupBy({ by: ['tenantId'], _max: { startedAt: true } }),
      prisma.transaction.groupBy({ by: ['tenantId'], where: { createdAt: { gte: since }, type: { in: INCOME } }, _sum: { amount: true } }),
      prisma.user.findMany({ where: { role: Role.TENANT_ADMIN, tenantId: { not: null } }, orderBy: { createdAt: 'asc' }, select: { tenantId: true, email: true, name: true } }),
      prisma.phoneNumber.groupBy({ by: ['tenantId'], where: { status: { in: LIVE_NUMBERS } }, _count: { _all: true } }),
    ]);
    const map = <T extends { tenantId: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.tenantId, r]));
    const callsBy = map(calls);
    const lastBy = map(lastCalls);
    const incomeBy = map(income);
    const numbersBy = map(numbers);
    const ownerBy = new Map<string, { email: string; name: string }>();
    for (const o of owners) if (o.tenantId && !ownerBy.has(o.tenantId)) ownerBy.set(o.tenantId, o);

    return tenants.map(({ branding, customDomainVerifiedAt, ...t }) => ({
      ...t,
      portalName: (branding as { portalName?: string } | null)?.portalName ?? null,
      customDomainVerified: !!customDomainVerifiedAt,
      owner: ownerBy.get(t.id) ?? null,
      calls30d: callsBy.get(t.id)?._count._all ?? 0,
      income30d: incomeBy.get(t.id)?._sum.amount?.neg() ?? new Prisma.Decimal(0),
      lastCallAt: lastBy.get(t.id)?._max.startedAt ?? null,
      numbers: numbersBy.get(t.id)?._count._all ?? 0,
      lowWallet: t.walletBalance.lt(t.lowBalanceThreshold),
    }));
  }

  /** Sales-led signup: the account is set up for the customer, who gets an invite to set a password. */
  @Post('tenants')
  async create(@Body() dto: CreateCustomerDto, @CurrentUser() me: AuthUser) {
    if (RESERVED_SUBDOMAINS.has(dto.subdomain)) throw new ConflictException('That subdomain is reserved');
    if (await prisma.tenant.findUnique({ where: { subdomain: dto.subdomain } })) throw new ConflictException('That subdomain is already taken');
    const plan = dto.planId
      ? await prisma.plan.findUnique({ where: { id: dto.planId } })
      : await prisma.plan.findUnique({ where: { code: 'starter' } });
    if (dto.planId && !plan) throw new NotFoundException('Plan not found');

    const trialDays = dto.trialDays ?? config.trialDays;
    const now = Date.now();
    const { tenant, owner } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: dto.companyName,
          subdomain: dto.subdomain,
          planId: plan?.id,
          timezone: dto.timezone,
          status: trialDays > 0 ? TenantStatus.TRIAL : TenantStatus.ACTIVE,
          trialEndsAt: trialDays > 0 ? new Date(now + trialDays * 86400_000) : null,
          billingRenewsAt: trialDays > 0 ? null : addMonth(new Date(now)),
        },
      });
      const owner = await tx.user.create({
        data: { tenantId: tenant.id, email: dto.ownerEmail.toLowerCase(), name: dto.ownerName, role: Role.TENANT_ADMIN, invitedById: me.sub },
      });
      if (dto.startingCredit) await this.wallet.credit(tenant.id, dto.startingCredit, TransactionType.ADJUSTMENT, 'Starting credit', undefined, tx);
      await tx.auditLog.create({ data: { tenantId: tenant.id, userId: me.sub, action: 'admin.customer_create', meta: { plan: plan?.code ?? null, trialDays } } });
      return { tenant, owner };
    });
    await this.sendInvite(owner.id, owner.email, owner.name, tenant, 'the platform team');
    return { id: tenant.id, subdomain: tenant.subdomain };
  }

  // --- One customer -------------------------------------------------------------

  @Get('tenants/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const t = await prisma.tenant.findUnique({
      where: { id },
      include: {
        plan: true,
        _count: { select: { users: true, calls: true, campaigns: true, phoneNumbers: { where: { status: { in: LIVE_NUMBERS } } }, notes: true } },
      },
    });
    if (!t) throw new NotFoundException('Customer not found');
    const since = new Date(Date.now() - 30 * 86400_000);
    const [owner, live, calls30d, income30d, lastCall, carrier30d, numbersCarrier, carrier] = await Promise.all([
      prisma.user.findFirst({ where: { tenantId: id, role: Role.TENANT_ADMIN }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, email: true, lastLoginAt: true } }),
      prisma.call.count({ where: { tenantId: id, status: { in: ['RINGING', 'IN_PROGRESS'] }, startedAt: { gte: new Date(Date.now() - 6 * 3600_000) } } }),
      prisma.call.count({ where: { tenantId: id, startedAt: { gte: since } } }),
      prisma.transaction.aggregate({ where: { tenantId: id, createdAt: { gte: since }, type: { in: INCOME } }, _sum: { amount: true } }),
      prisma.call.findFirst({ where: { tenantId: id }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
      prisma.call.aggregate({ where: { tenantId: id, startedAt: { gte: since } }, _sum: { carrierCost: true, cost: true } }),
      prisma.phoneNumber.aggregate({ where: { tenantId: id, status: { in: LIVE_NUMBERS } }, _sum: { carrierCost: true, monthlyPrice: true } }),
      t.providerId ? prisma.provider.findUnique({ where: { id: t.providerId }, select: { id: true, name: true, type: true, status: true } }) : null,
    ]);
    const { plan, customDomainVerifiedAt, ...rest } = t;
    return {
      ...rest,
      customDomainVerified: !!customDomainVerifiedAt,
      customDomainTarget: config.customDomainTarget,
      plan: plan && {
        id: plan.id, code: plan.code, name: plan.name, monthlyPrice: plan.monthlyPrice, perMinuteRate: plan.perMinuteRate,
        includedNumbers: plan.includedNumbers, maxUsers: plan.maxUsers, whiteLabel: plan.whiteLabel, customDomain: plan.customDomain,
      },
      platformPrices: { perMinuteRate: DEFAULT_PER_MINUTE, numberPrice: config.numberPrice },
      owner,
      liveCalls: live,
      calls30d,
      income30d: income30d._sum.amount?.neg() ?? new Prisma.Decimal(0),
      lastCallAt: lastCall?.startedAt ?? null,
      carrier,
      margin30d: {
        usageIncome: Number(carrier30d._sum.cost ?? 0),
        usageCarrierCost: Number(carrier30d._sum.carrierCost ?? 0),
        numbersIncome: Number(numbersCarrier._sum.monthlyPrice ?? 0),
        numbersCarrierCost: Number(numbersCarrier._sum.carrierCost ?? 0),
      },
      counts: t._count,
    };
  }

  @Patch('tenants/:id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto, @CurrentUser() me: AuthUser) {
    const t = await this.find(id);
    if (dto.planId && !(await prisma.plan.findUnique({ where: { id: dto.planId } }))) throw new NotFoundException('Plan not found');
    if (dto.providerId && !(await prisma.provider.findUnique({ where: { id: dto.providerId } }))) throw new NotFoundException('Carrier not found');
    const { trialEndsAt, billingRenewsAt, ...rest } = dto;
    const data: Prisma.TenantUncheckedUpdateInput = {
      ...rest,
      ...(trialEndsAt !== undefined ? { trialEndsAt: trialEndsAt && new Date(trialEndsAt) } : {}),
      ...(billingRenewsAt !== undefined ? { billingRenewsAt: billingRenewsAt && new Date(billingRenewsAt) } : {}),
    };
    const updated = await prisma.tenant.update({ where: { id }, data });
    // What changed, for the activity log (old → new).
    const changes = Object.fromEntries(
      Object.keys(dto).map((k) => [k, { from: fmt((t as Record<string, unknown>)[k]), to: fmt((updated as Record<string, unknown>)[k]) }]),
    );
    await prisma.auditLog.create({ data: { tenantId: id, userId: me.sub, action: 'admin.customer_update', meta: changes as Prisma.InputJsonObject } });
    return { ok: true };
  }

  /** Trial / Active / Suspended. Closing has its own endpoint. */
  @Patch('tenants/:id/status')
  async setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto, @CurrentUser() me: AuthUser) {
    const t = await this.find(id);
    if (dto.status === TenantStatus.CLOSED) throw new BadRequestException('Use "Close account" to close a customer');
    if (dto.status === TenantStatus.SUSPENDED && !dto.reason) throw new BadRequestException('Give a reason — the customer will see it');
    const data: Prisma.TenantUpdateInput =
      dto.status === TenantStatus.SUSPENDED
        ? { status: dto.status, suspendReason: dto.reason }
        : {
            status: dto.status,
            suspendReason: null,
            closedAt: null,
            ...(dto.status === TenantStatus.ACTIVE && (!t.billingRenewsAt || t.status === TenantStatus.CLOSED) ? { billingRenewsAt: addMonth(new Date()) } : {}),
            ...(dto.status === TenantStatus.TRIAL && !t.trialEndsAt ? { trialEndsAt: new Date(Date.now() + config.trialDays * 86400_000) } : {}),
          };
    const updated = await prisma.tenant.update({ where: { id }, data });
    await prisma.auditLog.create({ data: { tenantId: id, userId: me.sub, action: 'tenant.status', meta: { from: t.status, status: dto.status, reason: dto.reason ?? null } } });
    return { id: updated.id, status: updated.status };
  }

  /** Stops billing, releases every number and signs everyone out. Call history is kept. */
  @HttpCode(200)
  @Post('tenants/:id/close')
  async close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseDto, @CurrentUser() me: AuthUser) {
    const t = await this.find(id);
    if (dto.confirm.trim().toLowerCase() !== t.subdomain) throw new BadRequestException(`Type "${t.subdomain}" to confirm`);
    if (t.status === TenantStatus.CLOSED) return { ok: true, released: 0, failed: [] };

    const live = await prisma.phoneNumber.findMany({ where: { tenantId: id, status: NumberStatus.ACTIVE } });
    const failed: string[] = [];
    for (const n of live) {
      await this.numbers.release(t, me, n.id).catch(() => failed.push(n.e164));
    }
    await prisma.$transaction([
      prisma.tenant.update({ where: { id }, data: { status: TenantStatus.CLOSED, closedAt: new Date(), suspendReason: dto.reason, billingRenewsAt: null } }),
      prisma.user.updateMany({ where: { tenantId: id }, data: { tokenVersion: { increment: 1 } } }),
      prisma.auditLog.create({ data: { tenantId: id, userId: me.sub, action: 'admin.customer_close', meta: { reason: dto.reason, released: live.length - failed.length, failed } } }),
    ]);
    return { ok: true, released: live.length - failed.length, failed };
  }

  // --- Wallet ---------------------------------------------------------------------

  @Get('tenants/:id/transactions')
  async transactions(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageDto) {
    await this.find(id);
    const where: Prisma.TransactionWhereInput = { tenantId: id, ...(q.type ? { type: q.type } : {}) };
    const [items, total, refunded] = await Promise.all([
      prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({ where: { tenantId: id, refundOfId: { not: null } }, select: { refundOfId: true } }),
    ]);
    const done = new Set(refunded.map((r) => r.refundOfId));
    return {
      items: items.map((x) => ({ ...x, refunded: done.has(x.id), refundable: x.amount.lt(0) && REFUNDABLE.includes(x.type) && !done.has(x.id) })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** Gives a charge back to the wallet, once. */
  @HttpCode(200)
  @Post('transactions/:txId/refund')
  async refund(@Param('txId', ParseUUIDPipe) txId: string, @Body() dto: RefundDto, @CurrentUser() me: AuthUser) {
    const charge = await prisma.transaction.findUnique({ where: { id: txId } });
    if (!charge) throw new NotFoundException('Transaction not found');
    if (!charge.amount.lt(0) || !REFUNDABLE.includes(charge.type)) throw new BadRequestException('Only charges can be refunded');
    const amount = charge.amount.neg();
    try {
      const balance = await this.wallet.credit(
        charge.tenantId, amount, TransactionType.REFUND,
        `Refund: ${charge.description ?? charge.type.toLowerCase()}${dto.note ? ` — ${dto.note}` : ''}`,
        undefined, undefined, charge.id,
      );
      await prisma.auditLog.create({ data: { tenantId: charge.tenantId, userId: me.sub, action: 'wallet.refund', meta: { transactionId: charge.id, amount: amount.toFixed(2), note: dto.note ?? null } } });
      return { walletBalance: balance };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('This charge was already refunded');
      throw e;
    }
  }

  // --- Usage ------------------------------------------------------------------------

  @Get('tenants/:id/usage')
  async usage(@Param('id', ParseUUIDPipe) id: string, @Query() q: UsageDto) {
    await this.find(id);
    const since = new Date(Date.now() - (q.days - 1) * 86400_000);
    since.setUTCHours(0, 0, 0, 0);
    const [calls, money, totals] = await Promise.all([
      prisma.$queryRaw<{ day: string; calls: bigint; converted: bigint; minutes: bigint }[]>`
        SELECT to_char("startedAt", 'YYYY-MM-DD') AS day, count(*) AS calls, count(*) FILTER (WHERE converted) AS converted,
               coalesce(sum(ceil("durationSec" / 60.0) + ceil("connectedSec" / 60.0)), 0)::bigint AS minutes
        FROM "Call" WHERE "tenantId" = ${id}::uuid AND "startedAt" >= ${since} GROUP BY 1`,
      prisma.$queryRaw<{ day: string; type: TransactionType; amount: Prisma.Decimal }[]>`
        SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, type, sum(amount) AS amount
        FROM "Transaction" WHERE "tenantId" = ${id}::uuid AND "createdAt" >= ${since} GROUP BY 1, 2`,
      prisma.transaction.groupBy({ by: ['type'], where: { tenantId: id, createdAt: { gte: since } }, _sum: { amount: true } }),
    ]);
    const callsBy = new Map(calls.map((c) => [c.day, c]));
    const days = Array.from({ length: q.days }, (_, i) => {
      const day = new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10);
      const m = money.filter((x) => x.day === day);
      const sum = (types: TransactionType[]) => m.filter((x) => types.includes(x.type)).reduce((s, x) => s - Number(x.amount), 0);
      const c = callsBy.get(day);
      return {
        day,
        calls: Number(c?.calls ?? 0),
        converted: Number(c?.converted ?? 0),
        minutes: Number(c?.minutes ?? 0),
        usage: round(sum([TransactionType.CALL_USAGE, TransactionType.RECORDING])),
        subscription: round(sum([TransactionType.SUBSCRIPTION, TransactionType.NUMBER_RENTAL])),
        topups: round(-sum([TransactionType.TOPUP])),
      };
    });
    const byType = Object.fromEntries(totals.map((x) => [x.type, Number(x._sum.amount ?? 0)]));
    return {
      days,
      totals: {
        calls: days.reduce((s, d) => s + d.calls, 0),
        converted: days.reduce((s, d) => s + d.converted, 0),
        minutes: days.reduce((s, d) => s + d.minutes, 0),
        byType,
        income: round(-INCOME.reduce((s, k) => s + (byType[k] ?? 0), 0) - (byType[TransactionType.REFUND] ?? 0)),
      },
    };
  }

  // --- Users --------------------------------------------------------------------------

  @Get('tenants/:id/users')
  async users(@Param('id', ParseUUIDPipe) id: string) {
    await this.find(id);
    const users = await prisma.user.findMany({
      where: { tenantId: id },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, name: true, email: true, role: true, emailVerified: true, twofaEnabled: true, lastLoginAt: true, disabledAt: true, createdAt: true, passwordHash: true,
        publisherId: true, buyerId: true,
      },
    });
    return users.map(({ passwordHash, ...u }) => ({ ...u, invited: !passwordHash }));
  }

  @HttpCode(200)
  @Post('users/:userId/actions')
  async userAction(@Param('userId', ParseUUIDPipe) userId: string, @Body() dto: UserActionDto, @CurrentUser() me: AuthUser) {
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { tenant: true } });
    if (!user || !user.tenant) throw new NotFoundException('User not found');
    const bump = { tokenVersion: { increment: 1 } };
    switch (dto.action) {
      case 'reset_password':
        if (!user.passwordHash) throw new BadRequestException("They haven't set a password yet — resend the invite instead");
        await this.auth.forgotPassword(user.email, user.tenant);
        break;
      case 'resend_invite':
        if (user.passwordHash) throw new BadRequestException('This user already has a password');
        await this.sendInvite(user.id, user.email, user.name, user.tenant, 'the platform team');
        break;
      case 'disable_2fa':
        await prisma.user.update({ where: { id: userId }, data: { twofaEnabled: false, twofaSecret: null, ...bump } });
        break;
      case 'logout':
        await prisma.user.update({ where: { id: userId }, data: bump });
        break;
      case 'disable':
        await prisma.user.update({ where: { id: userId }, data: { disabledAt: new Date(), ...bump } });
        break;
      case 'enable':
        await prisma.user.update({ where: { id: userId }, data: { disabledAt: null } });
        break;
    }
    await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: me.sub, action: `admin.user_${dto.action}`, entity: 'User', entityId: userId, meta: { email: user.email } } });
    return { ok: true };
  }

  // --- Numbers ------------------------------------------------------------------------

  @Get('tenants/:id/numbers')
  async numbersOf(@Param('id', ParseUUIDPipe) id: string) {
    await this.find(id);
    return prisma.phoneNumber.findMany({
      where: { tenantId: id, status: { in: LIVE_NUMBERS } },
      orderBy: { purchasedAt: 'desc' },
      include: { campaign: { select: { id: true, name: true } }, publisher: { select: { id: true, name: true } } },
    });
  }

  /**
   * Assigns a number the platform already has on a carrier (bought outside ViaRoute, or a carrier without a numbers
   * API). Nothing is ordered from the carrier; the customer pays `monthlyPrice` from the next renewal.
   */
  @Post('tenants/:id/numbers')
  async addExistingNumber(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ExistingNumberDto, @CurrentUser() me: AuthUser) {
    const t = await this.find(id);
    if (t.status === TenantStatus.CLOSED) throw new BadRequestException('That account is closed');
    const carrier = await this.providers.byId(dto.providerId);
    if (!carrier) throw new NotFoundException('Carrier not found');
    if (await prisma.phoneNumber.findFirst({ where: { e164: dto.e164, status: { in: LIVE_NUMBERS } } })) throw new ConflictException('That number is already in use');
    const n = await prisma.phoneNumber.create({
      data: {
        tenantId: id,
        e164: dto.e164,
        type: dto.type,
        label: dto.label || null,
        status: NumberStatus.ACTIVE,
        provider: numberProviderName(carrier),
        providerId: carrier.id,
        monthlyPrice: dto.monthlyPrice,
        carrierCost: dto.carrierCost ?? this.providers.numberCost(carrier, dto.type),
      },
    });
    await prisma.auditLog.create({ data: { tenantId: id, userId: me.sub, action: 'admin.number_add', entity: 'PhoneNumber', entityId: n.id, meta: { e164: n.e164, carrier: carrier.name } } });
    return n;
  }

  @Delete('numbers/:numberId')
  async releaseNumber(@Param('numberId', ParseUUIDPipe) numberId: string, @CurrentUser() me: AuthUser) {
    const n = await prisma.phoneNumber.findUnique({ where: { id: numberId }, include: { tenant: true } });
    if (!n) throw new NotFoundException('Number not found');
    return this.numbers.release(n.tenant, me, numberId);
  }

  /** Moves a number to another customer. It's unassigned from campaigns; call history stays with the old owner. */
  @HttpCode(200)
  @Post('numbers/:numberId/move')
  async moveNumber(@Param('numberId', ParseUUIDPipe) numberId: string, @Body() dto: MoveNumberDto, @CurrentUser() me: AuthUser) {
    const n = await prisma.phoneNumber.findUnique({ where: { id: numberId } });
    if (!n || !LIVE_NUMBERS.includes(n.status)) throw new NotFoundException('Number not found');
    if (n.tenantId === dto.tenantId) throw new BadRequestException('The number already belongs to this customer');
    const to = await this.find(dto.tenantId);
    if (to.status === TenantStatus.CLOSED) throw new BadRequestException('That account is closed');
    await prisma.$transaction([
      prisma.phoneNumber.update({ where: { id: numberId }, data: { tenantId: dto.tenantId, campaignId: null, publisherId: null } }),
      prisma.auditLog.create({ data: { tenantId: n.tenantId, userId: me.sub, action: 'admin.number_move_out', meta: { e164: n.e164, to: to.subdomain } } }),
      prisma.auditLog.create({ data: { tenantId: dto.tenantId, userId: me.sub, action: 'admin.number_move_in', meta: { e164: n.e164, from: n.tenantId } } }),
    ]);
    return { ok: true };
  }

  // --- Notes & activity ---------------------------------------------------------------

  @Get('tenants/:id/notes')
  async notes(@Param('id', ParseUUIDPipe) id: string) {
    await this.find(id);
    return prisma.tenantNote.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' } });
  }

  @Post('tenants/:id/notes')
  async addNote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto, @CurrentUser() me: AuthUser) {
    await this.find(id);
    const author = await prisma.user.findUnique({ where: { id: me.sub }, select: { name: true } });
    return prisma.tenantNote.create({ data: { tenantId: id, authorId: me.sub, authorName: author?.name ?? 'Admin', body: dto.body } });
  }

  @Delete('notes/:noteId')
  async deleteNote(@Param('noteId', ParseUUIDPipe) noteId: string) {
    const note = await prisma.tenantNote.findUnique({ where: { id: noteId } });
    if (!note) throw new NotFoundException('Note not found');
    await prisma.tenantNote.delete({ where: { id: noteId } });
    return { ok: true };
  }

  @Get('tenants/:id/activity')
  async activity(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageDto) {
    await this.find(id);
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.auditLog.count({ where: { tenantId: id } }),
    ]);
    const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true, role: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    return { items: rows.map((r) => ({ ...r, user: r.userId ? byId.get(r.userId) ?? null : null })), total, page: q.page, pageSize: q.pageSize };
  }

  // ---------------------------------------------------------------------------------

  private async find(id: string): Promise<Tenant> {
    const t = await prisma.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Customer not found');
    return t;
  }

  private async sendInvite(userId: string, email: string, name: string, tenant: Tenant, from: string) {
    const raw = await this.tokens.issue(userId, AuthTokenType.INVITE);
    const brand = brandOf(tenant);
    await this.mail.sendAction({
      to: email,
      subject: `Your ${brand.name} account is ready`,
      brand,
      heading: `Welcome to ${brand.name}`,
      body: `Hi ${name}, ${from} has set up ${tenant.name} for you. Choose a password to get started.`,
      buttonText: 'Set my password',
      url: `${portalOrigin(tenant)}/accept-invite#t=${raw}`,
      footnote: 'This link expires in 7 days.',
    });
  }
}

function addMonth(d: Date) {
  const n = new Date(d);
  n.setMonth(n.getMonth() + 1);
  return n;
}

const round = (n: number) => Math.round(n * 100) / 100;

function fmt(v: unknown) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'toFixed' in (v as object)) return String(v);
  return v as string | number | boolean;
}

