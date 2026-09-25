'use client';

import { useEffect, useMemo, useState } from 'react';
import { BellRing, Clock, Pause, Phone, PhoneIncoming, Play, Radio, Search, Timer } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { CallDrawer, type CallRow } from '@/components/call-drawer';
import { Alert, Badge, Button, Card, Empty, IconTile, Initials, PageHeader, Select, Stat, StatStrip, table } from '@/components/ui';
import { api, duration, formatPhone } from '@/lib/api';
import { useAuth } from '@/lib/auth';

type GroupBy = 'buyer' | 'target' | 'campaign' | 'publisher' | 'none';
type SortBy = 'longest' | 'newest' | 'caller';

interface Capacity {
  buyer: { id: string; name: string };
  live: number;
  concurrencyCap: number | null;
}

const REFRESH_MS = 2000;

/** Seconds this call has been ringing or talking. */
function elapsedSec(c: CallRow, now: number) {
  const from = c.status === 'IN_PROGRESS' && c.answeredAt ? c.answeredAt : c.startedAt;
  return Math.max(0, (now - new Date(from).getTime()) / 1000);
}

function LiveContent() {
  const { user } = useAuth();
  const role = user!.role;
  const staff = role === 'TENANT_ADMIN' || role === 'MANAGER';
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [capacity, setCapacity] = useState<Capacity[]>([]);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [groupBy, setGroupBy] = useState<GroupBy>(role === 'BUYER' ? 'campaign' : 'buyer');
  const [sortBy, setSortBy] = useState<SortBy>('longest');
  const [status, setStatus] = useState<'' | 'IN_PROGRESS' | 'RINGING'>('');
  const [campaign, setCampaign] = useState('');
  const [buyer, setBuyer] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (paused) return;
    let stop = false;
    const load = async () => {
      try {
        const [c, cap] = await Promise.all([api<CallRow[]>('/calls/live'), staff ? api<Capacity[]>('/reports/capacity') : Promise.resolve([])]);
        if (stop) return;
        setCalls(c);
        setCapacity(cap);
        setUpdatedAt(Date.now());
        setError('');
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [paused, staff]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Options for the filters come from the calls on screen.
  const campaigns = useMemo(() => [...new Map((calls ?? []).filter((c) => c.campaign).map((c) => [c.campaign!.id, c.campaign!.name])).entries()], [calls]);
  const buyers = useMemo(() => [...new Map((calls ?? []).filter((c) => c.buyer).map((c) => [c.buyer!.id, c.buyer!.name])).entries()], [calls]);

  const visible = useMemo(() => {
    const digits = q.replace(/\D/g, '');
    const list = (calls ?? []).filter(
      (c) =>
        (!status || c.status === status) &&
        (!campaign || c.campaign?.id === campaign) &&
        (!buyer || c.buyer?.id === buyer) &&
        (!digits || c.callerNumber.includes(digits)),
    );
    const sorted = [...list].sort((a, b) =>
      sortBy === 'longest' ? elapsedSec(b, now) - elapsedSec(a, now)
      : sortBy === 'newest' ? new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      : a.callerNumber.localeCompare(b.callerNumber),
    );
    return sorted;
  }, [calls, status, campaign, buyer, q, sortBy, now]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', name: 'All live calls', calls: visible }];
    // Direct targets have no buyer: they group under their own name. Buyer main lines group as "main line" by target.
    const pick = (c: CallRow) =>
      groupBy === 'buyer' ? c.buyer ?? (c.target ? { id: `t:${c.target.id}`, name: `${c.target.name} (direct)` } : null)
      : groupBy === 'target' ? c.target ?? (c.buyer ? { id: `b:${c.buyer.id}`, name: `${c.buyer.name} — main line` } : null)
      : groupBy === 'campaign' ? c.campaign
      : c.publisher;
    const map = new Map<string, { key: string; name: string; calls: CallRow[] }>();
    for (const c of visible) {
      const g = pick(c);
      const key = g?.id ?? 'none';
      const name = g?.name ?? (groupBy === 'buyer' || groupBy === 'target' ? 'Waiting for a buyer' : groupBy === 'publisher' ? 'No publisher' : 'No campaign');
      if (!map.has(key)) map.set(key, { key, name, calls: [] });
      map.get(key)!.calls.push(c);
    }
    return [...map.values()].sort((a, b) => b.calls.length - a.calls.length || a.name.localeCompare(b.name));
  }, [visible, groupBy]);

  const capByBuyer = useMemo(() => {
    const m = new Map<string, { live: number; cap: number | null }>();
    for (const r of capacity) {
      const cur = m.get(r.buyer.id) ?? { live: 0, cap: 0 };
      m.set(r.buyer.id, { live: Math.max(cur.live, r.live), cap: r.concurrencyCap === null || cur.cap === null ? null : cur.cap + r.concurrencyCap });
    }
    return m;
  }, [capacity]);

  const talking = (calls ?? []).filter((c) => c.status === 'IN_PROGRESS');
  const ringing = (calls ?? []).length - talking.length;
  const longest = talking.reduce((m, c) => Math.max(m, elapsedSec(c, now)), 0);
  const avgTalk = talking.length ? talking.reduce((s, c) => s + elapsedSec(c, now), 0) / talking.length : 0;

  const showBuyerCol = role !== 'PUBLISHER' && groupBy !== 'buyer' && groupBy !== 'target';
  const showCampaignCol = groupBy !== 'campaign';
  const showPublisherCol = role !== 'BUYER' && groupBy !== 'publisher';

  return (
    <div className="w-full space-y-5">
      <PageHeader
        icon={Radio}
        title="Live calls"
        subtitle={
          paused ? 'Paused — press Resume to keep updating' : updatedAt ? `Updates every ${REFRESH_MS / 1000} seconds · last update ${new Date(updatedAt).toLocaleTimeString()}` : 'Connecting…'
        }
      >
        <Button variant="secondary" icon={paused ? Play : Pause} onClick={() => setPaused((p) => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </PageHeader>

      {error && <Alert>{error}</Alert>}

      <StatStrip cols={4}>
        <Stat icon={Radio} label="Live now" value={calls ? calls.length : '—'} foot={calls ? `${talking.length} talking · ${ringing} ringing` : undefined} />
        <Stat icon={PhoneIncoming} label="Talking" value={calls ? talking.length : '—'} foot="connected to a buyer" />
        <Stat icon={Timer} label="Longest call" value={calls ? duration(longest) : '—'} foot="in progress now" />
        <Stat icon={Clock} label="Average talk" value={calls ? duration(avgTalk) : '—'} foot="of calls in progress" />
      </StatStrip>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Group by" className="flex gap-0.5 rounded-lg bg-subtle p-0.5">
          {(['buyer', 'target', 'campaign', 'publisher', 'none'] as const)
            .filter((g) => !((g === 'buyer' || g === 'target') && role === 'PUBLISHER') && !(g === 'publisher' && role === 'BUYER'))
            .map((g) => (
              <button
                key={g}
                role="radio"
                aria-checked={groupBy === g}
                onClick={() => setGroupBy(g)}
                className={`h-8 rounded-md px-3 text-[13px] ${groupBy === g ? 'bg-card font-semibold shadow-sm' : 'font-medium text-muted hover:text-foreground'}`}
              >
                {g === 'none' ? 'No grouping' : `By ${g}`}
              </button>
            ))}
        </div>
        <div className="w-44">
          <Select aria-label="Sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
            <option value="longest">Longest first</option>
            <option value="newest">Newest first</option>
            <option value="caller">Caller number</option>
          </Select>
        </div>
        <div className="w-40">
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">Talking & ringing</option>
            <option value="IN_PROGRESS">Talking</option>
            <option value="RINGING">Ringing</option>
          </Select>
        </div>
        <div className="w-48">
          <Select aria-label="Campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
            <option value="">All campaigns</option>
            {campaigns.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </div>
        {role !== 'PUBLISHER' && role !== 'BUYER' && (
          <div className="w-44">
            <Select aria-label="Buyer" value={buyer} onChange={(e) => setBuyer(e.target.value)}>
              <option value="">All buyers</option>
              {buyers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </Select>
          </div>
        )}
        <label className="flex h-9 w-52 items-center gap-2 rounded-lg border border-border-strong bg-card px-3 text-sm focus-within:border-foreground/40">
          <Search size={15} strokeWidth={1.75} className="text-faint" aria-hidden />
          <input aria-label="Search caller" placeholder="Search caller…" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
        </label>
        <span className="ml-auto text-xs text-muted">{visible.length} shown</span>
      </div>

      {calls && visible.length === 0 && (
        <Card>
          <Empty
            icon={Phone}
            title={calls.length ? 'No live calls match these filters' : 'No calls in progress'}
            text={calls.length ? 'Clear a filter to see more.' : 'Calls appear here the moment they come in and disappear when they end.'}
          />
        </Card>
      )}

      {groups.map((g) =>
        g.calls.length === 0 ? null : (
          <Card key={g.key} flush className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              {groupBy !== 'none' && <Initials name={g.name} />}
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{g.name}</div>
                <div className="text-xs text-muted">
                  {g.calls.filter((c) => c.status === 'IN_PROGRESS').length} talking · {g.calls.filter((c) => c.status === 'RINGING').length} ringing
                </div>
              </div>
              {groupBy === 'buyer' && capByBuyer.get(g.key) && (() => {
                const cap = capByBuyer.get(g.key)!;
                const lines = g.calls.filter((c) => c.status === 'IN_PROGRESS').length;
                return cap.cap ? (
                  <div className="w-44">
                    <div className="flex justify-between text-xs text-muted"><span>Lines in use</span><span className="font-mono tabular">{lines} / {cap.cap}</span></div>
                    <div className="mt-1 h-1.5 rounded-full bg-subtle">
                      <div className={`h-1.5 rounded-full ${lines >= cap.cap ? 'bg-warning' : 'bg-series-1'}`} style={{ width: `${Math.min(100, (lines / cap.cap) * 100)}%` }} />
                    </div>
                  </div>
                ) : (
                  <Badge>No line limit</Badge>
                );
              })()}
              <Badge tone="blue">{g.calls.length} live</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className={`${table.wrap} min-w-[900px]`}>
                <thead className={table.head}>
                  <tr>
                    <th>Caller</th>
                    {showCampaignCol && <th>Campaign</th>}
                    {showBuyerCol && <th>Buyer / target</th>}
                    {showPublisherCol && <th>Publisher</th>}
                    <th>Tracking number</th>
                    <th>Status</th>
                    <th className="text-right">Time</th>
                    <th className="w-48">Until it converts</th>
                  </tr>
                </thead>
                <tbody>
                  {g.calls.map((c) => {
                    const secs = elapsedSec(c, now);
                    const isTalking = c.status === 'IN_PROGRESS';
                    const target = c.campaign?.convertAfterSeconds ?? 90;
                    const pct = isTalking ? Math.min(100, (secs / Math.max(target, 1)) * 100) : 0;
                    return (
                      <tr
                        key={c.id}
                        onClick={() => setOpen(c.id)}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen(c.id)}
                        tabIndex={0}
                        aria-label={`Live call from ${formatPhone(c.callerNumber)}, open details`}
                        className={`${table.row} ${table.rowHover} outline-none focus-visible:bg-subtle`}
                      >
                        <td>
                          <div className="flex items-center gap-3">
                            <IconTile icon={isTalking ? PhoneIncoming : BellRing} tone={isTalking ? 'green' : 'yellow'} size={30} />
                            <div>
                              <div className="font-mono">{formatPhone(c.callerNumber)}</div>
                              <div className="text-xs text-faint">{c.callerState ?? 'Unknown state'}{c.duplicate ? ' · repeat caller' : ''}</div>
                            </div>
                          </div>
                        </td>
                        {showCampaignCol && <td className="max-w-[200px] truncate">{c.campaign?.name ?? <span className="text-faint">—</span>}</td>}
                        {showBuyerCol && (
                          <td className="max-w-[180px]">
                            <div className="truncate">{c.buyer?.name ?? c.target?.name ?? <span className="text-faint">Finding a buyer…</span>}</div>
                            {c.target && <div className="truncate text-xs text-faint">{c.buyer ? c.target.name : 'Direct target'}</div>}
                          </td>
                        )}
                        {showPublisherCol && <td className="max-w-[160px] truncate">{c.publisher?.name ?? <span className="text-faint">—</span>}</td>}
                        <td>
                          <div className="font-mono text-xs">{c.dialedNumber ? formatPhone(c.dialedNumber) : '—'}</div>
                          {c.numberLabel && <div className="text-xs text-faint">{c.numberLabel}</div>}
                        </td>
                        <td>
                          {isTalking ? <Badge tone="green" dot>Talking</Badge> : <Badge tone="yellow" dot>Ringing · try {c.attempts || 1}</Badge>}
                        </td>
                        <td className={`text-right font-mono tabular ${isTalking ? '' : 'text-warning'}`}>{duration(secs)}</td>
                        <td>
                          {isTalking ? (
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 flex-1 rounded-full bg-subtle">
                                <div className={`h-1.5 rounded-full ${pct >= 100 ? 'bg-success' : 'bg-series-1'}`} style={{ width: `${pct}%` }} />
                              </div>
                              <span className={`w-14 text-right font-mono text-xs tabular ${pct >= 100 ? 'text-success' : 'text-muted'}`}>
                                {pct >= 100 ? 'Sale' : `${Math.round(secs)}/${target}s`}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-faint">Not answered yet</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ),
      )}

      {open && <CallDrawer id={open} onClose={() => setOpen(null)} onChanged={() => {}} />}
    </div>
  );
}

export default function LivePage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER', 'PUBLISHER', 'BUYER']}>
      <LiveContent />
    </AppShell>
  );
}
