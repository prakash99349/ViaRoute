import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';
import { NumberType, Role, type Tenant } from '@viaroute/db';
import { CurrentTenant, CurrentUser, Roles } from '../common/decorators';
import type { AuthUser } from '../common/types';
import { NumbersService } from './numbers.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class SearchDto {
  @IsEnum(NumberType)
  type: NumberType = NumberType.LOCAL;

  @IsOptional() @Matches(/^[2-9]\d{2}$/, { message: 'Area code must be 3 digits' })
  areaCode?: string;
}

class PurchaseDto {
  @Matches(/^\+1[2-9]\d{9}$/, { message: 'Invalid phone number' })
  e164: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(60)
  label?: string;
}

class UpdateDto {
  @IsOptional() @Transform(trim) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60)
  label?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()
  campaignId?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()
  publisherId?: string | null;
}

@Roles(Role.TENANT_ADMIN, Role.MANAGER)
@Controller('numbers')
export class NumbersController {
  constructor(private numbers: NumbersService) {}

  @Get()
  list(@CurrentTenant() tenant: Tenant) {
    return this.numbers.list(tenant);
  }

  @Get('overview')
  overview(@CurrentTenant() tenant: Tenant) {
    return this.numbers.overview(tenant);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('available')
  search(@CurrentTenant() tenant: Tenant, @Query() q: SearchDto) {
    return this.numbers.search(tenant, q.type, q.areaCode);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  purchase(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthUser, @Body() dto: PurchaseDto) {
    return this.numbers.purchase(tenant, user, dto.e164, dto.label);
  }

  @Patch(':id')
  update(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDto) {
    return this.numbers.update(tenant, id, dto);
  }

  @Delete(':id')
  release(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.numbers.release(tenant, user, id);
  }
}
