'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, BellRing, Briefcase, CircleCheck, CircleDollarSign, Clock, Download, Hash, Megaphone,
  MoreHorizontal, PhoneCall, PhoneIncoming, PhoneOutgoing, Plus, Target, TrendingUp, UserPlus, Wallet,
} from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { BarChart, Legend, Sparkline, type Series } from '@/components/charts';
import { DateRangePicker } from '@/components/date-range-picker';
import { Alert, Button, Card, CardHeader, Delta, Empty, IconTile, Initials, Stat, StatStrip, table } from '@/components/ui';
import { api, download, duration, formatPhone, money } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { comparisonLabel, isSingleDay, makeRange, previousQuery, rangeLabel, rangeQuery, useDateRange } from '@/lib/date-range';
import { useApi } from '@/lib/use-api';

// ---------------------------------------------------------------------------
// Types

interface Point {
  calls: number;
  converted: number;
  revenue?: number;
  payout?: number;
  cost?: number;
  profit?: number;
}

interface Summary {
  totals: { calls: number; answered: number; converted: number; conversionRate: number; talkSec: number; revenue?: string; payout?: string; profit?: string };
  daily: (Point & { day: string })[];
  hourly: (Point & { hour: number })[];
  breakdown: { id: string | null; name: string; calls: number; converted: number; talkSec: number; revenue?: string; payout?: string; profit?: string }[];
}

interface LiveCall {
  id: string;
  callerNumber: string;
  callerState: string | null;
  status: 'RINGING' | 'IN_PROGRESS';
  startedAt: string;
  answeredAt: string | null;
  campaign: { name: string } | null;
  buyer: { name: string } | null;
}

interface CampaignMeta {
  id: string;
  name: string;
  active: boolean;
  _count: { routes: number; phoneNumbers: number };
}

interface Capacity {
  routeId: string;
  buyer: { id: string; name: string };
  campaign: string;
  live: number;
  concurrencyCap: number | null;
  today: number;
  dailyCap: number | null;
  fill: number;
}

interface Note {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers

const pct = (a: number, b: number) => (b ? ((a - b) / b) * 100 : null);
const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function elapsed(fromIso: string, now: number) {
  return duration((now - new Date(fromIso).getTime()) / 1000);
}

// ---------------------------------------------------------------------------
// Pieces

function LiveNow({ calls, now }: { calls: LiveCall[] | null; now: number }) {
  const talking = calls?.filter((c) => c.status === 'IN_PROGRESS').length ?? 0;
  const ringing = (calls?.length ?? 0) - talking;
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className={`h-2 w-2 rounded-full ${calls?.length ? 'animate-pulse bg-success ring-4 ring-success-bg' : 'bg-border-strong'}`} aria-hidden />
            Live now
          </span>
        }
      >
        <span className="text-xs text-muted">{calls?.length ? `${talking} talking · ${ringing} ringing` : 'Quiet right now'}</span>
      </CardHeader>
      <div className="mt-2 flex-1" aria-live="polite">
        {calls?.length === 0 && (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center text-sm text-muted">
            <PhoneCall size={22} strokeWidth={1.75} className="text-faint" aria-hidden />
            No calls in progress
          </div>
        )}
        {calls?.slice(0, 6).map((c) => {
          const talkingNow = c.status === 'IN_PROGRESS';
          return (
            <div key={c.id} className="flex items-center gap-3 border-t border-border py-2.5 first:border-0">
              <IconTile icon={talkingNow ? PhoneIncoming : BellRing} tone={talkingNow ? 'green' : 'yellow'} size={32} />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13px]">
                  {formatPhone(c.callerNumber)} {c.callerState && <span className="font-sans text-faint">{c.callerState}</span>}
                </div>
                <div className="truncate text-xs text-muted">
                  {talkingNow ? `${c.campaign?.name ?? 'Campaign'} → ${c.buyer?.name ?? 'buyer'}` : `Ringing ${c.buyer?.name ?? 'a buyer'}`}
                </div>
              </div>
              <span className={`font-mono text-[13px] tabular ${talkingNow ? '' : 'text-warning'}`}>{elapsed(c.answeredAt ?? c.startedAt, now)}</span>
            </div>
          );
        })}
      </div>
      <Link href="/calls" className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent">
        Open call logs <ArrowRight size={14} aria-hidden />
      </Link>
    </Card>
  );
}

function CapacityCard({ rows }: { rows: Capacity[] | null }) {
  // One line per buyer: their fullest route.
  const byBuyer = new Map<string, Capacity>();
  for (const r of rows ?? []) if (!byBuyer.has(r.buyer.id)) byBuyer.set(r.buyer.id, r);
  const list = [...byBuyer.values()].slice(0, 4);
  return (
    <Card>
      <CardHeader title="Buyer capacity">
        <span className="text-xs text-faint">today</span>
      </CardHeader>
      <div className="mt-4 space-y-4">
        {rows && list.length === 0 && <p className="text-sm text-muted">Add buyers to a campaign to see how full they are.</p>}
        {list.map((r) => {
          const capped = r.dailyCap !== null;
          const nearly = r.fill >= 0.9;
          const width = capped ? Math.min(100, (r.today / r.dailyCap!) * 100) : r.concurrencyCap ? Math.min(100, (r.live / r.concurrencyCap) * 100) : 0;
          return (
            <div key={r.routeId} className="space-y-1.5">
              <div className="flex items-center gap-2 text-[13px]">
                <span className="flex-1 truncate font-medium">{r.buyer.name}</span>
                <span className="font-mono text-muted tabular">{capped ? `${r.today} / ${r.dailyCap}` : `${r.today} calls`}</span>
              </div>
              <div className="h-1.5 rounded-full bg-subtle">
                <div className={`h-1.5 rounded-full ${nearly ? 'bg-warning' : 'bg-series-1'}`} style={{ width: `${width}%` }} />
              </div>
              <div className={`text-xs ${nearly ? 'text-warning' : 'text-muted'}`}>
                {nearly ? 'Almost full — extra calls go to the next buyer' : r.concurrencyCap ? `${r.live} of ${r.concurrencyCap} lines busy` : capped ? `${r.dailyCap! - r.today} calls left today` : 'No daily cap'}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function QuickActions() {
  const actions = [
    { href: '/numbers', label: 'Buy number', icon: Hash },
    { href: '/buyers', label: 'Add buyer', icon: Briefcase },
    { href: '/publishers', label: 'Add publisher', icon: Megaphone },
    { href: '/team', label: 'Invite team', icon: UserPlus },
  ];
  return (
    <Card>
      <CardHeader title="Quick actions" />
      <div className="mt-3 grid grid-cols-2 gap-2">
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <Link key={a.href} href={a.href} className="flex h-11 items-center gap-2.5 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-subtle">
              <Icon size={16} strokeWidth={1.75} className="text-muted" aria-hidden />
              {a.label}
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function DashboardContent() {
  const { user } = useAuth();
  const role = user!.role;
  const staff = role === 'TENANT_ADMIN' || role === 'MANAGER';
  const { range, setRange, ready } = useDateRange('today');
  const [metric, setMetric] = useState<'calls' | 'revenue' | 'profit'>('calls');
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState<LiveCall[] | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const q = useMemo(() => rangeQuery(range), [range]);
  const prevQ = useMemo(() => previousQuery(range), [range]);
  const single = isSingleDay(range);
  const compare = comparisonLabel(range);
  const { data: s, error } = useApi<Summary>(ready ? `/reports/summary?${q}&groupBy=campaign` : null);
  const { data: prev } = useApi<Summary>(ready && range.preset !== 'all' ? `/reports/summary?${prevQ}` : null);
  // Sparklines: the last 7 days when looking at a single day.
  const weekQ = useMemo(() => rangeQuery(makeRange('7d', range.tz)), [range.tz]);
  const { data: trend } = useApi<Summary>(ready && single ? `/reports/summary?${weekQ}` : null);
  const { data: campaigns } = useApi<CampaignMeta[]>(staff ? '/campaigns' : null);
  const { data: capacity } = useApi<Capacity[]>(staff ? '/reports/capacity' : null);
  const { data: notes } = useApi<{ items: Note[] }>(staff ? '/notifications' : null);

  // Live calls refresh every 5s; the clock ticks every second for the timers.
  useEffect(() => {
    let stop = false;
    const load = () => api<LiveCall[]>('/calls/live').then((c) => !stop && setLive(c)).catch(() => {});
    load();
    const a = setInterval(load, 5000);
    const b = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(a);
      clearInterval(b);
    };
  }, []);

  const t = s?.totals;
  const p = prev?.totals;
  const spark = (single ? trend?.daily : s?.daily) ?? [];
  const sparkOf = (k: keyof Point) => spark.map((d) => Number(d[k] ?? 0));
  const moneyKey = role === 'PUBLISHER' ? 'payout' : role === 'BUYER' ? 'revenue' : 'profit';

  // The most relevant recent alert: a buyer at its cap, or money running low.
  const alert = notes?.items.find(
    (n) => (n.type === 'cap_reached' || n.type === 'low_balance' || n.type === 'suspended') && now - new Date(n.createdAt).getTime() < 24 * 3600_000,
  );

  const firstCampaign = campaigns?.find((c) => c.active && c._count.routes && c._count.phoneNumbers);
  const metaById = new Map(campaigns?.map((c) => [c.id, c]));
  const convertedDelta = t && p ? pct(t.converted, p.converted) : null;

  const chartData = single ? s?.hourly ?? [] : s?.daily ?? [];
  const callSeries: Series[] = [
    { key: 'converted', label: 'Converted', color: 'var(--series-1)' },
    { key: 'other', label: 'Not converted', color: 'var(--series-1-soft)' },
  ];
  const moneySeries: Series[] = [{ key: metric, label: metric === 'revenue' ? 'Revenue' : 'Profit', color: 'var(--series-1)' }];

  return (
    <div className="w-full space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {greeting()}, {user!.name.split(' ')[0]}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {t
              ? t.calls === 0
                ? `No calls ${range.preset === 'today' ? 'yet today' : 'in this period'}.`
                : `${t.converted.toLocaleString()} of ${t.calls.toLocaleString()} calls converted ${range.preset === 'custom' ? `in ${rangeLabel(range)}` : rangeLabel(range).toLowerCase()}${
                    convertedDelta !== null ? ` — ${Math.abs(Math.round(convertedDelta))}% ${convertedDelta >= 0 ? 'more' : 'fewer'} than ${compare}` : ''
                  }.`
              : ' '}
          </p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
        {staff && (
          <>
            <Link
              href={firstCampaign ? `/campaigns/${firstCampaign.id}` : '/campaigns'}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-strong bg-card px-3.5 text-[13px] font-medium hover:bg-subtle"
            >
              <PhoneOutgoing size={16} strokeWidth={1.9} aria-hidden /> Test call
            </Link>
            <Link href="/campaigns?new=1" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3.5 text-[13px] font-medium text-brand-contrast hover:opacity-90">
              <Plus size={16} strokeWidth={2} aria-hidden /> New campaign
            </Link>
          </>
        )}
      </div>

      {error && <Alert>{error}</Alert>}
      {alert && dismissed !== alert.id && (
        <Alert
          tone={alert.type === 'suspended' ? 'error' : 'warning'}
          action={
            <div className="flex items-center gap-3">
              {alert.link && <Link href={alert.link} className="font-medium text-accent">{alert.type === 'cap_reached' ? 'Review caps' : 'Add funds'}</Link>}
              <button onClick={() => setDismissed(alert.id)} className="text-muted hover:text-foreground">Dismiss</button>
            </div>
          }
        >
          <b className="font-semibold">{alert.title}.</b> <span className="text-muted">{alert.body}</span>
        </Alert>
      )}

      {/* Headline figures */}
      <StatStrip cols={5}>
        <Stat
          icon={PhoneIncoming}
          label="Calls"
          value={t ? t.calls.toLocaleString() : '—'}
          trend={<Sparkline values={sparkOf('calls')} />}
          foot={<><Delta value={t && p ? pct(t.calls, p.calls) : null} suffix="%" /> vs {compare}</>}
        />
        <Stat
          icon={CircleCheck}
          label="Answered"
          value={t ? `${t.calls ? ((t.answered / t.calls) * 100).toFixed(1) : '0'}%` : '—'}
          foot={t ? `${t.answered.toLocaleString()} connected to a buyer` : undefined}
        />
        <Stat
          icon={Target}
          label="Converted"
          value={t ? t.converted.toLocaleString() : '—'}
          trend={<Sparkline values={sparkOf('converted')} />}
          foot={<><Delta value={convertedDelta} suffix="%" /> · {t ? Math.round(t.conversionRate * 100) : 0}% of calls</>}
        />
        {role === 'PUBLISHER' ? (
          <Stat icon={Clock} label="Talk time" value={t ? duration(t.talkSec) : '—'} foot="with buyers" />
        ) : (
          <Stat
            icon={CircleDollarSign}
            label={role === 'BUYER' ? 'Spend' : 'Revenue'}
            value={t ? money(t.revenue ?? 0) : '—'}
            trend={<Sparkline values={sparkOf('revenue')} />}
            foot={<><Delta value={t && p ? pct(Number(t.revenue ?? 0), Number(p.revenue ?? 0)) : null} goodWhenUp={role !== 'BUYER'} suffix="%" /> vs {compare}</>}
          />
        )}
        <Stat
          icon={role === 'TENANT_ADMIN' || role === 'MANAGER' ? TrendingUp : Wallet}
          label={role === 'PUBLISHER' ? 'Payout earned' : role === 'BUYER' ? 'Cost per sale' : 'Profit'}
          value={
            !t ? '—'
            : role === 'BUYER' ? money(t.converted ? Number(t.revenue ?? 0) / t.converted : 0)
            : money((role === 'PUBLISHER' ? t.payout : t.profit) ?? 0)
          }
          trend={role === 'BUYER' ? undefined : <Sparkline values={sparkOf(moneyKey)} />}
          foot={
            role === 'BUYER' ? `${t?.converted ?? 0} converted calls`
            : role === 'PUBLISHER' ? <><Delta value={t && p ? pct(Number(t.payout ?? 0), Number(p.payout ?? 0)) : null} suffix="%" /> vs {compare}</>
            : <>{t && Number(t.revenue) > 0 ? `${Math.round((Number(t.profit) / Number(t.revenue)) * 100)}% margin` : 'No revenue yet'}</>
          }
        />
      </StatStrip>

      {/* Chart + live */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader title={single ? 'Calls by hour' : 'Calls by day'}>
            {metric === 'calls' ? <Legend series={callSeries} /> : null}
            {staff && (
              <div role="tablist" aria-label="Chart metric" className="flex gap-0.5 rounded-lg bg-subtle p-0.5">
                {(['calls', 'revenue', 'profit'] as const).map((m) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={metric === m}
                    onClick={() => setMetric(m)}
                    className={`h-7 rounded-md px-2.5 text-xs capitalize ${metric === m ? 'bg-card font-semibold shadow-sm' : 'font-medium text-muted hover:text-foreground'}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </CardHeader>
          <div className="mt-4">
            {s && t?.calls === 0 ? (
              <Empty icon={PhoneCall} title="No calls in this period" text={staff ? 'Place a test call from a campaign to see it here.' : undefined} />
            ) : (
              <BarChart
                data={chartData as (Point & { hour?: number; day?: string })[]}
                x={(d) => (single ? `${hourLabel(d.hour!)} — ${hourLabel((d.hour! + 1) % 24)}` : d.day!)}
                label={single ? (d) => hourLabel(d.hour!) : undefined}
                series={metric === 'calls' ? callSeries : moneySeries}
                stacked={metric === 'calls'}
                integer={metric === 'calls'}
                height={230}
                value={(d, k) => (k === 'other' ? d.calls - d.converted : Number((d as unknown as Record<string, number>)[k] ?? 0))}
                format={metric === 'calls' ? undefined : (v) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}k` : Math.abs(v) < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`)}
              />
            )}
          </div>
        </Card>
        <LiveNow calls={live} now={now} />
      </div>

      {/* Campaigns + side panels */}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card flush className="overflow-hidden">
          <CardHeader title={staff ? 'Campaigns' : 'Your campaigns'} className="px-5 py-4">
            {staff && (
              <>
                <Button variant="secondary" size="sm" icon={Download} onClick={() => download(`/calls/export.csv?${q}`, `calls-${range.startDate}_to_${range.endDate}.csv`)}>
                  Export
                </Button>
                <Link href="/campaigns" className="text-[13px] font-medium text-accent">View all</Link>
              </>
            )}
          </CardHeader>
          {s && s.breakdown.length === 0 ? (
            <Empty icon={Target} title="No campaign activity" text="Calls to your tracking numbers will show up here, per campaign." />
          ) : (
            <div className="overflow-x-auto">
              <table className={`${table.wrap} min-w-[640px]`}>
                <thead className={table.head}>
                  <tr>
                    <th>Campaign</th>
                    <th className="text-right">Calls</th>
                    <th>Conversion</th>
                    {role !== 'PUBLISHER' && <th className="text-right">{role === 'BUYER' ? 'Spend' : 'Revenue'}</th>}
                    {role !== 'BUYER' && <th className="text-right">{staff ? 'Profit' : 'Payout'}</th>}
                    {staff && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {s?.breakdown.map((b) => {
                    const meta = b.id ? metaById.get(b.id) : undefined;
                    const rate = b.calls ? b.converted / b.calls : 0;
                    const last = staff ? Number(b.profit ?? 0) : Number(b.payout ?? 0);
                    return (
                      <tr key={b.id ?? 'none'} className={table.row}>
                        <td>
                          <div className="flex items-center gap-3">
                            <Initials name={b.name} />
                            <div className="min-w-0">
                              <div className="truncate font-medium">{b.name}</div>
                              {meta && <div className="text-xs text-faint">{meta._count.routes} buyers · {meta._count.phoneNumbers} numbers</div>}
                            </div>
                          </div>
                        </td>
                        <td className="text-right font-mono tabular">{b.calls.toLocaleString()}</td>
                        <td>
                          <div className="flex items-center gap-2.5">
                            <div className="h-1.5 w-24 rounded-full bg-subtle">
                              <div className="h-1.5 rounded-full bg-series-1" style={{ width: `${Math.round(rate * 100)}%` }} />
                            </div>
                            <span className="font-mono text-muted tabular">{Math.round(rate * 100)}%</span>
                          </div>
                        </td>
                        {role !== 'PUBLISHER' && <td className="text-right font-mono tabular">{money(b.revenue ?? 0)}</td>}
                        {role !== 'BUYER' && <td className={`text-right font-mono font-medium tabular ${last < 0 ? 'text-danger' : ''}`}>{money(last)}</td>}
                        {staff && (
                          <td className="text-right">
                            {b.id && (
                              <Link href={`/campaigns/${b.id}`} aria-label={`Open ${b.name}`} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-foreground">
                                <MoreHorizontal size={16} aria-hidden />
                              </Link>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {staff && (
          <div className="space-y-5">
            <CapacityCard rows={capacity} />
            <QuickActions />
          </div>
        )}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER', 'PUBLISHER', 'BUYER']}>
      <DashboardContent />
    </AppShell>
  );
}
