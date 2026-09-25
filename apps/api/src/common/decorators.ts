import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@viaroute/db';
import type { AppRequest } from './types';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

/** Skip the auth guard for this route. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Only these roles may call the route. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().user!,
);

export const CurrentTenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AppRequest>().tenant,
);
