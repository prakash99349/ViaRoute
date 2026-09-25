import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { PartialType } from '@nestjs/mapped-types';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf,
} from 'class-validator';
import { NumberStatus, Prisma, RepeatRouting, Role, tenantDb, type Tenant } from '@viaroute/db';
import { CurrentTenant, CurrentUser, Roles } from '../common/decorators';
import type { AuthUser } from '../common/types';
import { assertValid, E164, orNotFound, Trim, TrimOrNull } from '../common/validation';
import { validateGeoRules, validateSchedule, type GeoRules, type Schedule } from '../routing/rules';
import { validateIvr, type IvrFlow } from '../routing/ivr';
import { normalizePrefix } from '../routing/spam.service';

class CampaignDto {
  @Trim() @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(3600)
  convertAfterSeconds?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000)
  payout?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000)
  revenue?: number;

  @IsOptional() @IsBoolean()
  recordCalls?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(60 * 60 * 24 * 90)
  duplicateWindowSec?: number;

  @IsOptional() @TrimOrNull() @ValidateIf((_, v) => v !== null) @Matches(E164, { message: 'Fallback number must look like +14155550123' })
  fallbackNumber?: string | null;

  @IsOptional() @IsEnum(RepeatRouting)
  repeatRouting?: RepeatRouting;

  // Spam protection
  @IsOptional() @IsBoolean()
  blockAnonymous?: boolean;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1000)
  callerRateLimit?: number | null;

  @IsOptional() @IsInt() @Min(1) @Max(60 * 24 * 7)
  callerRateWindowMin?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(200) @Matches(/^\+?\d{1,15}$/, { each: true, message: 'Prefixes are digits like +1900 or +234' })
  blockedPrefixes?: string[];

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['A', 'B'])
  minAttestation?: 'A' | 'B' | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(100)
  maxSpamScore?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(2) @Max(100)
  autoBlockShortCalls?: number | null;

  @IsOptional() @IsInt() @Min(1) @Max(120)
  shortCallSec?: number;

  /** Phone menu (see routing/ivr.ts); null removes it. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsObject()
  ivr?: IvrFlow | null;

  /** Played to the buyer before connecting; null = none. */
  @IsOptional() @TrimOrNull() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500)
  whisperText?: string | null;
}

class UpdateCampaignDto extends PartialType(CampaignDto) {}

class RouteDto {
  /** Ring this buyer's main line… */
  @IsOptional() @IsUUID()
  buyerId?: string;

  /** …or ring this target. */
  @IsOptional() @IsUUID()
  targetId?: string;

  @IsOptional() @IsInt() @Min(1) @Max(99)
  priority?: number;

  @IsOptional() @IsInt() @Min(0) @Max(1000)
  weight?: number;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(100_000)
  hourlyCap?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1_000_000)
  dailyCap?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(10_000_000)
  monthlyCap?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1000)
  concurrencyCap?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsObject()
  schedule?: Schedule | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsObject()
  geoRules?: GeoRules | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000)
  revenueOverride?: number | null;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

class UpdateRouteDto extends PartialType(RouteDto) {}

/** JSON columns: null must be written as Prisma.DbNull. */
function routeData(dto: Partial<RouteDto>) {
  assertValid(validateSchedule(dto.schedule));
  assertValid(validateGeoRules(dto.geoRules));
  const { schedule, geoRules, buyerId: _b, targetId: _t, ...rest } = dto;
  return {
    ...rest,
    ...(schedule !== undefined ? { schedule: schedule === null || !Object.keys(schedule).length ? Prisma.DbNull : schedule } : {}),
    ...(geoRules !== undefined ? { geoRules: geoRules === null || !geoRules.allowStates?.length ? Prisma.DbNull : (geoRules as object) } : {}),
  };
}

@Roles(Role.TENANT_ADMIN, Role.MANAGER)
@Controller()
export class CampaignsController {
  // --- Campaigns --------------------------------------------------------------

  @Get('campaigns')
  async list(@CurrentTenant() tenant: Tenant) {
    const db = tenantDb(tenant.id);
    const since = new Date(Date.now() - 24 * 3600_000);
    const [campaigns, stats] = await Promise.all([
      db.campaign.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { routes: true, phoneNumbers: { where: { status: { in: [NumberStatus.ACTIVE, NumberStatus.PENDING] } } } } },
        },
      }),
      db.call.groupBy({
        by: ['campaignId'],
        where: { startedAt: { gte: since } },
        _count: { _all: true },
        _sum: { revenue: true, payout: true },
      }),
    ]);
    const byId = new Map(stats.map((s) => [s.campaignId, s]));
    return campaigns.map((c) => ({
      ...c,
      last24h: {
        calls: byId.get(c.id)?._count._all ?? 0,
        revenue: byId.get(c.id)?._sum.revenue ?? 0,
        payout: byId.get(c.id)?._sum.payout ?? 0,
      },
    }));
  }

  @Post('campaigns')
  async create(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Body() dto: CampaignDto) {
    const db = tenantDb(tenant.id);
    // The IVR is set up after creating (it can point at the campaign's buyers).
    const { ivr: _ivr, ...data } = dto;
    const c = await db.campaign.create({ data: { ...data, tenantId: tenant.id } });
    await db.auditLog.create({ data: { tenantId: tenant.id, userId: me.sub, action: 'campaign.create', entity: 'Campaign', entityId: c.id } });
    return c;
  }

  @Get('campaigns/:id')
  async get(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const c = await tenantDb(tenant.id).campaign.findUnique({
      where: { id },
      include: {
        routes: {
          include: { buyer: true, target: { include: { buyer: { select: { id: true, name: true } } } } },
          orderBy: [{ priority: 'asc' }, { weight: 'desc' }],
        },
        phoneNumbers: {
          where: { status: { in: [NumberStatus.ACTIVE, NumberStatus.PENDING] } },
          include: { publisher: { select: { id: true, name: true } } },
          orderBy: { purchasedAt: 'asc' },
        },
      },
    });
    return orNotFound(c, 'Campaign');
  }

  @Patch('campaigns/:id')
  async update(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampaignDto) {
    const db = tenantDb(tenant.id);
    orNotFound(await db.campaign.findUnique({ where: { id } }), 'Campaign');
    if (dto.ivr) {
      const [buyers, targets] = await Promise.all([db.buyer.findMany({ select: { id: true } }), db.target.findMany({ select: { id: true } })]);
      assertValid(validateIvr(dto.ivr, { buyers: new Set(buyers.map((b) => b.id)), targets: new Set(targets.map((t) => t.id)) }));
    }
    const { ivr, ...rest } = dto;
    const c = await db.campaign.update({ where: { id }, data: { ...rest, ...(ivr !== undefined ? { ivr: ivr === null ? Prisma.DbNull : (ivr as unknown as Prisma.InputJsonObject) } : {}), ...(rest.blockedPrefixes ? { blockedPrefixes: rest.blockedPrefixes.map(normalizePrefix) } : {}) } });
    await db.auditLog.create({ data: { tenantId: tenant.id, userId: me.sub, action: 'campaign.update', entity: 'Campaign', entityId: id, meta: dto as object } });
    return c;
  }

  @Delete('campaigns/:id')
  async remove(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const db = tenantDb(tenant.id);
    orNotFound(await db.campaign.findUnique({ where: { id } }), 'Campaign');
    await db.campaign.delete({ where: { id } }); // numbers are unassigned, call history kept
    await db.auditLog.create({ data: { tenantId: tenant.id, userId: me.sub, action: 'campaign.delete', entity: 'Campaign', entityId: id } });
    return { ok: true };
  }

  // --- Routes (campaign → buyer's main line, or → target) -----------------------

  @Post('campaigns/:id/routes')
  async addRoute(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) campaignId: string, @Body() dto: RouteDto) {
    const db = tenantDb(tenant.id);
    orNotFound(await db.campaign.findUnique({ where: { id: campaignId } }), 'Campaign');
    if (!!dto.buyerId === !!dto.targetId) throw new BadRequestException('Choose a buyer or a target');
    let buyerId = dto.buyerId ?? null;
    if (dto.targetId) {
      const target = orNotFound(await db.target.findUnique({ where: { id: dto.targetId } }), 'Target');
      buyerId = target.buyerId;
      if (await db.route.findFirst({ where: { campaignId, targetId: dto.targetId } })) throw new BadRequestException('This target is already on the campaign');
    } else {
      orNotFound(await db.buyer.findUnique({ where: { id: dto.buyerId } }), 'Buyer');
      if (await db.route.findFirst({ where: { campaignId, buyerId, targetId: null } })) throw new BadRequestException('This buyer is already on the campaign');
    }
    const priority = dto.priority ?? (dto.targetId ? (await db.target.findUnique({ where: { id: dto.targetId } }))!.priority : undefined);
    return db.route.create({
      data: { ...(routeData(dto) as Prisma.RouteUncheckedCreateInput), priority, buyerId, targetId: dto.targetId ?? null, campaignId, tenantId: tenant.id },
    });
  }

  @Patch('routes/:id')
  async updateRoute(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRouteDto) {
    const db = tenantDb(tenant.id);
    orNotFound(await db.route.findUnique({ where: { id } }), 'Route');
    if (dto.buyerId || dto.targetId) throw new BadRequestException("A route's buyer or target can't be changed; add a new route instead");
    return db.route.update({ where: { id }, data: routeData(dto) as Prisma.RouteUncheckedUpdateInput });
  }

  @Delete('routes/:id')
  async removeRoute(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const db = tenantDb(tenant.id);
    orNotFound(await db.route.findUnique({ where: { id } }), 'Route');
    await db.route.delete({ where: { id } });
    return { ok: true };
  }
}
