import type { Request } from 'express';
import type { Role, Tenant } from '@viaroute/db';

export interface AuthUser {
  sub: string;
  tenantId: string | null;
  role: Role;
  email: string;
  /** Must match User.tokenVersion; bumped on password change/reset to end old sessions. */
  ver: number;
  /** Set by AuthGuard for partner logins (not part of the token). */
  publisherId?: string | null;
  buyerId?: string | null;
  /** Personal default timezone (set by AuthGuard); null = the portal's. */
  timezone?: string | null;
  /** Support session: id and name of the super admin viewing this account. */
  imp?: string;
  impName?: string;
}

export interface AppRequest extends Request {
  /** Tenant resolved from the portal host. null = platform (super admin) host. */
  tenant: Tenant | null;
  user?: AuthUser;
}
