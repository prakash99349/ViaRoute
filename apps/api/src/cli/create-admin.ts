/**
 * First-time production setup: creates (or resets) the Super Admin and the default plans.
 *
 *   docker compose -f infra/docker-compose.prod.yml exec api node dist/cli/create-admin.js you@example.com 'a-long-password'
 */
import '../config';
import bcrypt from 'bcryptjs';
import { prisma, Role } from '@viaroute/db';

const DEFAULT_PLANS = [
  { code: 'starter', name: 'Starter', monthlyPrice: 99, perMinuteRate: 0.025, includedNumbers: 5, maxUsers: 3, whiteLabel: false, customDomain: false },
  { code: 'pro', name: 'Pro', monthlyPrice: 299, perMinuteRate: 0.02, includedNumbers: 25, maxUsers: 10, whiteLabel: true, customDomain: false },
  { code: 'enterprise', name: 'Enterprise', monthlyPrice: 0, perMinuteRate: 0.015, includedNumbers: 100, maxUsers: null, whiteLabel: true, customDomain: true },
];

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password || password.length < 12) {
    console.error('Usage: node dist/cli/create-admin.js <email> <password (12+ characters)>');
    process.exit(1);
  }

  for (const p of DEFAULT_PLANS) {
    await prisma.plan.upsert({ where: { code: p.code }, update: {}, create: p }); // never overwrites edited plans
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await prisma.user.findFirst({ where: { tenantId: null, email: email.toLowerCase() } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, tokenVersion: { increment: 1 } } });
    console.log(`✅ Password reset for Super Admin ${email}`);
  } else {
    await prisma.user.create({
      data: { email: email.toLowerCase(), name: 'Super Admin', role: Role.SUPER_ADMIN, passwordHash, emailVerified: true },
    });
    console.log(`✅ Super Admin ${email} created`);
  }
  console.log('✅ Plans ready: starter, pro, enterprise');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
