// Runs before every test file: point the app at the test database, not your dev data.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://viaroute:viaroute@localhost:5432/viaroute_test?schema=public';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DISABLE_THROTTLE = '1';
process.env.NODE_ENV = 'test';
// Separate Redis database so tests never share queues or call state with a running dev server.
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
