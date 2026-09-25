import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { PartialType } from '@nestjs/mapped-types';
import {
  IsBoolean, IsEmail, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUrl, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf,
} from 'class-validator';
import { DestinationType, Prisma, Role, tenantDb, type Tenant } from '@viaroute/db';
import { CurrentTenant, Roles } from '../common/decorators';
import { CapsService } from '../routing/caps.service';
import { E164, orNotFound, SIP_URI, Trim, TrimOrNull } from '../common/validation';

// --- Publishers (traffic sources we pay) --------------------------------------

class PublisherDto {
  @Trim() @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  @IsOptional() @TrimOrNull() @ValidateIf((_, v) => v !== null) @IsEmail()
  email?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000)
  payoutOverride?: number | null;

  @IsOptional() @TrimOrNull() @ValidateIf((_, v) => v !== null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false }, { message: 'Postback URL must start with http:// or https://' })
  @MaxLength(1000)
  postbackUrl?: string | null;

  @IsOptional() @IsBoolean()
  active?: boolean;
}
class UpdatePublisherDto extends PartialType(PublisherDto) {}

// --- Buyers (who we sell calls to) --------------------------------------------

class BuyerDto {
  @Trim() @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  @IsOptional() @IsEnum(DestinationType)
  destinationType?: DestinationType;

  @Trim() @IsString() @MaxLength(255)
  destination: string;

  @IsOptional() @TrimOrNull() @ValidateIf((_, v) => v !== null) @IsEmail()
  email?: string | null;

  @IsOptional() @IsInt() @Min(5) @Max(120)
  ringTimeoutSec?: number;

  // Buyer-wide caps (every campaign, main line and targets). null = off.
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1000)
  concurrencyCap?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(100_000)
  hourlyCap?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1_000_000)
  dailyCap?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(10_000_000)
  monthlyCap?: number | null;

  @IsOptional() @IsBoolean()
  active?: boolean;
}
class UpdateBuyerDto extends PartialType(BuyerDto) {}

// --- Targets (where calls ring: a buyer's call center, or your own agents) ----

class TargetDto {
  @Trim() @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  /** Owner buyer; null = a direct target (no buyer). */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()
  buyerId?: string | null;

  @IsOptional() @IsEnum(DestinationType)
  destinationType?: DestinationType;

  @Trim() @IsString() @MaxLength(255)
  destination: string;

  @IsOptional() @IsInt() @Min(5) @Max(120)
  ringTimeoutSec?: number;

  /** Default priority when added to a campaign (1 = tried first). */
  @IsOptional() @IsInt() @Min(1) @Max(99)
  priority?: number;

  // Target-wide caps, shared by every campaign. null = off.
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1000)
  concurrencyCap?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(100_000)
  hourlyCap?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1_000_000)
  dailyCap?: number | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(10_000_000)
  monthlyCap?: number | null;

  @IsOptional() @IsBoolean()
  active?: boolean;
}
class UpdateTargetDto extends PartialType(TargetDto) {}

/**
 * Checks a destination and returns it in stored form. Number: E.164.
 * IP: sip:user@host, sip:host[:port], or just an IP/host[:port] (stored as sip:…).
 */
function checkDestination(type: DestinationType | undefined, destination: string | undefined): string | undefined {
  if (destination === undefined) return undefined;
  if ((type ?? DestinationType.PHONE) === DestinationType.PHONE) {
    if (!E164.test(destination)) throw new BadRequestException('Number must look like +14155550123');
    return destination;
  }
  const uri = /^sips?:/i.test(destination) ? destination : `sip:${destination}`;
  if (!SIP_URI.test(uri)) throw new BadRequestException('IP destination must look like 203.0.113.10, 203.0.113.10:5060 or sip:agent@203.0.113.10');
  return uri;
}

// --- Blocked callers ----------------------------------------------------------

class BlockDto {
  @Trim() @Matches(E164, { message: 'Number must look like +14155550123' })
  e164: string;

  @IsOptional() @TrimOrNull() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  reason?: string | null;
}

@Roles(Role.TENANT_ADMIN, Role.MANAGER)
@Controller()
export class PartnersController {
  constructor(private caps: CapsService) {}

  // Publishers

  @Get('publishers')
  async publishers(@CurrentTenant() tenant: Tenant) {
    return tenantDb(tenant.id).publisher.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { phoneNumbers: { where: { status: { in: ['ACTIVE', 'PENDING'] } } }, calls: true } } },
    });
  }

  @Post('publishers')
  createPublisher(@CurrentTenant() tenant: Tenant, @Body() dto: PublisherDto) {
    return tenantDb(tenant.id).publisher.create({ data: { ...dto, tenantId: tenant.id } });
  }

  @Patch('publishers/:id')
  async updatePublisher(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePublisherDto) {
    const db = tenantDb(tenant.id);
    orNotFound(await db.publisher.findUnique({ where: { id } }), 'Publisher');
    return db.publisher.update({ where: { id }, data: dto });
  }

  @Delete('publishers/:id')
  async deletePublisher(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const db = tenantDb(tenant.id);
    orNotFound(await db.publisher.findUnique({ where: { id } }), 'Publisher');
    await db.user.deleteMany({ where: { publisherId: id } }); // their portal logins
    await db.publisher.delete({ where: { id } });
    return { ok: true };
  }

  // Buyers

  @Get('buyers')
  async buyers(@CurrentTenant() tenant: Tenant) {
    const buyers = await tenantDb(tenant.id).buyer.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { routes: true, calls: true, targets: true } } },
    });
    const usage = await this.caps.usageMany(buyers.map((b) => `b:${b.id}`), tenant.timezone);
    return buyers.map((b) => ({ ...b, usage: usage.get(`b:${b.id}`) }));
  }

  @Post('buyers')
  createBuyer(@CurrentTenant() tenant: Tenant, @Body() dto: BuyerDto) {
    const destination = checkDestination(dto.destinationType, dto.destination)!;
    return tenantDb(tenant.id).buyer.create({ data: { ...dto, destination, tenantId: tenant.id } });
  }

  @Patch('buyers/:id')
  async updateBuyer(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBuyerDto) {
    const db = tenantDb(tenant.id);
    const buyer = orNotFound(await db.buyer.findUnique({ where: { id } }), 'Buyer');
    const destination = checkDestination(dto.destinationType ?? buyer.destinationType, dto.destination ?? (dto.destinationType ? buyer.destination : undefined));
    return db.buyer.update({ where: { id }, data: { ...dto, destination } });
  }

  @Delete('buyers/:id')
  async deleteBuyer(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const db = tenantDb(tenant.id);
    orNotFound(await db.buyer.findUnique({ where: { id } }), 'Buyer');
    await db.user.deleteMany({ where: { buyerId: id } });
    await db.buyer.delete({ where: { id } }); // its routes go too; call history kept
    return { ok: true };
  }

  // Targets

  @Get('targets')
  async targets(@CurrentTenant() tenant: Tenant) {
    const targets = await tenantDb(tenant.id).target.findMany({
      orderBy: [{ priority: 'asc' }, { buyer: { name: 'asc' } }, { name: 'asc' }],
      include: { buyer: { select: { id: true, name: true, active: true } }, _count: { select: { routes: true, calls: true } } },
    });
    const usage = await this.caps.usageMany(targets.map((t) => `t:${t.id}`), tenant.timezone);
    return targets.map((t) => ({ ...t, liveCalls: usage.get(`t:${t.id}`)!.live, usage: usage.get(`t:${t.id}`) }));
  }

  @Post('targets')
  async createTarget(@CurrentTenant() tenant: Tenant, @Body() dto: TargetDto) {
    const db = tenantDb(tenant.id);
    const destination = checkDestination(dto.destinationType, dto.destination)!;
    if (dto.buyerId) orNotFound(await db.buyer.findUnique({ where: { id: dto.buyerId } }), 'Buyer');
    return db.target.create({ data: { ...dto, destination, tenantId: tenant.id } });
  }

  @Patch('targets/:id')
  async updateTarget(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTargetDto) {
    const db = tenantDb(tenant.id);
    const target = orNotFound(await db.target.findUnique({ where: { id } }), 'Target');
    const destination = checkDestination(dto.destinationType ?? target.destinationType, dto.destination ?? (dto.destinationType ? target.destination : undefined));
    if (dto.buyerId) orNotFound(await db.buyer.findUnique({ where: { id: dto.buyerId } }), 'Buyer');
    const updated = await db.target.update({ where: { id }, data: { ...dto, destination } });
    // Routes to this target belong to the same buyer (for reports, partner logins and repeat-caller rules).
    if (dto.buyerId !== undefined) await db.route.updateMany({ where: { targetId: id }, data: { buyerId: dto.buyerId } });
    return updated;
  }

  @Delete('targets/:id')
  async deleteTarget(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const db = tenantDb(tenant.id);
    orNotFound(await db.target.findUnique({ where: { id } }), 'Target');
    await db.target.delete({ where: { id } }); // its routes go too; call history kept
    return { ok: true };
  }

  // Blocked callers

  @Get('blocked-numbers')
  blocked(@CurrentTenant() tenant: Tenant) {
    return tenantDb(tenant.id).blockedNumber.findMany({ orderBy: { createdAt: 'desc' } });
  }

  @Post('blocked-numbers')
  async block(@CurrentTenant() tenant: Tenant, @Body() dto: BlockDto) {
    try {
      return await tenantDb(tenant.id).blockedNumber.create({ data: { ...dto, tenantId: tenant.id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('This number is already blocked');
      throw e;
    }
  }

  @Delete('blocked-numbers/:id')
  async unblock(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const db = tenantDb(tenant.id);
    orNotFound(await db.blockedNumber.findUnique({ where: { id } }), 'Blocked number');
    await db.blockedNumber.delete({ where: { id } });
    return { ok: true };
  }
}
