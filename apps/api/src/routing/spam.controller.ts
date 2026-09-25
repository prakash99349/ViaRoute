import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { prisma, Role, tenantDb, type Tenant } from '@viaroute/db';
import { CurrentTenant, Roles } from '../common/decorators';
import { SPAM_REASONS } from './spam.service';

class DaysDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  days = 30;
}

/** A customer's view of spam protection: what was blocked, why, and when. */
@Roles(Role.TENANT_ADMIN, Role.MANAGER)
@Controller('spam')
export class SpamController {
  @Get('overview')
  async overview(@CurrentTenant() tenant: Tenant, @Query() q: DaysDto) {
    const db = tenantDb(tenant.id);
    const since = new Date(Date.now() - (q.days - 1) * 86400_000);
    since.setUTCHours(0, 0, 0, 0);
    const blockedWhere = { startedAt: { gte: since }, rejectReason: { in: [...SPAM_REASONS] } };
    const [byReason, total, blocked, recent, daily, topCallers] = await Promise.all([
      db.call.groupBy({ by: ['rejectReason'], where: blockedWhere, _count: { _all: true } }),
      db.call.count({ where: { startedAt: { gte: since } } }),
      db.blockedNumber.groupBy({ by: ['auto'], _count: { _all: true } }),
      db.call.findMany({
        where: blockedWhere,
        orderBy: { startedAt: 'desc' },
        take: 25,
        select: { id: true, startedAt: true, callerNumber: true, callerState: true, rejectReason: true, spamScore: true, attestation: true, lineType: true, campaign: { select: { name: true } } },
      }),
      prisma.$queryRaw<{ day: string; n: bigint }[]>`
        SELECT to_char("startedAt", 'YYYY-MM-DD') AS day, count(*) AS n FROM "Call"
        WHERE "tenantId" = ${tenant.id}::uuid AND "startedAt" >= ${since} AND "rejectReason" = ANY(${[...SPAM_REASONS]}::text[])
        GROUP BY 1`,
      db.call.groupBy({ by: ['callerNumber'], where: blockedWhere, _count: { _all: true }, orderBy: { _count: { callerNumber: 'desc' } }, take: 10 }),
    ]);
    const byDay = new Map(daily.map((d) => [d.day, Number(d.n)]));
    const blockedCalls = byReason.reduce((s, r) => s + r._count._all, 0);
    return {
      days: q.days,
      totalCalls: total,
      blockedCalls,
      byReason: Object.fromEntries(byReason.map((r) => [r.rejectReason, r._count._all])),
      daily: Array.from({ length: q.days }, (_, i) => {
        const day = new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10);
        return { day, blocked: byDay.get(day) ?? 0 };
      }),
      blockedNumbers: {
        manual: blocked.find((b) => !b.auto)?._count._all ?? 0,
        auto: blocked.find((b) => b.auto)?._count._all ?? 0,
      },
      topCallers: topCallers.map((t) => ({ callerNumber: t.callerNumber, calls: t._count._all })),
      recent,
    };
  }
}
