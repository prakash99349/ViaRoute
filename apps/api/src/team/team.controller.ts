import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode,
  NotFoundException, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { AuthTokenType, prisma, Role, tenantDb, type Tenant, type User } from '@viaroute/db';
import { brandOf } from '../auth/auth.service';
import { TokensService } from '../auth/tokens.service';
import { CurrentTenant, CurrentUser, Roles } from '../common/decorators';
import type { AuthUser } from '../common/types';
import { portalOrigin } from '../config';
import { MailService } from '../mail/mail.service';

/** Staff roles (count towards the plan's user limit). */
const TEAM_ROLES = [Role.TENANT_ADMIN, Role.MANAGER] as const;
type TeamRole = (typeof TEAM_ROLES)[number];
/** Partner logins: a publisher or buyer who sees only their own calls. Not counted in the user limit. */
const PARTNER_ROLES: Role[] = [Role.PUBLISHER, Role.BUYER];
const INVITE_ROLES = [...TEAM_ROLES, Role.PUBLISHER, Role.BUYER, Role.AGENT] as const;
type InviteRole = (typeof INVITE_ROLES)[number];
const ROLE_NAME: Record<Role, string> = {
  SUPER_ADMIN: 'a Super Admin', TENANT_ADMIN: 'an Admin', MANAGER: 'a Manager', PUBLISHER: 'a Publisher', BUYER: 'a Buyer', AGENT: 'an Agent',
};

class InviteDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)) @IsEmail()
  email: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  @IsIn(INVITE_ROLES)
  role: InviteRole;

  @ValidateIf((o) => o.role === Role.PUBLISHER) @IsUUID()
  publisherId?: string;

  @ValidateIf((o) => o.role === Role.BUYER) @IsUUID()
  buyerId?: string;
}

class RoleDto {
  @IsIn(TEAM_ROLES)
  role: TeamRole;
}

@Controller('team')
export class TeamController {
  constructor(private tokens: TokensService, private mail: MailService) {}

  @Roles(Role.TENANT_ADMIN, Role.MANAGER)
  @Get()
  async list(@CurrentTenant() tenant: Tenant) {
    const users = await tenantDb(tenant.id).user.findMany({ orderBy: { createdAt: 'asc' } });
    const plan = tenant.planId ? await prisma.plan.findUnique({ where: { id: tenant.planId } }) : null;
    return {
      maxUsers: plan?.maxUsers ?? null,
      members: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        pending: !u.passwordHash,
        emailVerified: u.emailVerified,
        twofaEnabled: u.twofaEnabled,
        lastLoginAt: u.lastLoginAt,
      })),
    };
  }

  @Roles(Role.TENANT_ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('invite')
  async invite(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Body() dto: InviteDto) {
    const db = tenantDb(tenant.id);
    if (await db.user.findFirst({ where: { email: dto.email } })) {
      throw new ConflictException('Someone with this email is already on your team');
    }
    const isPartner = PARTNER_ROLES.includes(dto.role);
    if (dto.role === Role.PUBLISHER && !(await db.publisher.findUnique({ where: { id: dto.publisherId! } }))) {
      throw new NotFoundException('Publisher not found');
    }
    if (dto.role === Role.BUYER && !(await db.buyer.findUnique({ where: { id: dto.buyerId! } }))) {
      throw new NotFoundException('Buyer not found');
    }
    const plan = tenant.planId ? await prisma.plan.findUnique({ where: { id: tenant.planId } }) : null;
    const staff = await db.user.count({ where: { role: { in: [...TEAM_ROLES] } } });
    if (!isPartner && plan?.maxUsers != null && staff >= plan.maxUsers) {
      throw new ForbiddenException(`Your ${plan.name} plan allows ${plan.maxUsers} users. Upgrade to add more.`);
    }

    const user = await db.user.create({
      data: {
        tenantId: tenant.id,
        email: dto.email,
        name: dto.name,
        role: dto.role,
        invitedById: me.sub,
        publisherId: dto.role === Role.PUBLISHER ? dto.publisherId : null,
        buyerId: dto.role === Role.BUYER ? dto.buyerId : null,
      },
    });
    await this.sendInvite(user, tenant, me);
    await db.auditLog.create({ data: { tenantId: tenant.id, userId: me.sub, action: 'team.invite', entity: 'User', entityId: user.id } });
    return { id: user.id };
  }

  @Roles(Role.TENANT_ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':id/resend-invite')
  async resendInvite(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.findMember(tenant, id);
    if (user.passwordHash) throw new BadRequestException('This person has already joined');
    await this.sendInvite(user, tenant, me);
    return { ok: true };
  }

  @Roles(Role.TENANT_ADMIN)
  @Patch(':id/role')
  async changeRole(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RoleDto) {
    if (id === me.sub) throw new BadRequestException("You can't change your own role");
    const user = await this.findMember(tenant, id);
    if (PARTNER_ROLES.includes(user.role)) throw new BadRequestException("Publisher and buyer logins can't be given staff roles");
    if (user.role === Role.TENANT_ADMIN && dto.role !== Role.TENANT_ADMIN) await this.assertNotLastAdmin(tenant);

    const db = tenantDb(tenant.id);
    await db.user.update({ where: { id }, data: { role: dto.role } });
    await db.auditLog.create({ data: { tenantId: tenant.id, userId: me.sub, action: 'team.role', entity: 'User', entityId: id, meta: { role: dto.role } } });
    return { ok: true };
  }

  @Roles(Role.TENANT_ADMIN)
  @Delete(':id')
  async remove(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    if (id === me.sub) throw new BadRequestException("You can't remove yourself");
    const user = await this.findMember(tenant, id);
    if (user.role === Role.TENANT_ADMIN) await this.assertNotLastAdmin(tenant);

    const db = tenantDb(tenant.id);
    await db.user.delete({ where: { id } });
    await db.auditLog.create({ data: { tenantId: tenant.id, userId: me.sub, action: 'team.remove', entity: 'User', entityId: id, meta: { email: user.email } } });
    return { ok: true };
  }

  private async findMember(tenant: Tenant, id: string): Promise<User> {
    const user = await tenantDb(tenant.id).user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('Team member not found');
    return user;
  }

  private async assertNotLastAdmin(tenant: Tenant) {
    const admins = await tenantDb(tenant.id).user.count({ where: { role: Role.TENANT_ADMIN, passwordHash: { not: null } } });
    if (admins <= 1) throw new BadRequestException('Your team needs at least one admin');
  }

  private async sendInvite(user: User, tenant: Tenant, me: AuthUser) {
    const inviter = await prisma.user.findUnique({ where: { id: me.sub }, select: { name: true } });
    const raw = await this.tokens.issue(user.id, AuthTokenType.INVITE);
    const brand = brandOf(tenant);
    await this.mail.sendAction({
      to: user.email,
      subject: `${inviter?.name ?? 'Your team'} invited you to ${brand.name}`,
      brand,
      heading: `You're invited to ${brand.name}`,
      body: `Hi ${user.name}, ${inviter?.name ?? 'a teammate'} has invited you to join ${tenant.name} as ${ROLE_NAME[user.role]}.`,
      buttonText: 'Accept invite',
      url: `${portalOrigin(tenant)}/accept-invite#t=${raw}`,
      footnote: 'This invite expires in 7 days.',
    });
  }
}
