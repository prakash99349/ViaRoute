'use client';

import Link from 'next/link';
import { ArrowLeft, ArrowRight, CircleCheck, Download, Mic, PhoneCall, Radio, RefreshCw, Repeat, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CallDrawer, REASONS, STATUS, type CallRow } from '@/components/call-drawer';
import { DateRangePicker } from '@/components/date-range-picker';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, Card, Empty, PageHeader, Select, table } from '@/components/ui';
import { api, download, duration, formatPhone, money, shortDateTime } from '@/lib/api';
import { rangeQuery, useDateRange } from '@/lib/date-range';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';

function LiveCalls() {
  const [live, setLive] = useState<CallRow[]>([]);
  useEffect(() => {
    let stop = false;
    const tick = () =>
      api<CallRow[]>('/calls/live')
        .then((r) => !stop && setLive(r))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  return (
    <Card className="py-3.5">
      <div className="flex flex-wrap items-center gap-2.5 text-sm" aria-live="polite">
        <span className="mr-1 inline-flex items-center gap-2 font-semibold">
          <span className={`h-2 w-2 rounded-full ${live.length ? 'animate-pulse bg-success ring-4 ring-success-bg' : 'bg-border-strong'}`} aria-hidden />
          Live now · {live.length}
        </span>
        {live.length === 0 && <span className="text-xs text-muted">No calls in progress</span>}
        {live.slice(0, 6).map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1.5 rounded-md bg-subtle px-2.5 py-1 font-mono text-xs">
            <PhoneCall size={12} className={c.status === 'IN_PROGRESS' ? 'text-success' : 'text-warning'} aria-hidden />
            {formatPhone(c.callerNumber)} → {c.target?.name ?? c.buyer?.name ?? c.campaign?.name ?? '…'} · {STATUS[c.status].label}
          </span>
        ))}
        {live.length > 6 && <span className="text-xs text-muted">+{live.length - 6} more</span>}
        <Link href="/live" className="ml-auto inline-flex items-center gap-1.5 text-[13px] font-medium text-accent">
          <Radio size={14} aria-hidden /> Live board
        </Link>
      </div>
    </Card>
  );
}

function CallsContent() {
  const { user } = useAuth();
  const staff = user?.role === 'TENANT_ADMIN' || user?.role === 'MANAGER';
  const { range, setRange, ready } = useDateRange('7d');
  const [campaignId, setCampaignId] = useState('');
  const [status, setStatus] = useState('');
  const [converted, setConverted] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('q');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the URL (search from the top bar)
    if (fromUrl) setQ(fromUrl);
  }, []);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { data: campaigns } = useApi<{ id: string; name: string }[]>(staff ? '/campaigns' : null);

  const qs = useMemo(() => {
    const p = new URLSearchParams(rangeQuery(range));
    p.set('page', String(page));
    p.set('pageSize', '50');
    if (campaignId) p.set('campaignId', campaignId);
    if (status) p.set('status', status);
    if (converted) p.set('converted', converted);
    if (q.trim()) p.set('q', q.trim());
    return p.toString();
    // refreshKey forces a new query string → reload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, campaignId, status, converted, q, page, refreshKey]);

  const { data, error, loading } = useApi<{ items: CallRow[]; total: number; page: number; pageSize: number }>(ready ? `/calls?${qs}` : null);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const [exportError, setExportError] = useState('');
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={PhoneCall} title="Call logs" subtitle={data ? `${data.total.toLocaleString()} calls in this view` : 'Every call, its route and outcome'}>
        <Button variant="secondary" icon={RefreshCw} onClick={refresh}>Refresh</Button>
        <Button
          variant="secondary"
          icon={Download}
          onClick={() => download(`/calls/export.csv?${qs}`, `calls-${range.startDate}_to_${range.endDate}.csv`).catch((e) => setExportError((e as Error).message))}
        >
          Export CSV
        </Button>
      </PageHeader>

      <LiveCalls />

      <div className="flex flex-wrap gap-2">
        <DateRangePicker value={range} onChange={(r) => { setRange(r); setPage(1); }} align="left" />
        {staff && (
          <div className="w-48">
            <Select aria-label="Campaign" value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setPage(1); }}>
              <option value="">All campaigns</option>
              {campaigns?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        )}
        <div className="w-40">
          <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </div>
        <div className="w-40">
          <Select aria-label="Converted" value={converted} onChange={(e) => { setConverted(e.target.value); setPage(1); }}>
            <option value="">Converted or not</option>
            <option value="true">Converted</option>
            <option value="false">Not converted</option>
          </Select>
        </div>
        <label className="flex h-9 w-56 items-center gap-2 rounded-lg border border-border-strong bg-card px-3 text-sm focus-within:border-foreground/40">
          <Search size={15} strokeWidth={1.75} className="text-faint" aria-hidden />
          <input
            aria-label="Search caller"
            placeholder="Search caller number…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
          />
        </label>
      </div>

      {(error || exportError) && <Alert>{error || exportError}</Alert>}

      <Card flush className="overflow-x-auto">
        {data?.items.length === 0 ? (
          <Empty icon={PhoneCall} title="No calls found" text="Try a wider date range — or place a test call from a campaign." />
        ) : (
          <table className={`${table.wrap} min-w-[960px]`}>
            <thead className={table.head}>
              <tr>
                <th>Time</th>
                <th>Caller</th>
                <th>Campaign</th>
                {user?.role !== 'PUBLISHER' && <th>Buyer</th>}
                {user?.role !== 'BUYER' && user?.role !== 'AGENT' && <th>Publisher</th>}
                <th>Outcome</th>
                <th className="text-right">Talk</th>
                {user?.role !== 'PUBLISHER' && user?.role !== 'AGENT' && <th className="text-right">Revenue</th>}
                {user?.role !== 'BUYER' && user?.role !== 'AGENT' && <th className="text-right">Payout</th>}
                {staff && <th className="text-right">Profit</th>}
              </tr>
            </thead>
            <tbody className={loading ? 'opacity-60' : ''}>
              {data?.items.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setOpen(c.id)}
                  onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && setOpen(c.id)}
                  tabIndex={0}
                  aria-label={`Call from ${formatPhone(c.callerNumber)}, open details`}
                  className={`${table.row} ${table.rowHover} outline-none focus-visible:bg-subtle`}
                >
                  <td className="whitespace-nowrap text-xs text-muted" title={new Date(c.startedAt).toLocaleString()}>{shortDateTime(c.startedAt)}</td>
                  <td className="whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-mono">{formatPhone(c.callerNumber)}</span>
                      {c.callerState && <span className="text-xs text-faint">{c.callerState}</span>}
                      {c.hasRecording && <Mic size={13} className="text-faint" aria-label="Recorded" />}
                    </span>
                  </td>
                  <td className="max-w-[190px] truncate whitespace-nowrap" title={c.campaign?.name}>{c.campaign?.name ?? <span className="text-faint">—</span>}</td>
                  {user?.role !== 'PUBLISHER' && (
                    <td className="max-w-[170px] whitespace-nowrap">
                      <div className="truncate">{c.buyer?.name ?? (c.target ? c.target.name : <span className="text-faint">—</span>)}</div>
                      {c.target && <div className="truncate text-xs text-faint">{c.buyer ? c.target.name : 'Direct target'}</div>}
                    </td>
                  )}
                  {user?.role !== 'BUYER' && user?.role !== 'AGENT' && <td className="max-w-[150px] truncate whitespace-nowrap">{c.publisher?.name ?? <span className="text-faint">—</span>}</td>}
                  <td className="whitespace-nowrap">
                    <span className="inline-flex flex-wrap items-center gap-1">
                      {c.converted ? (
                        <Badge tone="green"><CircleCheck size={12} aria-hidden /> Converted</Badge>
                      ) : (
                        <Badge tone={STATUS[c.status].tone} dot>{STATUS[c.status].label}</Badge>
                      )}
                      {c.duplicate && <Badge tone="yellow"><Repeat size={12} aria-hidden /> Repeat</Badge>}
                    </span>
                    {c.rejectReason && !c.converted && <div className="mt-0.5 text-xs text-faint">{REASONS[c.rejectReason] ?? c.rejectReason}</div>}
                  </td>
                  <td className="text-right font-mono tabular">{duration(c.connectedSec)}</td>
                  {user?.role !== 'PUBLISHER' && user?.role !== 'AGENT' && <td className="text-right font-mono tabular">{money(c.revenue ?? 0)}</td>}
                  {user?.role !== 'BUYER' && user?.role !== 'AGENT' && <td className="text-right font-mono tabular">{money(c.payout ?? 0)}</td>}
                  {staff && <td className={`text-right font-mono font-medium tabular ${Number(c.profit) < 0 ? 'text-danger' : ''}`}>{money(c.profit ?? 0)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button variant="secondary" icon={ArrowLeft} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-muted">Page {page} of {pages}</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next <ArrowRight size={16} aria-hidden /></Button>
        </div>
      )}

      {open && <CallDrawer id={open} onClose={() => setOpen(null)} onChanged={refresh} />}
    </div>
  );
}

export default function CallsPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER', 'PUBLISHER', 'BUYER', 'AGENT']}>
      <CallsContent />
    </AppShell>
  );
}
