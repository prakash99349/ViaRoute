'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  CircleCheck, CircleDollarSign, Clock, Columns3, Download, FileSpreadsheet, Filter, Mic, PhoneIncoming, Repeat, RotateCcw, Sigma, Target, TrendingUp,
} from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { CallDrawer, REASONS, STATUS, type CallRow } from '@/components/call-drawer';
import { DateRangePicker } from '@/components/date-range-picker';
import { Alert, Badge, Button, Card, CardHeader, Empty, Field, PageHeader, Select, Stat, StatStrip, table } from '@/components/ui';
import { download, duration, formatPhone, money, shortDateTime } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { rangeLabel, rangeQuery, useDateRange } from '@/lib/date-range';
import { useApi } from '@/lib/use-api';

interface Filters {
  campaignId: string;
  publisherId: string;
  buyerId: string;
  targetId: string;
  status: string;
  converted: string;
  duplicate: string;
  recorded: string;
  state: string;
  number: string;
  minTalk: string;
  q: string;
}

const EMPTY: Filters = { campaignId: '', publisherId: '', buyerId: '', targetId: '', status: '', converted: '', duplicate: '', recorded: '', state: '', number: '', minTalk: '', q: '' };

interface Column {
  key: string;
  label: string;
  default: boolean;
}

interface Summary {
  totals: { calls: number; answered: number; converted: number; conversionRate: number; talkSec: number; revenue?: string; payout?: string; cost?: string; profit?: string };
  daily: { day: string; calls: number; converted: number; revenue?: number; payout?: number; cost?: number; profit?: number }[];
  hourly: { hour: number; calls: number; converted: number; revenue?: number; payout?: number; cost?: number; profit?: number }[];
  breakdown: { id: string | null; name: string; calls: number; converted: number; talkSec: number; revenue?: string; payout?: string; cost?: string; profit?: string }[];
}

type GroupBy = 'day' | 'hour' | 'campaign' | 'publisher' | 'buyer' | 'target' | 'number' | 'state';
const GROUP_LABEL: Record<GroupBy, string> = { day: 'Day', hour: 'Hour of day', campaign: 'Campaign', publisher: 'Publisher', buyer: 'Buyer', target: 'Target', number: 'Tracking number', state: 'Caller state' };

const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const COLS_KEY = 'vr_cdr_columns';

function filterQuery(f: Filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString();
}

function FilterBar({ f, set, role }: { f: Filters; set: (f: Filters) => void; role: string }) {
  const staff = role === 'TENANT_ADMIN' || role === 'MANAGER';
  const { data: campaigns } = useApi<{ id: string; name: string }[]>(staff ? '/campaigns' : null);
  const { data: publishers } = useApi<{ id: string; name: string }[]>(staff ? '/publishers' : null);
  const { data: buyers } = useApi<{ id: string; name: string }[]>(staff ? '/buyers' : null);
  const { data: targets } = useApi<{ id: string; name: string; buyer: { name: string } | null }[]>(staff ? '/targets' : null);
  const { data: numbers } = useApi<{ id: string; e164: string; label: string | null }[]>(staff ? '/numbers' : null);
  const up = (k: keyof Filters) => (e: { target: { value: string } }) => set({ ...f, [k]: e.target.value });
  const active = Object.values(f).filter(Boolean).length;

  return (
    <Card>
      <CardHeader icon={Filter} title="Filters" subtitle={active ? `${active} filter${active === 1 ? '' : 's'} applied` : 'Showing every call in the period'}>
        {active > 0 && <Button variant="subtle" size="sm" icon={RotateCcw} onClick={() => set(EMPTY)}>Reset</Button>}
      </CardHeader>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
        {staff && (
          <Select label="Campaign" value={f.campaignId} onChange={up('campaignId')}>
            <option value="">All campaigns</option>
            {campaigns?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
        {staff && (
          <Select label="Publisher" value={f.publisherId} onChange={up('publisherId')}>
            <option value="">All publishers</option>
            {publishers?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
        {staff && (
          <Select label="Buyer" value={f.buyerId} onChange={up('buyerId')}>
            <option value="">All buyers</option>
            {buyers?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}
        {staff && (
          <Select label="Target" value={f.targetId} onChange={up('targetId')}>
            <option value="">All targets</option>
            {targets?.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.buyer?.name ?? 'Direct'}</option>)}
          </Select>
        )}
        {staff ? (
          <Select label="Tracking number" value={f.number} onChange={up('number')}>
            <option value="">All numbers</option>
            {numbers?.map((n) => <option key={n.id} value={n.e164}>{formatPhone(n.e164)}{n.label ? ` — ${n.label}` : ''}</option>)}
          </Select>
        ) : (
          <Field label="Tracking number" value={f.number} onChange={up('number')} placeholder="Digits" inputMode="numeric" />
        )}
        <Select label="Status" value={f.status} onChange={up('status')}>
          <option value="">Any status</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
        <Select label="Converted" value={f.converted} onChange={up('converted')}>
          <option value="">Converted or not</option>
          <option value="true">Converted only</option>
          <option value="false">Not converted</option>
        </Select>
        <Select label="Repeat callers" value={f.duplicate} onChange={up('duplicate')}>
          <option value="">Include</option>
          <option value="true">Only repeats</option>
          <option value="false">Exclude</option>
        </Select>
        <Select label="Recording" value={f.recorded} onChange={up('recorded')}>
          <option value="">Any</option>
          <option value="true">Recorded</option>
          <option value="false">Not recorded</option>
        </Select>
        <Select label="Caller state" value={f.state} onChange={up('state')}>
          <option value="">All states</option>
          {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Field label="Min talk time (sec)" type="number" min={0} value={f.minTalk} onChange={up('minTalk')} placeholder="0" />
        <Field label="Caller number" value={f.q} onChange={up('q')} placeholder="Digits" inputMode="numeric" />
      </div>
    </Card>
  );
}

function ColumnChooser({ columns, chosen, setChosen }: { columns: Column[]; chosen: string[]; setChosen: (c: string[]) => void }) {
  const toggle = (k: string) => setChosen(chosen.includes(k) ? chosen.filter((x) => x !== k) : columns.map((c) => c.key).filter((x) => x === k || chosen.includes(x)));
  return (
    <Card>
      <CardHeader icon={Columns3} title="Columns in the file" subtitle={`${chosen.length} of ${columns.length} selected`}>
        <Button variant="subtle" size="sm" onClick={() => setChosen(columns.map((c) => c.key))}>All</Button>
        <Button variant="subtle" size="sm" onClick={() => setChosen(columns.filter((c) => c.default).map((c) => c.key))}>Default</Button>
      </CardHeader>
      <div className="mt-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
        {columns.map((c) => (
          <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-subtle">
            <input type="checkbox" checked={chosen.includes(c.key)} onChange={() => toggle(c.key)} className="h-4 w-4 accent-[var(--brand)]" />
            {c.label}
          </label>
        ))}
      </div>
    </Card>
  );
}

function ReportsContent() {
  const { user } = useAuth();
  const role = user!.role;
  const staff = role === 'TENANT_ADMIN' || role === 'MANAGER';
  const { range, setRange, ready } = useDateRange('7d');
  const [tab, setTab] = useState<'cdr' | 'summary'>('cdr');
  const [f, setF] = useState<Filters>(EMPTY);
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const query = useMemo(() => [rangeQuery(range), filterQuery(f)].filter(Boolean).join('&'), [range, f]);
  const serverGroup = groupBy === 'day' || groupBy === 'hour' ? 'campaign' : groupBy;
  const { data: columns } = useApi<Column[]>('/calls/columns');
  const { data: summary, loading } = useApi<Summary>(ready ? `/reports/summary?${query}&groupBy=${serverGroup}` : null);
  const { data: preview } = useApi<{ items: CallRow[]; total: number }>(ready && tab === 'cdr' ? `/calls?${query}&pageSize=25` : null);

  // Remember the chosen CDR columns in this browser.
  useEffect(() => {
    if (!columns) return;
    let saved: string[] | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(COLS_KEY) ?? 'null');
    } catch {
      saved = null;
    }
    const valid = saved?.filter((k) => columns.some((c) => c.key === k));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore saved column choice once columns load
    setChosen(valid?.length ? valid : columns.filter((c) => c.default).map((c) => c.key));
  }, [columns]);
  const saveChosen = (c: string[]) => {
    setChosen(c);
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(c));
    } catch {
      /* private mode */
    }
  };

  async function run(label: string, path: string, name: string) {
    setBusy(label);
    setError('');
    try {
      await download(path, name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const t = summary?.totals;
  const file = `${range.startDate}_to_${range.endDate}`;
  const rows: { name: string; calls: number; converted: number; talkSec?: number; revenue?: number | string; payout?: number | string; profit?: number | string }[] =
    groupBy === 'day' ? summary?.daily.map((d) => ({ ...d, name: d.day })) ?? []
    : groupBy === 'hour' ? summary?.hourly.map((h) => ({ ...h, name: `${String(h.hour).padStart(2, '0')}:00 – ${String(h.hour).padStart(2, '0')}:59` })) ?? []
    : summary?.breakdown ?? [];

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={FileSpreadsheet} title="Reports" subtitle="Call detail records (CDR) and summary reports to view or download.">
        <DateRangePicker value={range} onChange={setRange} />
      </PageHeader>

      <div role="tablist" aria-label="Report type" className="flex gap-1 border-b border-border">
        {([['cdr', 'Call detail records (CDR)'], ['summary', 'Summary report']] as const).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 pb-2.5 text-sm ${tab === k ? 'border-foreground font-semibold' : 'border-transparent text-muted hover:text-foreground'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <Alert>{error}</Alert>}

      <FilterBar f={f} set={setF} role={role} />

      <StatStrip cols={staff ? 5 : 4}>
        <Stat icon={PhoneIncoming} label="Calls" value={t ? t.calls.toLocaleString() : '—'} foot={rangeLabel(range)} />
        <Stat icon={Target} label="Converted" value={t ? t.converted.toLocaleString() : '—'} foot={t ? `${Math.round(t.conversionRate * 100)}% of calls` : undefined} />
        <Stat icon={Clock} label="Talk time" value={t ? duration(t.talkSec) : '—'} foot={t ? `${t.answered.toLocaleString()} answered` : undefined} />
        {role !== 'PUBLISHER' && <Stat icon={CircleDollarSign} label={role === 'BUYER' ? 'Spend' : 'Revenue'} value={t ? money(t.revenue ?? 0) : '—'} />}
        {role !== 'BUYER' && <Stat icon={staff ? TrendingUp : CircleDollarSign} label={staff ? 'Profit' : 'Payout'} value={t ? money((staff ? t.profit : t.payout) ?? 0) : '—'} foot={staff && t ? `after ${money(t.payout ?? 0)} payout, ${money(t.cost ?? 0)} usage` : undefined} />}
      </StatStrip>

      {tab === 'cdr' ? (
        <>
          {columns && <ColumnChooser columns={columns} chosen={chosen} setChosen={saveChosen} />}

          <Card flush className="overflow-hidden">
            <CardHeader
              title="Preview"
              subtitle={preview ? `Latest ${Math.min(25, preview.total)} of ${preview.total.toLocaleString()} calls${preview.total > 100_000 ? ' · the file holds the latest 100,000' : ''}` : 'Loading…'}
              className="px-5 py-4"
            >
              <Link href="/calls" className="text-[13px] font-medium text-accent">Open in call logs</Link>
              <Button
                icon={Download}
                disabled={!!busy || !chosen.length || !preview?.total}
                onClick={() => run('cdr', `/calls/export.csv?${query}&columns=${chosen.join(',')}`, `cdr-${file}.csv`)}
              >
                {busy === 'cdr' ? 'Preparing…' : 'Download CDR (CSV)'}
              </Button>
            </CardHeader>
            {preview?.total === 0 ? (
              <Empty icon={FileSpreadsheet} title="No calls match" text="Try a wider date range or fewer filters." />
            ) : (
              <div className="overflow-x-auto">
                <table className={`${table.wrap} min-w-[1000px]`}>
                  <thead className={table.head}>
                    <tr>
                      <th>Started</th>
                      <th>Caller</th>
                      <th>Tracking number</th>
                      <th>Campaign</th>
                      {role !== 'PUBLISHER' && <th>Buyer</th>}
                      {role !== 'BUYER' && <th>Publisher</th>}
                      <th>Outcome</th>
                      <th className="text-right">Length</th>
                      <th className="text-right">Talk</th>
                      {role !== 'PUBLISHER' && <th className="text-right">{role === 'BUYER' ? 'Spend' : 'Revenue'}</th>}
                      {role !== 'BUYER' && <th className="text-right">{staff ? 'Profit' : 'Payout'}</th>}
                    </tr>
                  </thead>
                  <tbody className={loading ? 'opacity-60' : ''}>
                    {preview?.items.map((c) => (
                      <tr key={c.id} onClick={() => setOpen(c.id)} className={`${table.row} ${table.rowHover}`}>
                        <td className="whitespace-nowrap text-xs text-muted">{shortDateTime(c.startedAt)}</td>
                        <td className="whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="font-mono">{formatPhone(c.callerNumber)}</span>
                            {c.callerState && <span className="text-xs text-faint">{c.callerState}</span>}
                            {c.hasRecording && <Mic size={13} className="text-faint" aria-label="Recorded" />}
                          </span>
                        </td>
                        <td className="whitespace-nowrap font-mono text-xs">{c.dialedNumber ? formatPhone(c.dialedNumber) : '—'}</td>
                        <td className="max-w-[180px] truncate">{c.campaign?.name ?? '—'}</td>
                        {role !== 'PUBLISHER' && (
                          <td className="max-w-[170px]">
                            <div className="truncate">{c.buyer?.name ?? c.target?.name ?? '—'}</div>
                            {c.target && <div className="truncate text-xs text-faint">{c.buyer ? c.target.name : 'Direct target'}</div>}
                          </td>
                        )}
                        {role !== 'BUYER' && <td className="max-w-[150px] truncate">{c.publisher?.name ?? '—'}</td>}
                        <td className="whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            {c.converted ? <Badge tone="green"><CircleCheck size={12} aria-hidden /> Converted</Badge> : <Badge tone={STATUS[c.status].tone} dot>{c.rejectReason ? REASONS[c.rejectReason] ?? STATUS[c.status].label : STATUS[c.status].label}</Badge>}
                            {c.duplicate && <Badge tone="yellow"><Repeat size={12} aria-hidden /> Repeat</Badge>}
                          </span>
                        </td>
                        <td className="text-right font-mono tabular">{duration(c.durationSec)}</td>
                        <td className="text-right font-mono tabular">{duration(c.connectedSec)}</td>
                        {role !== 'PUBLISHER' && <td className="text-right font-mono tabular">{money(c.revenue ?? 0)}</td>}
                        {role !== 'BUYER' && <td className={`text-right font-mono tabular ${Number(staff ? c.profit : c.payout) < 0 ? 'text-danger' : ''}`}>{money((staff ? c.profit : c.payout) ?? 0)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : (
        <Card flush className="overflow-hidden">
          <CardHeader icon={Sigma} title={`Summary by ${GROUP_LABEL[groupBy].toLowerCase()}`} subtitle={`${rangeLabel(range)} · times in ${range.tz.replace(/_/g, ' ')}`} className="px-5 py-4">
            <div className="w-48">
              <Select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                {(Object.keys(GROUP_LABEL) as GroupBy[])
                  .filter((g) => (staff || g !== 'number') && !(g === 'publisher' && role === 'BUYER') && !((g === 'buyer' || g === 'target') && role === 'PUBLISHER'))
                  .map((g) => <option key={g} value={g}>By {GROUP_LABEL[g].toLowerCase()}</option>)}
              </Select>
            </div>
            <Button icon={Download} disabled={!!busy || !t?.calls} onClick={() => run('summary', `/reports/summary.csv?${query}&groupBy=${groupBy}`, `report-by-${groupBy}-${file}.csv`)}>
              {busy === 'summary' ? 'Preparing…' : 'Download CSV'}
            </Button>
          </CardHeader>
          {t?.calls === 0 ? (
            <Empty icon={Sigma} title="No calls in this period" text="Pick another date range or remove a filter." />
          ) : (
            <div className="overflow-x-auto">
              <table className={`${table.wrap} min-w-[720px]`}>
                <thead className={table.head}>
                  <tr>
                    <th>{GROUP_LABEL[groupBy]}</th>
                    <th className="text-right">Calls</th>
                    <th className="text-right">Converted</th>
                    <th>Conversion</th>
                    {rows[0] && 'talkSec' in rows[0] && <th className="text-right">Talk time</th>}
                    {role !== 'PUBLISHER' && <th className="text-right">{role === 'BUYER' ? 'Spend' : 'Revenue'}</th>}
                    {role !== 'BUYER' && <th className="text-right">Payout</th>}
                    {staff && <th className="text-right">Profit</th>}
                  </tr>
                </thead>
                <tbody className={loading ? 'opacity-60' : ''}>
                  {rows.map((r) => {
                    const rate = r.calls ? r.converted / r.calls : 0;
                    return (
                      <tr key={r.name} className={`${table.row} ${r.calls === 0 ? 'text-faint' : ''}`}>
                        <td className="font-medium">{r.name}</td>
                        <td className="text-right font-mono tabular">{r.calls.toLocaleString()}</td>
                        <td className="text-right font-mono tabular">{r.converted.toLocaleString()}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-20 rounded-full bg-subtle"><div className="h-1.5 rounded-full bg-series-1" style={{ width: `${Math.round(rate * 100)}%` }} /></div>
                            <span className="font-mono text-xs text-muted tabular">{Math.round(rate * 100)}%</span>
                          </div>
                        </td>
                        {'talkSec' in r && <td className="text-right font-mono tabular">{duration(r.talkSec ?? 0)}</td>}
                        {role !== 'PUBLISHER' && <td className="text-right font-mono tabular">{money(r.revenue ?? 0)}</td>}
                        {role !== 'BUYER' && <td className="text-right font-mono tabular">{money(r.payout ?? 0)}</td>}
                        {staff && <td className={`text-right font-mono font-medium tabular ${Number(r.profit) < 0 ? 'text-danger' : ''}`}>{money(r.profit ?? 0)}</td>}
                      </tr>
                    );
                  })}
                  {t && (
                    <tr className="border-t-2 border-border bg-subtle/50 font-semibold [&_td]:px-4 [&_td]:py-3 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5">
                      <td>Total</td>
                      <td className="text-right font-mono tabular">{t.calls.toLocaleString()}</td>
                      <td className="text-right font-mono tabular">{t.converted.toLocaleString()}</td>
                      <td className="font-mono text-xs tabular">{Math.round(t.conversionRate * 100)}%</td>
                      {rows[0] && 'talkSec' in rows[0] && <td className="text-right font-mono tabular">{duration(t.talkSec)}</td>}
                      {role !== 'PUBLISHER' && <td className="text-right font-mono tabular">{money(t.revenue ?? 0)}</td>}
                      {role !== 'BUYER' && <td className="text-right font-mono tabular">{money(t.payout ?? 0)}</td>}
                      {staff && <td className="text-right font-mono tabular">{money(t.profit ?? 0)}</td>}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {open && <CallDrawer id={open} onClose={() => setOpen(null)} onChanged={() => {}} />}
    </div>
  );
}

export default function ReportsPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER', 'PUBLISHER', 'BUYER']}>
      <ReportsContent />
    </AppShell>
  );
}
