import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { PartialType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsBoolean, IsHexColor, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { promises as dns } from 'dns';
import { Prisma, prisma, Role, TenantStatus, TransactionType } from '@viaroute/db';
import { AuthService } from '../auth/auth.service';
import { WalletService } from '../billing/wallet.service';
import { CurrentUser, Roles } from '../common/decorators';
import type { AuthUser } from '../common/types';
import { Trim, TrimOrNull } from '../common/validation';
import { config } from '../config';

const MAX_LOGO_BYTES = 200 * 1024;

class CreditDto {
  /** Positive adds funds, negative removes them. */
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(-10_000) @Max(10_000)
  amount: number;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @MinLength(3) @MaxLength(200)
  note: string;
}

class PlanDto {
  @Trim() @Matches(/^[a-z0-9-]{2,30}$/, { message: 'Code: 2–30 lowercase letters, numbers or dashes' })
  code: string;

  @Trim() @IsString() @MinLength(2) @MaxLength(40)
  name: string;

  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100_000)
  monthlyPrice: number;

  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(10)
  perMinuteRate: number;

  @IsInt() @Min(0) @Max(100_000)
  includedNumbers: number;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(100_000)
  maxUsers?: number | null;

  @IsOptional() @IsBoolean()
  whiteLabel?: boolean;

  @IsOptional() @IsBoolean()
  customDomain?: boolean;

  @IsOptional() @IsBoolean()
  active?: boolean;
}
class UpdatePlanDto extends PartialType(PlanDto) {}

class BrandingDto {
  @IsOptional() @TrimOrNull() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60)
  portalName?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsHexColor()
  primaryColor?: string | null;

  /** A small PNG/JPEG/WebP as a data: URL, or null to remove. */
  @IsOptional() @ValidateIf((_, v) => v !== null)
  @Matches(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, { message: 'Logo must be a PNG, JPEG or WebP image' })
  logoUrl?: string | null;
}

class DomainDto {
  @Trim()
  @Matches(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, { message: 'Enter a domain like calls.yourcompany.com' })
  domain: string;
}

@Roles(Role.SUPER_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private wallet: WalletService, private auth: AuthService) {}

  @Get('stats')
  async stats() {
    const since = new Date(Date.now() - 29 * 86400_000);
    since.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const INCOME: TransactionType[] = [TransactionType.SUBSCRIPTION, TransactionType.NUMBER_RENTAL, TransactionType.CALL_USAGE];

    const [tenants, active, trial, suspended, users, calls, numbers, incomeMonth, walletFloat, dailyCalls, dailyIncome, carrierMonth, numbersCarrier, dailyCarrier] = await Promise.all([
      prisma.tenant.count(),
      prisma.tenant.count({ where: { status: TenantStatus.ACTIVE } }),
      prisma.tenant.count({ where: { status: TenantStatus.TRIAL } }),
      prisma.tenant.count({ where: { status: TenantStatus.SUSPENDED } }),
      prisma.user.count({ where: { tenantId: { not: null } } }),
      prisma.call.count(),
      prisma.phoneNumber.count({ where: { status: { in: ['ACTIVE', 'PENDING'] } } }),
      prisma.transaction.aggregate({ where: { type: { in: INCOME }, createdAt: { gte: monthStart } }, _sum: { amount: true } }),
      prisma.tenant.aggregate({ _sum: { walletBalance: true } }),
      prisma.$queryRaw<{ day: string; n: bigint }[]>`
        SELECT to_char("startedAt", 'YYYY-MM-DD') AS day, count(*) AS n FROM "Call" WHERE "startedAt" >= ${since} GROUP BY 1`,
      prisma.$queryRaw<{ day: string; amount: Prisma.Decimal }[]>`
        SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, -sum(amount) AS amount FROM "Transaction"
        WHERE "createdAt" >= ${since} AND type::text = ANY(${INCOME}::text[]) GROUP BY 1`,
      prisma.call.aggregate({ where: { startedAt: { gte: monthStart } }, _sum: { carrierCost: true } }),
      prisma.phoneNumber.aggregate({ where: { status: { in: ['ACTIVE', 'PENDING'] } }, _sum: { carrierCost: true } }),
      prisma.$queryRaw<{ day: string; amount: Prisma.Decimal }[]>`
        SELECT to_char("startedAt", 'YYYY-MM-DD') AS day, sum("carrierCost") AS amount FROM "Call" WHERE "startedAt" >= ${since} GROUP BY 1`,
    ]);

    const callsBy = new Map(dailyCalls.map((r) => [r.day, Number(r.n)]));
    const incomeBy = new Map(dailyIncome.map((r) => [r.day, Number(r.amount)]));
    const carrierBy = new Map(dailyCarrier.map((r) => [r.day, Number(r.amount)]));
    const daily = Array.from({ length: 30 }, (_, i) => {
      const day = new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10);
      return { day, calls: callsBy.get(day) ?? 0, income: Math.round((incomeBy.get(day) ?? 0) * 100) / 100, carrierCost: Math.round((carrierBy.get(day) ?? 0) * 100) / 100 };
    });

    return {
      tenants, active, trial, suspended, users, calls, numbers,
      incomeThisMonth: incomeMonth._sum.amount?.neg() ?? 0,
      // Call legs this month + one month of rental for every live number.
      carrierCostThisMonth: (carrierMonth._sum.carrierCost ?? new Prisma.Decimal(0)).add(numbersCarrier._sum.carrierCost ?? 0),
      walletFloat: walletFloat._sum.walletBalance ?? 0,
      daily,
    };
  }

  // --- White-label (set by the platform owner for each customer) ----------------

  @Patch('tenants/:id/branding')
  async branding(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BrandingDto, @CurrentUser() me: AuthUser) {
    const tenant = await this.find(id);
    if (dto.logoUrl && Buffer.byteLength(dto.logoUrl.split(',')[1] ?? '', 'base64') > MAX_LOGO_BYTES) {
      throw new BadRequestException('Logo must be smaller than 200 KB');
    }
    const next = { ...((tenant.branding ?? {}) as Record<string, unknown>) };
    for (const [k, v] of Object.entries(dto)) {
      if (v === null) delete next[k];
      else if (v !== undefined) next[k] = v;
    }
    await prisma.tenant.update({ where: { id }, data: { branding: Object.keys(next).length ? (next as Prisma.InputJsonObject) : Prisma.DbNull } });
    await prisma.auditLog.create({
      data: { tenantId: id, userId: me.sub, action: 'tenant.branding', meta: { portalName: dto.portalName, primaryColor: dto.primaryColor, logoChanged: dto.logoUrl !== undefined } },
    });
    return { branding: next };
  }

  @Put('tenants/:id/domain')
  async setDomain(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DomainDto, @CurrentUser() me: AuthUser) {
    await this.find(id);
    const domain = dto.domain.toLowerCase();
    const root = config.rootDomain;
    if (domain === root || domain.endsWith(`.${root}`)) throw new BadRequestException(`Use the customer's own domain, not one under ${root}`);
    const taken = await prisma.tenant.findFirst({ where: { customDomain: domain, id: { not: id } } });
    if (taken) throw new ConflictException('That domain is already connected to another account');
    await prisma.tenant.update({ where: { id }, data: { customDomain: domain, customDomainVerifiedAt: null } });
    await prisma.auditLog.create({ data: { tenantId: id, userId: me.sub, action: 'tenant.domain', meta: { domain } } });
    return { domain, target: config.customDomainTarget, verified: false };
  }

  @HttpCode(200)
  @Post('tenants/:id/domain/verify')
  async verifyDomain(@Param('id', ParseUUIDPipe) id: string) {
    const tenant = await this.find(id);
    if (!tenant.customDomain) throw new BadRequestException('Add a domain first');
    let records: string[] = [];
    try {
      records = (await dns.resolveCname(tenant.customDomain)).map((r) => r.toLowerCase().replace(/\.$/, ''));
    } catch {
      records = [];
    }
    if (!records.includes(config.customDomainTarget)) {
      throw new BadRequestException(
        records.length
          ? `${tenant.customDomain} points to ${records.join(', ')} — it should point to ${config.customDomainTarget}`
          : `No CNAME record found for ${tenant.customDomain} yet. DNS changes can take up to an hour.`,
      );
    }
    await prisma.tenant.update({ where: { id }, data: { customDomainVerifiedAt: new Date() } });
    return { domain: tenant.customDomain, verified: true };
  }

  @Delete('tenants/:id/domain')
  async removeDomain(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser) {
    await this.find(id);
    await prisma.tenant.update({ where: { id }, data: { customDomain: null, customDomainVerifiedAt: null } });
    await prisma.auditLog.create({ data: { tenantId: id, userId: me.sub, action: 'tenant.domain', meta: { domain: null } } });
    return { ok: true };
  }

  /** Manual wallet adjustment (goodwill credit, corrections, testing before Stripe is live). */
  @HttpCode(200)
  @Post('tenants/:id/credit')
  async credit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreditDto, @CurrentUser() me: AuthUser) {
    const note = `Admin adjustment: ${dto.note}`;
    const balance =
      dto.amount >= 0
        ? await this.wallet.credit(id, dto.amount, TransactionType.ADJUSTMENT, note)
        : await this.wallet.debit(id, -dto.amount, TransactionType.ADJUSTMENT, note);
    await prisma.auditLog.create({ data: { tenantId: id, userId: me.sub, action: 'wallet.adjust', meta: { amount: dto.amount, note: dto.note } } });
    return { walletBalance: balance };
  }

  /** Support: open the customer's portal as their admin for 1 hour (audit-logged). */
  @HttpCode(200)
  @Post('tenants/:id/impersonate')
  impersonate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser) {
    return this.auth.impersonate(me, id);
  }

  // --- Plans --------------------------------------------------------------------

  @Get('plans')
  async plans() {
    const plans = await prisma.plan.findMany({ orderBy: { monthlyPrice: 'asc' }, include: { _count: { select: { tenants: true } } } });
    return plans;
  }

  @Post('plans')
  async createPlan(@Body() dto: PlanDto) {
    if (await prisma.plan.findUnique({ where: { code: dto.code } })) throw new ConflictException('A plan with this code already exists');
    return prisma.plan.create({ data: dto });
  }

  @Patch('plans/:id')
  async updatePlan(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanDto) {
    if (dto.code) {
      const other = await prisma.plan.findUnique({ where: { code: dto.code } });
      if (other && other.id !== id) throw new ConflictException('A plan with this code already exists');
    }
    return prisma.plan.update({ where: { id }, data: dto });
  }

  private async find(id: string) {
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException('Customer not found');
    return tenant;
  }
}
