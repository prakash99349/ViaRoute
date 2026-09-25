import bcrypt from 'bcryptjs';
import { prisma, Role } from '@viaroute/db';

export const DEFAULT_PLANS = [
  { code: 'starter', name: 'Starter', monthlyPrice: 99, perMinuteRate: 0.025, includedNumbers: 5, maxUsers: 3, whiteLabel: false, customDomain: false },
  { code: 'pro', name: 'Pro', monthlyPrice: 299, perMinuteRate: 0.02, includedNumbers: 25, maxUsers: 10, whiteLabel: true, customDomain: false },
  { code: 'enterprise', name: 'Enterprise', monthlyPrice: 0, perMinuteRate: 0.015, includedNumbers: 100, maxUsers: null, whiteLabel: true, customDomain: true },
];

/** Creates the default plans (never overwriting edited ones). */
export async function ensurePlans() {
  for (const p of DEFAULT_PLANS) await prisma.plan.upsert({ where: { code: p.code }, update: {}, create: p });
}

/**
 * Creates the Super Admin. With `reset`, an existing one gets the new password (and is signed out);
 * without it, an existing admin is left alone. Returns what happened.
 */
export async function ensureSuperAdmin(email: string, password: string, reset: boolean): Promise<'created' | 'reset' | 'exists'> {
  const existing = await prisma.user.findFirst({ where: { tenantId: null, email: email.toLowerCase() } });
  if (existing && !reset) return 'exists';
  const passwordHash = await bcrypt.hash(password, 12);
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, tokenVersion: { increment: 1 } } });
    return 'reset';
  }
  await prisma.user.create({ data: { email: email.toLowerCase(), name: 'Super Admin', role: Role.SUPER_ADMIN, passwordHash, emailVerified: true } });
  return 'created';
}
