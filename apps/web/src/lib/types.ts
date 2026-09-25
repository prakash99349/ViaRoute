export type Role = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MANAGER' | 'PUBLISHER' | 'BUYER' | 'AGENT';

/** Where each role lands after signing in. */
export const homeFor = (role: Role) => (role === 'SUPER_ADMIN' ? '/admin' : role === 'AGENT' ? '/softphone' : '/dashboard');
export type TenantStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
  emailVerified: boolean;
  twofaEnabled: boolean;
  /** Personal default timezone; null = the portal's. */
  timezone?: string | null;
  /** Set when the platform owner is viewing this account in support mode. */
  impersonatedBy?: string;
}

export interface Branding {
  portalName?: string;
  primaryColor?: string;
  logoUrl?: string;
}

export interface PortalInfo {
  platform: boolean;
  name: string;
  subdomain?: string;
  branding: Branding | null;
  /** Account timezone (reports, caps, hours). */
  timezone?: string;
}

export interface LoginResult {
  token?: string;
  user?: User;
  redirect?: { subdomain: string; handoffToken: string };
  twofaRequired?: boolean;
  challengeToken?: string;
}
