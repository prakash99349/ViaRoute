import { execSync } from 'child_process';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';
import { TEST_DATABASE_URL } from './env';

/** Creates the test database if needed and applies all migrations. */
export default async function globalSetup() {
  const admin = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL.replace(/\/[^/?]+(\?|$)/, '/postgres$1') });
  try {
    await admin.$executeRawUnsafe('CREATE DATABASE viaroute_test');
  } catch (e) {
    if (!String(e).includes('already exists')) throw e;
  } finally {
    await admin.$disconnect();
  }
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(__dirname, '../../../packages/db'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'ignore',
  });
}
