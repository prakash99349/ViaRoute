'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Ban, BotOff, Plus, ShieldAlert, ShieldCheck, Sparkles, Trash2, UserX } from 'lucide-react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { BarChart, type Series } from '@/components/charts';
import { REASONS } from '@/components/call-drawer';
import { Alert, Badge, Button, Card, CardHeader, Empty, Field, IconButton, PageHeader, Select, Stat, StatStrip, table } from '@/components/ui';
import { api, formatPhone, shortDateTime } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

interface Overview {
  days: number;
  totalCalls: number;
  blockedCalls: number;
  byReason: Record<string, number>;
  daily: { day: string; blocked: number }[];
  blockedNumbers: { manual: number; auto: number };
  topCallers: { callerNumber: string; calls: number }[];
  recent: {
    id: string;
    startedAt: string;
    callerNumber: string;
    callerState: string | null;
    rejectReason: string;
    spamScore: number | null;
    attestation: string | null;
    lineType: string | null;
    campaign: { name: string } | null;
  }[];
}

interface Blocked {
  id: string;
  e164: string;
  reason: string | null;
  auto: boolean;
  createdAt: string;
}

const SERIES: Series[] = [{ key: 'blocked', label: 'Blocked calls', color: 'var(--danger)' }];
const REASON_HELP: Record<string, string> = {
  blocked_caller: 'On your blocklist',
  spam_global_block: 'Known spammer (platform list)',
  spam_anonymous: 'Hidden or invalid caller ID',
  spam_prefix: 'Blocked area code / prefix',
  spam_rate_limit: 'Called too often',
  spam_attestation: 'Caller ID not verified (STIR/SHAKEN)',
  spam_reputation: 'High spam score',
};

const caller = (n: string) => (/^\+\d+$/.test(n) ? formatPhone(n) : n);

function SpamContent() {
  const [days, setDays] = useState(30);
  const { data: o, reload: reloadOverview } = useApi<Overview>(`/spam/overview?days=${days}`);
  const { data: blocked, reload } = useApi<Blocked[]>('/blocked-numbers');
  const [number, setNumber] = useState('');
  const act = useAction();

  const refresh = () => {
    reload();
    reloadOverview();
  };

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    const e164 = number.replace(/[^\d+]/g, '').replace(/^(\d{10})$/, '+1$1').replace(/^(\d{11,})$/, '+$1');
    if (await act.run(() => api('/blocked-numbers', { method: 'POST', json: { e164, reason: reason || null } }), `${caller(e164)} blocked`)) {
      setNumber('');
      (e.target as HTMLFormElement).reset();
      refresh();
    }
  }

  const block = (n: string) => act.run(() => api('/blocked-numbers', { method: 'POST', json: { e164: n, reason: 'Blocked from spam report' } }), `${caller(n)} blocked`).then(refresh);
  const unblock = (b: Blocked) =>
    confirm(`Unblock ${caller(b.e164)}? Their calls will be routed again.`) && act.run(() => api(`/blocked-numbers/${b.id}`, { method: 'DELETE' }), `${caller(b.e164)} unblocked`).then(refresh);

  const reasons = Object.entries(o?.byReason ?? {}).sort((a, b) => b[1] - a[1]);
  const share = o && o.totalCalls ? Math.round((o.blockedCalls / o.totalCalls) * 100) : 0;
  const isBlocked = new Set(blocked?.map((b) => b.e164));

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={ShieldAlert} title="Spam & blocking" subtitle="Calls stopped before any buyer was dialed. Blocked calls are never billed or paid.">
        <div className="w-40">
          <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </Select>
        </div>
      </PageHeader>
      {act.error && <Alert>{act.error}</Alert>}
      {act.notice && <Success>{act.notice}</Success>}

      <StatStrip cols={4}>
        <Stat icon={Ban} label="Blocked calls" value={o ? o.blockedCalls.toLocaleString() : '—'} foot={o ? `${share}% of ${o.totalCalls.toLocaleString()} calls` : undefined} />
        <Stat icon={ShieldAlert} label="Top reason" value={reasons[0] ? REASON_HELP[reasons[0][0]] ?? reasons[0][0] : '—'} foot={reasons[0] ? `${reasons[0][1]} calls` : 'nothing blocked'} />
        <Stat icon={UserX} label="Blocked numbers" value={o ? o.blockedNumbers.manual + o.blockedNumbers.auto : '—'} foot={o ? `${o.blockedNumbers.auto} added automatically` : undefined} />
        <Stat icon={ShieldCheck} label="Rules" value={<Link href="/campaigns" className="text-base text-accent">Per campaign →</Link>} foot="Campaign → Spam protection" />
      </StatStrip>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="Blocked calls per day" />
          <div className="mt-3">
            <BarChart data={o?.daily ?? []} x={(d) => d.day} series={SERIES} value={(d) => d.blocked} integer />
          </div>
        </Card>
        <Card>
          <CardHeader title="Why calls were blocked" />
          {reasons.length === 0 ? (
            <p className="mt-6 text-center text-sm text-muted">Nothing blocked in this period.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {reasons.map(([k, n]) => (
                <li key={k}>
                  <div className="flex justify-between text-sm">
                    <span>{REASON_HELP[k] ?? REASONS[k] ?? k}</span>
                    <span className="font-mono tabular">{n}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-subtle">
                    <div className="h-1.5 rounded-full bg-danger" style={{ width: `${Math.max(4, (n / (o?.blockedCalls || 1)) * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        {/* Blocklist */}
        <Card flush className="overflow-hidden">
          <CardHeader icon={UserX} title="Your blocklist" subtitle="These callers are rejected on every campaign." className="px-5 pt-5" />
          <form onSubmit={add} className="flex flex-wrap items-end gap-2 px-5 pt-4">
            <div className="w-48"><Field label="Phone number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+13055550100" required /></div>
            <div className="min-w-0 flex-1"><Field label="Reason (optional)" name="reason" maxLength={200} placeholder="e.g. Prank caller" /></div>
            <Button type="submit" icon={Plus} disabled={act.busy || !number.trim()}>Block</Button>
          </form>
          <div className="mt-4 overflow-x-auto">
            {blocked?.length === 0 ? (
              <Empty icon={ShieldCheck} title="No blocked numbers" text="Block a caller here, from a call's details, or let campaign rules block short-call spammers automatically." />
            ) : (
              <table className={`${table.wrap} min-w-[560px]`}>
                <thead className={table.head}>
                  <tr>
                    <th>Number</th>
                    <th>Reason</th>
                    <th>Added</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {blocked?.map((b) => (
                    <tr key={b.id} className={table.row}>
                      <td className="whitespace-nowrap font-mono">{caller(b.e164)}</td>
                      <td>
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          {b.auto && <Badge tone="blue"><Sparkles size={11} aria-hidden /> Auto</Badge>}
                          <span className="text-muted">{b.reason ?? '—'}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-xs text-muted">{shortDateTime(b.createdAt)}</td>
                      <td className="text-right"><IconButton icon={Trash2} aria-label={`Unblock ${b.e164}`} onClick={() => unblock(b)} className="h-8 w-8 hover:text-danger" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        {/* Top offenders */}
        <Card>
          <CardHeader icon={BotOff} title="Most blocked callers" subtitle="Repeat offenders in this period." />
          {o?.topCallers.length ? (
            <ul className="mt-4 divide-y divide-border">
              {o.topCallers.map((t) => (
                <li key={t.callerNumber} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="font-mono">{caller(t.callerNumber)}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted tabular">{t.calls}×</span>
                    {isBlocked.has(t.callerNumber) || !/^\+\d+$/.test(t.callerNumber) ? (
                      <Badge>Blocked</Badge>
                    ) : (
                      <Button variant="subtle" size="sm" icon={Ban} onClick={() => block(t.callerNumber)}>Block</Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-6 text-center text-sm text-muted">No repeat offenders.</p>
          )}
        </Card>
      </div>

      {/* Recent blocked calls */}
      <Card flush className="overflow-hidden">
        <CardHeader title="Recently blocked calls" className="px-5 pt-5">
          <Link href="/calls" className="text-[13px] font-medium text-accent">All calls →</Link>
        </CardHeader>
        <div className="mt-4 overflow-x-auto">
          {o?.recent.length === 0 ? (
            <Empty icon={ShieldCheck} title="No blocked calls" text="Spam protection hasn't stopped any calls in this period." />
          ) : (
            <table className={`${table.wrap} min-w-[820px]`}>
              <thead className={table.head}>
                <tr>
                  <th>When</th>
                  <th>Caller</th>
                  <th>Campaign</th>
                  <th>Reason</th>
                  <th className="text-right">Spam score</th>
                  <th>Caller ID check</th>
                  <th>Line</th>
                </tr>
              </thead>
              <tbody>
                {o?.recent.map((c) => (
                  <tr key={c.id} className={table.row}>
                    <td className="whitespace-nowrap text-xs text-muted">{shortDateTime(c.startedAt)}</td>
                    <td className="whitespace-nowrap">
                      <span className="font-mono">{caller(c.callerNumber)}</span>
                      {c.callerState && <span className="ml-1.5 text-xs text-faint">{c.callerState}</span>}
                    </td>
                    <td className="max-w-[180px] truncate">{c.campaign?.name ?? '—'}</td>
                    <td><Badge tone="red" dot>{REASON_HELP[c.rejectReason] ?? c.rejectReason}</Badge></td>
                    <td className={`text-right font-mono tabular ${c.spamScore !== null && c.spamScore >= 75 ? 'text-danger' : ''}`}>{c.spamScore ?? '—'}</td>
                    <td className="text-xs">{c.attestation ? `Grade ${c.attestation}` : <span className="text-faint">Not signed</span>}</td>
                    <td className="text-xs text-muted">{c.lineType?.replace(/_/g, ' ') ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

export default function SpamPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER']}>
      <SpamContent />
    </AppShell>
  );
}
