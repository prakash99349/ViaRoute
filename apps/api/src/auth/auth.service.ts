import { BadRequestException, ForbiddenException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthTokenType, prisma, Role, Tenant, TenantStatus, User } from '@viaroute/db';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { decrypt, encrypt } from '../common/crypto';
import type { AuthUser } from '../common/types';
import { config, portalOrigin, RESERVED_SUBDOMAINS } from '../config';
import { defaultPlan } from '../cli/bootstrap-admin';
import { MailService } from '../mail/mail.service';
import type { LoginDto, SignupDto } from './dto';
import { TokensService } from './tokens.service';

const HANDOFF_TTL = '2m';
const TWOFA_CHALLENGE_TTL = '5m';
const BCRYPT_ROUNDS = 12;
// Compared against when the email doesn't exist, so timing doesn't leak which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

authenticator.options = { window: 1 }; // accept codes from ±30s for clock drift

export interface LoginResult {
  /** Session token for the portal the user logged in on. */
  token?: string;
  user?: PublicUser;
  /** Set when the user must continue on their own portal (e.g. after signup). */
  redirect?: { subdomain: string; handoffToken: string };
  /** Set when the password was right but a 2FA code is still needed. */
  twofaRequired?: boolean;
  challengeToken?: string;
}

export type PublicUser = Pick<User, 'id' | 'email' | 'name' | 'role' | 'tenantId' | 'emailVerified' | 'twofaEnabled' | 'timezone'> & {
  /** Set when the platform owner is viewing this account in support mode. */
  impersonatedBy?: string;
};

@Injectable()
export class AuthService {
  constructor(private jwt: JwtService, private tokens: TokensService, private mail: MailService) {}

  // ---------------------------------------------------------------------------
  // Signup & login
  // ---------------------------------------------------------------------------

  async signup(dto: SignupDto): Promise<LoginResult> {
    if (RESERVED_SUBDOMAINS.has(dto.subdomain)) throw new ConflictException('That subdomain is reserved');
    if (await prisma.tenant.findUnique({ where: { subdomain: dto.subdomain } })) {
      throw new ConflictException('That subdomain is already taken');
    }

    const starter = await defaultPlan();
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const { tenant, user } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: dto.companyName,
          subdomain: dto.subdomain,
          status: TenantStatus.TRIAL,
          planId: starter?.id,
          trialEndsAt: new Date(Date.now() + config.trialDays * 86400_000),
        },
      });
      const user = await tx.user.create({
        data: { tenantId: tenant.id, email: dto.email, name: dto.name, passwordHash, role: Role.TENANT_ADMIN },
      });
      await tx.auditLog.create({ data: { tenantId: tenant.id, userId: user.id, action: 'tenant.signup' } });
      return { tenant, user };
    });

    await this.sendVerification(user, tenant);
    return { redirect: { subdomain: tenant.subdomain, handoffToken: await this.handoffToken(user) } };
  }

  /**
   * On a customer portal: log in a user of that tenant.
   * On the platform host: log in the super admin, or send a customer to their own portal.
   */
  async login(dto: LoginDto, portal: Tenant | null): Promise<LoginResult> {
    if (portal) {
      const user = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: portal.id, email: dto.email } } });
      await this.checkPassword(user, dto.password);
      return this.completeLogin(user!);
    }

    const admin = await prisma.user.findFirst({ where: { tenantId: null, email: dto.email, role: Role.SUPER_ADMIN } });
    if (admin) {
      await this.checkPassword(admin, dto.password);
      return this.completeLogin(admin);
    }

    // Customer logged in on the main site: find their portal and hand them over.
    const candidates = await prisma.user.findMany({
      where: { email: dto.email, tenantId: { not: null }, passwordHash: { not: null } },
      include: { tenant: true },
    });
    for (const u of candidates) {
      if (u.tenant && (await bcrypt.compare(dto.password, u.passwordHash!))) {
        // 2FA is asked on their own portal after the handoff.
        return { redirect: { subdomain: u.tenant.subdomain, handoffToken: await this.handoffToken(u) } };
      }
    }
    throw new UnauthorizedException('Invalid email or password');
  }

  /** Exchange a short-lived handoff token (from signup/redirect) for a portal session. */
  async redeemHandoff(handoffToken: string, portal: Tenant | null): Promise<LoginResult> {
    const payload = await this.verifyPurpose(handoffToken, 'handoff');
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !portal || user.tenantId !== portal.id) throw new UnauthorizedException();
    // Support login by the platform owner: they already authenticated (incl. their own 2FA).
    if (payload.imp) return this.session(user, { imp: payload.imp, impName: payload.impName ?? 'Support' });
    return this.completeLogin(user);
  }

  /** Super admin → one-time link into a customer's portal as its admin (support mode, 1 hour). */
  async impersonate(admin: AuthUser, tenantId: string) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new BadRequestException('Customer not found');
    const target = await prisma.user.findFirst({
      where: { tenantId, role: Role.TENANT_ADMIN, passwordHash: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    if (!target) throw new BadRequestException('This customer has no active admin to log in as');
    const me = await prisma.user.findUniqueOrThrow({ where: { id: admin.sub }, select: { name: true } });
    await prisma.auditLog.create({ data: { tenantId, userId: admin.sub, action: 'support.impersonate', entity: 'User', entityId: target.id } });
    const handoffToken = await this.jwt.signAsync({ sub: target.id, purpose: 'handoff', imp: admin.sub, impName: me.name }, { expiresIn: HANDOFF_TTL });
    return { subdomain: tenant.subdomain, handoffToken };
  }

  /** Second login step when 2FA is on. */
  async verifyTwofaLogin(challengeToken: string, code: string, portal: Tenant | null): Promise<LoginResult> {
    const payload = await this.verifyPurpose(challengeToken, '2fa');
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.tenantId !== (portal?.id ?? null) || !user.twofaEnabled || !user.twofaSecret) {
      throw new UnauthorizedException();
    }
    if (!authenticator.check(code, decrypt(user.twofaSecret))) {
      throw new UnauthorizedException('Invalid code, please try again');
    }
    return this.session(user);
  }

  async me(auth: AuthUser): Promise<PublicUser> {
    const user = await prisma.user.findUnique({ where: { id: auth.sub } });
    if (!user) throw new UnauthorizedException();
    return { ...toPublic(user), ...(auth.imp ? { impersonatedBy: auth.impName ?? 'Support' } : {}) };
  }

  /** Personal preferences: display name and default timezone (null = the portal's). */
  async updateProfile(auth: AuthUser, dto: { name?: string; timezone?: string | null }) {
    const user = await prisma.user.update({ where: { id: auth.sub }, data: { name: dto.name, timezone: dto.timezone } });
    return toPublic(user);
  }

  // ---------------------------------------------------------------------------
  // Email verification
  // ---------------------------------------------------------------------------

  async resendVerification(auth: AuthUser) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.sub }, include: { tenant: true } });
    if (user.emailVerified) return { ok: true, alreadyVerified: true };
    await this.sendVerification(user, user.tenant);
    return { ok: true };
  }

  async verifyEmail(token: string, portal: Tenant | null) {
    const user = await this.tokens.consume(token, AuthTokenType.VERIFY_EMAIL);
    assertSamePortal(user, portal);
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Passwords
  // ---------------------------------------------------------------------------

  /** Always answers the same way, so it can't be used to discover which emails have accounts. */
  async forgotPassword(email: string, portal: Tenant | null) {
    const user = portal
      ? await prisma.user.findUnique({ where: { tenantId_email: { tenantId: portal.id, email } } })
      : await prisma.user.findFirst({ where: { tenantId: null, email } });

    if (user) {
      const raw = await this.tokens.issue(user.id, AuthTokenType.RESET_PASSWORD);
      const brand = brandOf(portal);
      await this.mail.sendAction({
        to: user.email,
        subject: `Reset your ${brand.name} password`,
        brand,
        heading: 'Reset your password',
        body: `Hi ${user.name}, we received a request to reset your password. Click below to choose a new one.`,
        buttonText: 'Choose a new password',
        url: `${portalOrigin(portal)}/reset-password#t=${raw}`,
        footnote: "This link expires in 1 hour. If you didn't ask for this, you can ignore this email.",
      });
    }
    return { ok: true };
  }

  async resetPassword(token: string, password: string, portal: Tenant | null) {
    const user = await this.tokens.consume(token, AuthTokenType.RESET_PASSWORD);
    assertSamePortal(user, portal);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        tokenVersion: { increment: 1 }, // log out every existing session
        emailVerified: true, // they proved they own the inbox
      },
    });
    await audit(user, 'user.password_reset');
    return { ok: true };
  }

  async changePassword(auth: AuthUser, currentPassword: string, newPassword: string): Promise<LoginResult> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.sub } });
    if (!user.passwordHash || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS), tokenVersion: { increment: 1 } },
    });
    await audit(user, 'user.password_change');
    return this.session(updated); // keep this device logged in; all others are logged out
  }

  // ---------------------------------------------------------------------------
  // Invites
  // ---------------------------------------------------------------------------

  async acceptInvite(token: string, password: string, name: string | undefined, portal: Tenant | null): Promise<LoginResult> {
    const invited = await this.tokens.consume(token, AuthTokenType.INVITE);
    assertSamePortal(invited, portal);
    const user = await prisma.user.update({
      where: { id: invited.id },
      data: {
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        emailVerified: true,
        ...(name ? { name } : {}),
      },
    });
    await audit(user, 'user.invite_accepted');
    return this.session(user);
  }

  // ---------------------------------------------------------------------------
  // Two-factor authentication (TOTP: Google Authenticator, Authy, 1Password…)
  // ---------------------------------------------------------------------------

  async twofaSetup(auth: AuthUser) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.sub }, include: { tenant: true } });
    if (user.twofaEnabled) throw new BadRequestException('Two-factor authentication is already on');

    const secret = authenticator.generateSecret();
    await prisma.user.update({ where: { id: user.id }, data: { twofaSecret: encrypt(secret) } });

    const issuer = user.tenant?.name ?? 'ViaRoute';
    const otpauthUrl = authenticator.keyuri(user.email, issuer, secret);
    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }) };
  }

  async twofaEnable(auth: AuthUser, code: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.sub } });
    if (!user.twofaSecret) throw new BadRequestException('Start setup first');
    if (!authenticator.check(code, decrypt(user.twofaSecret))) throw new BadRequestException('Invalid code, please try again');
    await prisma.user.update({ where: { id: user.id }, data: { twofaEnabled: true } });
    await audit(user, 'user.2fa_enabled');
    return { ok: true };
  }

  async twofaDisable(auth: AuthUser, password: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.sub } });
    if (!user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new BadRequestException('Password is incorrect');
    }
    await prisma.user.update({ where: { id: user.id }, data: { twofaEnabled: false, twofaSecret: null } });
    await audit(user, 'user.2fa_disabled');
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async sendVerification(user: User, tenant: Tenant | null) {
    const raw = await this.tokens.issue(user.id, AuthTokenType.VERIFY_EMAIL);
    const brand = brandOf(tenant);
    await this.mail.sendAction({
      to: user.email,
      subject: `Confirm your email for ${brand.name}`,
      brand,
      heading: `Welcome, ${user.name}!`,
      body: 'Please confirm your email address to secure your account.',
      buttonText: 'Confirm email',
      url: `${portalOrigin(tenant)}/verify-email#t=${raw}`,
      footnote: 'This link expires in 3 days.',
    });
  }

  private async checkPassword(user: User | null, password: string) {
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user?.passwordHash || !ok) throw new UnauthorizedException('Invalid email or password');
  }

  private async completeLogin(user: User): Promise<LoginResult> {
    if (user.disabledAt) throw new ForbiddenException('This login has been disabled. Contact your account admin.');
    if (user.twofaEnabled) {
      const challengeToken = await this.jwt.signAsync({ sub: user.id, purpose: '2fa' }, { expiresIn: TWOFA_CHALLENGE_TTL });
      return { twofaRequired: true, challengeToken };
    }
    return this.session(user);
  }

  private async session(user: User, support?: { imp: string; impName: string }): Promise<LoginResult> {
    const payload: AuthUser = { sub: user.id, tenantId: user.tenantId, role: user.role, email: user.email, ver: user.tokenVersion, ...support };
    if (support) {
      return { token: await this.jwt.signAsync(payload, { expiresIn: '1h' }), user: { ...toPublic(user), impersonatedBy: support.impName } };
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return { token: await this.jwt.signAsync(payload), user: toPublic(user) };
  }

  private handoffToken(user: User) {
    return this.jwt.signAsync({ sub: user.id, purpose: 'handoff' }, { expiresIn: HANDOFF_TTL });
  }

  private async verifyPurpose(token: string, purpose: string): Promise<{ sub: string; imp?: string; impName?: string }> {
    let payload: { sub: string; purpose?: string; imp?: string; impName?: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('This step has expired, please log in again');
    }
    if (payload.purpose !== purpose) throw new UnauthorizedException();
    return payload;
  }
}

export function toPublic(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    tenantId: u.tenantId,
    emailVerified: u.emailVerified,
    twofaEnabled: u.twofaEnabled,
    timezone: u.timezone,
  };
}

/** Name and color for emails: the customer's white-label brand, or ViaRoute when they have none. */
export function brandOf(tenant: Tenant | null) {
  const b = (tenant?.branding ?? {}) as { portalName?: string; primaryColor?: string; logoUrl?: string };
  const whiteLabeled = !!(b.portalName || b.primaryColor || b.logoUrl);
  return { name: whiteLabeled ? b.portalName ?? tenant!.name : 'ViaRoute', color: b.primaryColor };
}

/** Email links only work on the portal the account belongs to. */
function assertSamePortal(user: User, portal: Tenant | null) {
  if (user.tenantId !== (portal?.id ?? null)) throw new BadRequestException('This link is invalid or has expired');
}

function audit(user: User, action: string) {
  return prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.id, action } });
}
