import { PrismaClient, Role, TenantStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SUPER_ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'admin@viaroute.local';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'ViaRoute123!';

async function main() {
  const plans = [
    { code: 'starter', name: 'Starter', monthlyPrice: 99, perMinuteRate: 0.025, includedNumbers: 5, maxUsers: 3, whiteLabel: false, customDomain: false },
    { code: 'pro', name: 'Pro', monthlyPrice: 299, perMinuteRate: 0.02, includedNumbers: 25, maxUsers: 10, whiteLabel: true, customDomain: false },
    { code: 'enterprise', name: 'Enterprise', monthlyPrice: 0, perMinuteRate: 0.015, includedNumbers: 100, maxUsers: null, whiteLabel: true, customDomain: true },
  ];
  for (const p of plans) {
    await prisma.plan.upsert({ where: { code: p.code }, update: p, create: p });
  }
  const pro = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } });

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  // Super admin has no tenant; the compound unique can't match a null tenantId, so look up by email.
  const existingAdmin = await prisma.user.findFirst({ where: { tenantId: null, email: SUPER_ADMIN_EMAIL } });
  if (!existingAdmin) {
    await prisma.user.create({
      data: { email: SUPER_ADMIN_EMAIL, passwordHash, name: 'Super Admin', role: Role.SUPER_ADMIN, emailVerified: true },
    });
  }

  const acme = await prisma.tenant.upsert({
    where: { subdomain: 'acme' },
    update: { billingRenewsAt: new Date(Date.now() + 30 * 86400_000) },
    create: {
      name: 'Acme Leads',
      subdomain: 'acme',
      status: TenantStatus.ACTIVE,
      planId: pro.id,
      walletBalance: 50,
      billingRenewsAt: new Date(Date.now() + 30 * 86400_000),
      branding: { portalName: 'Acme Call Portal' },
    },
  });

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: acme.id, email: 'owner@acme.test' } },
    update: {},
    create: {
      tenantId: acme.id,
      email: 'owner@acme.test',
      passwordHash,
      name: 'Acme Owner',
      role: Role.TENANT_ADMIN,
      emailVerified: true,
    },
  });

  console.log('\n✅ Seed complete');
  console.log(`   Super admin : ${SUPER_ADMIN_EMAIL}  →  http://localhost:3000/login`);
  console.log('   Demo tenant : owner@acme.test      →  http://acme.localhost:3000/login');
  console.log(`   Password    : ${DEMO_PASSWORD}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
