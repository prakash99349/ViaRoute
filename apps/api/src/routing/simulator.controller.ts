import { BadRequestException, Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { NumberStatus, ProviderType, Role, tenantDb, type Tenant } from '@viaroute/db';
import { CurrentTenant, Roles } from '../common/decorators';
import { E164 } from '../common/validation';
import { ProvidersService } from '../telephony/providers.service';
import { SimulatorCallControl, type BuyerOutcome } from './simulator.call-control';

class SimulateDto {
  @Matches(E164, { message: 'Tracking number must look like +14155550100' })
  to: string;

  @Matches(/^(\+[1-9]\d{7,14}|anonymous|restricted|unknown)$/, { message: 'Caller number must look like +13055550123 (or "anonymous" to test hidden caller IDs)' })
  from: string;

  /** STIR/SHAKEN grade the simulated carrier reports. */
  @IsOptional() @IsIn(['A', 'B', 'C'])
  attestation?: 'A' | 'B' | 'C';

  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsIn(['answer', 'no_answer', 'busy'], { each: true })
  outcomes?: BuyerOutcome[];

  @IsOptional() @IsInt() @Min(0) @Max(3600)
  talkSec?: number;

  @IsOptional() @IsIn(['caller', 'buyer'])
  hangupBy?: 'caller' | 'buyer';

  @IsOptional() @IsInt() @Min(0) @Max(3000)
  stepMs?: number;
}

/** Test calls without a phone: available in test mode, or when SIMULATOR_ENABLED=true. */
@Roles(Role.TENANT_ADMIN, Role.MANAGER)
@Controller('simulator')
export class SimulatorController {
  constructor(private sim: SimulatorCallControl, private providers: ProvidersService) {}

  /** Simulated calls work on test-carrier numbers (or anywhere with SIMULATOR_ENABLED=true). */
  private async enabledFor(tenant: Tenant) {
    if (process.env.SIMULATOR_ENABLED === 'true') return true;
    if ((await this.providers.forNewNumber(tenant)).type === ProviderType.TEST) return true;
    return !!(await tenantDb(tenant.id).phoneNumber.findFirst({ where: { status: NumberStatus.ACTIVE, provider: 'mock' }, select: { id: true } }));
  }

  @Get()
  async status(@CurrentTenant() tenant: Tenant) {
    return { enabled: await this.enabledFor(tenant) };
  }

  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Post('calls')
  async simulate(@CurrentTenant() tenant: Tenant, @Body() dto: SimulateDto) {
    const number = await tenantDb(tenant.id).phoneNumber.findFirst({ where: { e164: dto.to, status: NumberStatus.ACTIVE } });
    if (!number) throw new BadRequestException('That tracking number is not one of your active numbers');
    if (number.provider !== 'mock' && process.env.SIMULATOR_ENABLED !== 'true') throw new ForbiddenException('The call simulator only works on test-carrier numbers');
    const callId = await this.sim.start(dto);
    return { callId };
  }
}
