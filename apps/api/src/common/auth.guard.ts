import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { prisma, type Role } from '@viaroute/db';
import { IS_PUBLIC, ROLES } from './decorators';
import type { AppRequest, AuthUser } from './types';

/**
 * Global guard: every route needs a valid JWT unless marked @Public().
 * The token must belong to the same portal the request came from, so an
 * Acme token can never be used on another customer's portal.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException();

    let user: AuthUser;
    try {
      user = await this.jwt.verifyAsync<AuthUser>(token);
    } catch {
      throw new UnauthorizedException('Session expired, please log in again');
    }

    const portalTenantId = req.tenant?.id ?? null;
    if (user.tenantId !== portalTenantId) throw new UnauthorizedException('Wrong portal for this account');

    // Re-check the account on every request: removed users, changed roles and
    // password resets take effect immediately instead of when the token expires.
    const current = await prisma.user.findUnique({
      where: { id: user.sub },
      select: { tenantId: true, role: true, tokenVersion: true, passwordHash: true, publisherId: true, buyerId: true, timezone: true, disabledAt: true },
    });
    if (!current || current.tenantId !== user.tenantId || current.tokenVersion !== user.ver || !current.passwordHash || (current.disabledAt && !user.imp)) {
      throw new UnauthorizedException('Session expired, please log in again');
    }
    user.role = current.role;
    user.publisherId = current.publisherId;
    user.buyerId = current.buyerId;
    user.timezone = current.timezone;
    // Suspended accounts can still look around, sign out, and pay to reactivate.
    const allowedWhileSuspended = req.method === 'GET' || req.path.startsWith('/billing') || req.path.startsWith('/auth');
    if (req.tenant?.status === 'SUSPENDED' && !allowedWhileSuspended) {
      throw new ForbiddenException('Account suspended — please contact support');
    }

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, targets);
    if (roles?.length && !roles.includes(user.role)) throw new ForbiddenException();

    req.user = user;
    return true;
  }
}
