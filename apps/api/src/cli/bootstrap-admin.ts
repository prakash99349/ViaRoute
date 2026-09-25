import bcrypt from 'bcryptjs';
import { prisma, Role } from '@viaroute/db';

/** Pay as you go: no monthly fee — customers pay per call minute and per number. More plans can be added in Admin → Plans. */
export const DEFAULT_PLANS = [
  { code: 'payg', name: 'Pay as you go', monthlyPrice: 0, perMinuteRate: 0.025, includedNumbers: 0, maxUsers: null, whiteLabel: true, customDomain: true },
];

/** The plan new customers start on: Pay as you go, else the cheapest active plan. */
export async function defaultPlan() {
  return (
    (await prisma.plan.findFirst({ where: { code: 'payg', active: true } })) ??
    (await prisma.plan.findFirst({ where: { active: true }, orderBy: { monthlyPrice: 'asc' } }))
  );
}

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
