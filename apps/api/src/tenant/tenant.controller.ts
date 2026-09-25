import { Body, Controller, Get, NotFoundException, Patch, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { prisma, Role, tenantDb, type Tenant } from '@viaroute/db';
import { CurrentTenant, CurrentUser, Public, Roles } from '../common/decorators';
import type { AuthUser } from '../common/types';
import { IsTimeZone, Trim } from '../common/validation';
import { config, RESERVED_SUBDOMAINS } from '../config';

class SettingsDto {
  @IsOptional() @Trim() @IsString() @MinLength(2) @MaxLength(80)
  name?: string;

  @IsOptional() @IsTimeZone()
  timezone?: string;
}

@Controller()
export class TenantController {
  /** Branding for the login page of a portal (no login needed). */
  @Public()
  @Get('tenant/public')
  publicInfo(@CurrentTenant() tenant: Tenant | null) {
    if (!tenant) return { platform: true, name: 'ViaRoute', branding: null };
    return { platform: false, name: tenant.name, subdomain: tenant.subdomain, branding: tenant.branding, timezone: tenant.timezone };
  }

  /** Current customer account overview for the dashboard. */
  @Get('tenant')
  async current(@CurrentTenant() tenant: Tenant | null) {
    if (!tenant) throw new NotFoundException('Not a customer portal');
    const db = tenantDb(tenant.id);
    const [plan, users, campaigns, numbers, callsToday] = await Promise.all([
      tenant.planId ? prisma.plan.findUnique({ where: { id: tenant.planId } }) : null,
      db.user.count(),
      db.campaign.count(),
      db.phoneNumber.count({ where: { status: { in: ['ACTIVE', 'PENDING'] } } }),
      db.call.count({ where: { startedAt: { gte: startOfToday() } } }),
    ]);
    return {
      id: tenant.id,
      name: tenant.name,
      subdomain: tenant.subdomain,
      status: tenant.status,
      suspendReason: tenant.suspendReason,
      timezone: tenant.timezone,
      walletBalance: tenant.walletBalance,
      branding: tenant.branding,
      customDomain: tenant.customDomain,
      customDomainVerified: !!tenant.customDomainVerifiedAt,
      customDomainTarget: config.customDomainTarget,
      plan: plan && { code: plan.code, name: plan.name, monthlyPrice: plan.monthlyPrice, whiteLabel: plan.whiteLabel, customDomain: plan.customDomain },
      counts: { users, campaigns, numbers, callsToday },
    };
  }

  @Roles(Role.TENANT_ADMIN)
  @Patch('tenant/settings')
  async settings(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Body() dto: SettingsDto) {
    await prisma.tenant.update({ where: { id: tenant.id }, data: dto });
    await prisma.auditLog.create({ data: { tenantId: tenant.id, userId: me.sub, action: 'tenant.settings', meta: dto as object } });
    return { ok: true };
  }

  /**
   * Caddy "on-demand TLS" asks this before issuing a certificate, so certificates are
   * only created for real portals (stops anyone pointing random domains at the server).
   */
  @Public()
  @Get('internal/tls-check')
  async tlsCheck(@Query('domain') domain = '') {
    const d = domain.toLowerCase();
    const root = config.rootDomain;
    if (d === root || d === `app.${root}` || d === `api.${root}` || d === `www.${root}`) return { ok: true };
    if (d.endsWith(`.${root}`)) {
      const sub = d.slice(0, -(root.length + 1));
      if (!RESERVED_SUBDOMAINS.has(sub) && (await prisma.tenant.findUnique({ where: { subdomain: sub } }))) return { ok: true };
    } else if (await prisma.tenant.findFirst({ where: { customDomain: d, customDomainVerifiedAt: { not: null } } })) {
      return { ok: true };
    }
    throw new NotFoundException();
  }
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
