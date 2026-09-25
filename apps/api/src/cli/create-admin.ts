/**
 * First-time production setup: creates (or resets) the Super Admin and the default plans.
 *
 *   docker compose -f infra/docker-compose.prod.yml exec api node dist/cli/create-admin.js you@example.com 'a-long-password'
 *
 * On platforms without a terminal, set ADMIN_EMAIL and ADMIN_PASSWORD instead: the API creates the
 * admin on start-up (see main.ts).
 */
import '../config';
import { prisma } from '@viaroute/db';
import { ensurePlans, ensureSuperAdmin } from './bootstrap-admin';

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password || password.length < 12) {
    console.error('Usage: node dist/cli/create-admin.js <email> <password (12+ characters)>');
    process.exit(1);
  }
  await ensurePlans();
  const result = await ensureSuperAdmin(email, password, true);
  console.log(result === 'reset' ? `✅ Password reset for Super Admin ${email}` : `✅ Super Admin ${email} created`);
  console.log('✅ Plans ready: pay as you go');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
