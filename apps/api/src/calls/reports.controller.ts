import { Controller, ForbiddenException, Get, Query, Res } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import type { Response } from 'express';
import { Prisma, prisma, Role, tenantDb, type Tenant } from '@viaroute/db';
import { CurrentTenant, CurrentUser, Roles } from '../common/decorators';
import type { AuthUser } from '../common/types';
import { CapsService } from '../routing/caps.service';
import { CallFilterDto, csvCell, filterWhere } from './calls.controller';

const GROUP_FIELD = { campaign: 'campaignId', publisher: 'publisherId', buyer: 'buyerId', target: 'targetId', number: 'phoneNumberId', state: 'callerState' } as const;
type GroupBy = keyof typeof GROUP_FIELD;

class ReportDto extends CallFilterDto {
  @IsOptional() @IsIn(Object.keys(GROUP_FIELD))
  groupBy?: GroupBy;
}

class ReportCsvDto extends CallFilterDto {
  @IsOptional() @IsIn([...Object.keys(GROUP_FIELD), 'day', 'hour'])
  groupBy?: GroupBy | 'day' | 'hour';
}

interface Bucket {
  calls: number;
  converted: number;
  revenue: number;
  payout: number;
  cost: number;
}

type Row = { calls: bigint; converted: bigint; revenue: Prisma.Decimal; payout: Prisma.Decimal; cost: Prisma.Decimal };

/** Longest range drawn day by day; "All time" starts at the first call instead. */
const MAX_DAYS = 400;

@Roles(Role.TENANT_ADMIN, Role.MANAGER, Role.PUBLISHER, Role.BUYER)
@Controller('reports')
export class ReportsController {
  constructor(private caps: CapsService) {}

  /** Totals, daily + hourly series for charts, and a breakdown table. */
  @Get('summary')
  summary(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthUser, @Query() q: ReportDto) {
    return this.build(tenant, user, q, q.groupBy ?? 'campaign');
  }

  /** The same report as a CSV: one row per day, hour, campaign, publisher, buyer, number or state. */
  @Get('summary.csv')
  async summaryCsv(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthUser, @Query() q: ReportCsvDto, @Res() res: Response) {
    const by = q.groupBy ?? 'day';
    const report = await this.build(tenant, user, q, by === 'day' || by === 'hour' ? 'campaign' : by);
    const money = ['revenue', 'payout', 'cost', 'profit'].filter((k) => k in report.totals);
    const labels: Record<string, string> = { revenue: user.role === Role.BUYER ? 'Spend' : 'Revenue', payout: 'Payout', cost: 'Usage cost', profit: 'Profit' };
    const first = { day: 'Day', hour: 'Hour', campaign: 'Campaign', publisher: 'Publisher', buyer: 'Buyer', target: 'Target', number: 'Tracking number', state: 'Caller state' }[by];

    type Line = { name: string; calls: number; converted: number; talkSec?: number } & Record<string, unknown>;
    const rows: Line[] =
      by === 'day' ? report.daily.map((d) => ({ ...d, name: d.day }))
      : by === 'hour' ? report.hourly.map((h) => ({ ...h, name: `${String(h.hour).padStart(2, '0')}:00` }))
      : report.breakdown.map((b) => ({ ...b }));

    const header = [first, 'Calls', 'Converted', 'Conversion %', ...(by === 'day' || by === 'hour' ? [] : ['Talk time (s)']), ...money.map((k) => labels[k])];
    const body = rows.map((r) => [
      r.name,
      r.calls,
      r.converted,
      r.calls ? ((r.converted / r.calls) * 100).toFixed(1) : '0.0',
      ...(by === 'day' || by === 'hour' ? [] : [r.talkSec ?? 0]),
      ...money.map((k) => Number(r[k] ?? 0).toFixed(2)),
    ]);
    const t = report.totals as Record<string, unknown>;
    body.push([
      'Total', report.totals.calls, report.totals.converted, (report.totals.conversionRate * 100).toFixed(1),
      ...(by === 'day' || by === 'hour' ? [] : [report.totals.talkSec]),
      ...money.map((k) => Number(t[k] ?? 0).toFixed(2)),
    ]);
    const csv = [header, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const day = (d: Date) => d.toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-by-${by}-${day(report.from)}_to_${day(report.to)}.csv"`);
    res.send('﻿' + csv);
  }

  /** How full each buyer is right now: live lines and today's calls against their caps. */
  @Roles(Role.TENANT_ADMIN, Role.MANAGER)
  @Get('capacity')
  async capacity(@CurrentTenant() tenant: Tenant) {
    const routes = await tenantDb(tenant.id).route.findMany({
      where: { active: true, campaign: { active: true }, OR: [{ buyerId: null }, { buyer: { active: true } }], AND: [{ OR: [{ targetId: null }, { target: { active: true } }] }] },
      include: { buyer: { select: { id: true, name: true } }, target: { select: { id: true, name: true } }, campaign: { select: { name: true } } },
    });
    const rows = await Promise.all(
      routes.map(async (r) => {
        const u = await this.caps.usage(r.id, tenant.timezone);
        const dayFill = r.dailyCap ? u.day / r.dailyCap : 0;
        const liveFill = r.concurrencyCap ? u.live / r.concurrencyCap : 0;
        return {
          routeId: r.id,
          buyer: r.buyer ?? { id: r.target!.id, name: r.target!.name },
          target: r.target,
          campaign: r.campaign.name,
          live: u.live,
          concurrencyCap: r.concurrencyCap,
          today: u.day,
          dailyCap: r.dailyCap,
          fill: Math.max(dayFill, liveFill),
        };
      }),
    );
    return rows.sort((a, b) => b.fill - a.fill || b.today - a.today);
  }

  // ---------------------------------------------------------------------------

  private async build(tenant: Tenant, user: AuthUser, q: CallFilterDto, groupBy: GroupBy) {
    // Partners only see their own side of the deal.
    if (user.role === Role.PUBLISHER && (groupBy === 'buyer' || groupBy === 'target')) throw new ForbiddenException();
    if (user.role === Role.BUYER && groupBy === 'publisher') throw new ForbiddenException();
    const db = tenantDb(tenant.id);
    const tz = q.tz ?? user.timezone ?? tenant.timezone;
    const where = filterWhere(q, user);
    const range = where.startedAt as { gte: Date; lte: Date };

    const [totals, converted, answered, ids, first] = await Promise.all([
      db.call.aggregate({ where, _count: { _all: true }, _sum: { revenue: true, payout: true, cost: true, connectedSec: true } }),
      db.call.count({ where: { ...where, converted: true } }),
      db.call.count({ where: { ...where, answeredAt: { not: null } } }),
      db.call.findMany({ where, select: { id: true } }).then((r) => r.map((x) => x.id)),
      db.call.aggregate({ where, _min: { startedAt: true } }),
    ]);

    // Very long ranges ("All time") are drawn from the first call, not from year 2000.
    let chartFrom = range.gte;
    if (range.lte.getTime() - range.gte.getTime() > MAX_DAYS * 86400_000) {
      chartFrom = first._min.startedAt ?? new Date(range.lte.getTime() - 30 * 86400_000);
      if (range.lte.getTime() - chartFrom.getTime() > MAX_DAYS * 86400_000) chartFrom = new Date(range.lte.getTime() - MAX_DAYS * 86400_000);
    }

    const [daily, hourly] = await Promise.all([this.daily(tenant.id, ids, tz, { gte: chartFrom, lte: range.lte }), this.hourly(tenant.id, ids, tz)]);

    const byRole = <T extends Bucket>({ revenue, payout, cost, ...d }: T) =>
      user.role === Role.PUBLISHER ? { ...d, payout }
      : user.role === Role.BUYER ? { ...d, revenue }
      : { ...d, revenue, payout, cost, profit: Math.round((revenue - payout - cost) * 100) / 100 };

    const field = GROUP_FIELD[groupBy];
    const groups = await db.call.groupBy({ by: [field], where, _count: { _all: true }, _sum: { revenue: true, payout: true, cost: true, connectedSec: true } });
    const convGroups = await db.call.groupBy({ by: [field], where: { ...where, converted: true }, _count: { _all: true } });
    const keyOf = (g: object) => (g as Record<string, unknown>)[field] as string | null;
    const conv = new Map(convGroups.map((g) => [keyOf(g), g._count._all]));
    const names = await this.names(tenant.id, groupBy, groups.map(keyOf));

    const money = (v: Prisma.Decimal | null) => v ?? new Prisma.Decimal(0);
    const hide = (row: { revenue: Prisma.Decimal; payout: Prisma.Decimal; cost: Prisma.Decimal }) => {
      const profit = row.revenue.sub(row.payout).sub(row.cost);
      if (user.role === Role.PUBLISHER) return { payout: row.payout };
      if (user.role === Role.BUYER) return { revenue: row.revenue };
      return { revenue: row.revenue, payout: row.payout, cost: row.cost, profit };
    };

    const calls = totals._count._all;
    return {
      from: range.gte,
      to: range.lte,
      timezone: tz,
      totals: {
        calls,
        answered,
        converted,
        conversionRate: calls ? converted / calls : 0,
        talkSec: totals._sum.connectedSec ?? 0,
        ...hide({ revenue: money(totals._sum.revenue), payout: money(totals._sum.payout), cost: money(totals._sum.cost) }),
      },
      daily: daily.map(byRole),
      /** Hour of day (0–23) in the chosen timezone, across the whole range. */
      hourly: hourly.map(byRole),
      groupBy,
      breakdown: groups
        .map((g) => {
          const id = keyOf(g);
          return {
            id,
            name: id ? names.get(id) ?? (groupBy === 'state' ? id : 'Deleted') : groupBy === 'state' ? 'Unknown / toll-free' : '(none)',
            calls: g._count._all,
            converted: conv.get(id) ?? 0,
            talkSec: g._sum.connectedSec ?? 0,
            ...hide({ revenue: money(g._sum.revenue), payout: money(g._sum.payout), cost: money(g._sum.cost) }),
          };
        })
        .sort((a, b) => b.calls - a.calls),
    };
  }

  private async hourly(tenantId: string, ids: string[], tz: string) {
    const rows = ids.length
      ? await prisma.$queryRaw<(Row & { hour: number })[]>`
          SELECT extract(hour FROM (("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}))::int AS hour,
                 count(*) AS calls, count(*) FILTER (WHERE converted) AS converted,
                 coalesce(sum(revenue), 0) AS revenue, coalesce(sum(payout), 0) AS payout, coalesce(sum(cost), 0) AS cost
          FROM "Call"
          WHERE "tenantId" = ${tenantId}::uuid AND id = ANY(${ids}::uuid[])
          GROUP BY 1`
      : [];
    const byHour = new Map(rows.map((r) => [Number(r.hour), r]));
    return Array.from({ length: 24 }, (_, hour) => ({ hour, ...bucket(byHour.get(hour)) }));
  }

  /** Per day in the chosen timezone, including empty days. */
  private async daily(tenantId: string, ids: string[], tz: string, range: { gte: Date; lte: Date }) {
    const rows = ids.length
      ? await prisma.$queryRaw<(Row & { day: string })[]>`
          SELECT to_char(("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
                 count(*) AS calls, count(*) FILTER (WHERE converted) AS converted,
                 coalesce(sum(revenue), 0) AS revenue, coalesce(sum(payout), 0) AS payout, coalesce(sum(cost), 0) AS cost
          FROM "Call"
          WHERE "tenantId" = ${tenantId}::uuid AND id = ANY(${ids}::uuid[])
          GROUP BY 1 ORDER BY 1`
      : [];
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const out: ({ day: string } & Bucket)[] = [];
    const seen = new Set<string>();
    // Step 6h so every local day is hit even across DST changes.
    for (let t = range.gte.getTime(); t <= range.lte.getTime() + 6 * 3600_000; t += 6 * 3600_000) {
      const day = fmt.format(new Date(Math.min(t, range.lte.getTime())));
      if (seen.has(day)) continue;
      seen.add(day);
      out.push({ day, ...bucket(byDay.get(day)) });
    }
    return out;
  }

  private async names(tenantId: string, groupBy: GroupBy, ids: (string | null)[]) {
    const list = ids.filter((x): x is string => !!x);
    if (groupBy === 'state') return new Map(list.map((s) => [s, s]));
    const db = tenantDb(tenantId);
    const rows: { id: string; name: string }[] =
      groupBy === 'campaign' ? await db.campaign.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })
      : groupBy === 'publisher' ? await db.publisher.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })
      : groupBy === 'buyer' ? await db.buyer.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })
      : groupBy === 'target' ? await db.target.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })
      : (await db.phoneNumber.findMany({ where: { id: { in: list } }, select: { id: true, e164: true, label: true } })).map((n) => ({
          id: n.id,
          name: n.label ? `${n.e164} (${n.label})` : n.e164,
        }));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}

function bucket(r?: Row): Bucket {
  return {
    calls: Number(r?.calls ?? 0),
    converted: Number(r?.converted ?? 0),
    revenue: Number(r?.revenue ?? 0),
    payout: Number(r?.payout ?? 0),
    cost: Number(r?.cost ?? 0),
  };
}
