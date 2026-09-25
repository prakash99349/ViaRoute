import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DestinationType, Role, tenantDb, type Tenant } from '@viaroute/db';
import { CurrentTenant, CurrentUser, Roles } from '../common/decorators';
import type { AuthUser } from '../common/types';
import { Trim } from '../common/validation';
import { CallEngine } from './call-engine.service';
import { AgentsService } from './agents.service';

class CreateAgentDto {
  @IsUUID()
  userId: string;

  @IsOptional() @Trim() @IsString() @MinLength(2) @MaxLength(80)
  name?: string;

  @IsOptional() @IsInt() @Min(5) @Max(120)
  ringTimeoutSec?: number;
}

class UpdateAgentDto {
  @IsOptional() @Trim() @IsString() @MinLength(2) @MaxLength(80)
  name?: string;

  @IsOptional() @IsInt() @Min(5) @Max(120)
  ringTimeoutSec?: number;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

class StatusDto {
  @IsBoolean()
  available: boolean;
}

class LegActionDto {
  @IsIn(['answer', 'decline', 'hangup'])
  action: 'answer' | 'decline' | 'hangup';
}

/** Admins: who takes calls in the browser softphone. Each agent is also a target (add it to campaigns). */
@Roles(Role.TENANT_ADMIN, Role.MANAGER)
@Controller('agents')
export class AgentsController {
  constructor(private agents: AgentsService) {}

  @Get()
  async list(@CurrentTenant() tenant: Tenant) {
    const db = tenantDb(tenant.id);
    const rows = await db.agent.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true, role: true, lastLoginAt: true } },
        target: { select: { id: true, name: true, ringTimeoutSec: true, active: true, _count: { select: { routes: true } } } },
      },
    });
    const online = await this.agents.available(rows.map((r) => r.targetId));
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const today = await db.call.groupBy({ by: ['targetId'], where: { targetId: { in: rows.map((r) => r.targetId) }, startedAt: { gte: since } }, _count: { _all: true }, _sum: { connectedSec: true } });
    return Promise.all(
      rows.map(async ({ sipCredentials, ...r }) => {
        const t = today.find((x) => x.targetId === r.targetId);
        return {
          ...r,
          available: online.has(r.targetId),
          legs: await this.agents.legs(r.targetId),
          callsToday: t?._count._all ?? 0,
          talkSecToday: t?._sum.connectedSec ?? 0,
          sipUsername: this.agents.login({ sipCredentials }).sipUsername ?? null,
        };
      }),
    );
  }

  @Post()
  async create(@CurrentTenant() tenant: Tenant, @Body() dto: CreateAgentDto) {
    const db = tenantDb(tenant.id);
    const user = await db.user.findUnique({ where: { id: dto.userId } });
    if (!user) throw new NotFoundException('Team member not found');
    if (user.role === Role.PUBLISHER || user.role === Role.BUYER) throw new BadRequestException('Publisher and buyer logins can’t take calls');
    if (await db.agent.findUnique({ where: { userId: user.id } })) throw new ConflictException(`${user.name} is already an agent`);
    const target = await db.target.create({
      data: {
        tenantId: tenant.id,
        name: dto.name ?? user.name,
        destinationType: DestinationType.AGENT,
        destination: 'agent', // the real address depends on the carrier (see AgentsService.addressFor)
        ringTimeoutSec: dto.ringTimeoutSec ?? 20,
        concurrencyCap: 1, // one call at a time
      },
    });
    return db.agent.create({ data: { tenantId: tenant.id, userId: user.id, targetId: target.id } });
  }

  @Patch(':id')
  async update(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAgentDto) {
    const db = tenantDb(tenant.id);
    const a = await db.agent.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Agent not found');
    await db.target.update({ where: { id: a.targetId }, data: dto });
    return { ok: true };
  }

  @Delete(':id')
  async remove(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const db = tenantDb(tenant.id);
    const a = await db.agent.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Agent not found');
    await this.agents.setAvailable(a.targetId, false);
    await db.target.delete({ where: { id: a.targetId } }); // the agent row and campaign routes go with it
    return { ok: true };
  }

  /** SIP login for a desk phone / softphone app (Telnyx carriers). Admins only. */
  @Roles(Role.TENANT_ADMIN)
  @HttpCode(200)
  @Post(':id/sip')
  async sip(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const a = await tenantDb(tenant.id).agent.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Agent not found');
    const phone = await this.agents.softphone(a, tenant);
    if (!phone.sip) throw new BadRequestException('SIP phones work with a Telnyx carrier. On this carrier, agents use the browser softphone.');
    return phone.sip;
  }
}

/** The signed-in agent's softphone. */
@Roles(Role.TENANT_ADMIN, Role.MANAGER, Role.AGENT)
@Controller('agent/me')
export class AgentMeController {
  constructor(private agents: AgentsService, private engine: CallEngine) {}

  @Get()
  async me(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser) {
    const a = await tenantDb(tenant.id).agent.findUnique({ where: { userId: me.sub }, include: { target: { select: { id: true, name: true, active: true } } } });
    if (!a) return { agent: null };
    return {
      agent: { id: a.id, targetId: a.targetId, name: a.target.name, active: a.target.active },
      available: await this.agents.isAvailable(a.targetId),
      legs: await this.agents.legs(a.targetId),
    };
  }

  @Put('status')
  async status(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Body() dto: StatusDto) {
    const a = await this.mine(tenant, me);
    await this.agents.setAvailable(a.targetId, dto.available);
    return { available: dto.available };
  }

  @HttpCode(200)
  @Post('heartbeat')
  async heartbeat(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser) {
    const a = await this.mine(tenant, me);
    await this.agents.heartbeat(a.targetId);
    return { available: await this.agents.isAvailable(a.targetId), legs: await this.agents.legs(a.targetId) };
  }

  /** How the browser softphone connects (carrier SDK token, or the simulator). */
  @Get('softphone')
  async softphone(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser) {
    const a = await this.mine(tenant, me);
    const phone = await this.agents.softphone(a, tenant);
    const { sip: _sip, ...rest } = phone; // SIP password only through the admin endpoint
    return rest;
  }

  @HttpCode(200)
  @Post('legs/:legId')
  async leg(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Param('legId') legId: string, @Body() dto: LegActionDto) {
    const a = await this.mine(tenant, me);
    const legs = await this.agents.legs(a.targetId);
    if (!legs.some((l) => l.legId === legId)) throw new NotFoundException('That call is no longer ringing');
    if (!(await this.engine.agentAction(legId, dto.action))) throw new BadRequestException('Answer this call in the softphone');
    return { ok: true };
  }

  private async mine(tenant: Tenant, me: AuthUser) {
    const a = await tenantDb(tenant.id).agent.findUnique({ where: { userId: me.sub } });
    if (!a) throw new ForbiddenException('You are not set up as an agent');
    return a;
  }
}

