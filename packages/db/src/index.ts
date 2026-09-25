import { Prisma, PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Unscoped client. Use only for platform-level work (super admin, auth, webhooks). */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'] });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/** Models that belong to a tenant. Every query on these gets `tenantId` injected. */
export const TENANT_MODELS = [
  'Campaign',
  'Publisher',
  'Buyer',
  'Route',
  'Target',
  'PhoneNumber',
  'Call',
  'Postback',
  'Transaction',
  'AuditLog',
  'User',
  'BlockedNumber',
  'Notification',
] as const;

const TENANT_MODEL_SET = new Set<string>(TENANT_MODELS);

const WHERE_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

// findUnique/update/delete use a unique `where`; Prisma allows extra non-unique filters there.
const UNIQUE_WHERE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete']);

/**
 * Returns a Prisma client that can only see and write one tenant's rows.
 * Reads are filtered by tenantId, creates are stamped with it, and
 * updates/deletes can't touch other tenants' rows.
 */
export function tenantDb(tenantId: string) {
  if (!tenantId) throw new Error('tenantDb() requires a tenantId');

  return prisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_MODEL_SET.has(model)) return query(args);
          const a = (args ?? {}) as Record<string, any>;

          if (WHERE_OPS.has(operation) || UNIQUE_WHERE_OPS.has(operation)) {
            a.where = { ...(a.where ?? {}), tenantId };
          }
          if (operation === 'create') {
            a.data = { ...(a.data ?? {}), tenantId };
          }
          if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const rows = Array.isArray(a.data) ? a.data : [a.data];
            a.data = rows.map((r: object) => ({ ...r, tenantId }));
          }
          if (operation === 'upsert') {
            a.where = { ...(a.where ?? {}), tenantId };
            a.create = { ...(a.create ?? {}), tenantId };
          }
          return query(a);
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof tenantDb>;
export { Prisma };
