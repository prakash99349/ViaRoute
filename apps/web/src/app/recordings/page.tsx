'use client';

import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { CircleCheck, Download, HardDrive, Mic, Pause, Play, Search, Trash2 } from 'lucide-react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { DateRangePicker } from '@/components/date-range-picker';
import { Alert, Badge, Button, Card, Empty, IconButton, PageHeader, Select, Stat, StatStrip, table } from '@/components/ui';
import { api, API_BASE, duration, formatPhone, shortDateTime } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { rangeQuery, useDateRange } from '@/lib/date-range';
import { useAction, useApi } from '@/lib/use-api';

interface Recording {
  id: string;
  startedAt: string;
  callerNumber: string;
  callerState: string | null;
  connectedSec: number;
  converted: boolean;
  recordingSize: number | null;
  ivrPath: string | null;
  campaign: { name: string } | null;
  buyer: { name: string } | null;
  target: { name: string } | null;
  playUrl: string;
  downloadUrl: string;
}

interface Page {
  items: Recording[];
  total: number;
  page: number;
  pageSize: number;
  storage?: { recordings: number; bytes: number; retentionDays: number | null };
}

const size = (b: number | null) => (!b ? '—' : b < 1_048_576 ? `${Math.round(b / 1024)} KB` : b < 1_073_741_824 ? `${(b / 1_048_576).toFixed(1)} MB` : `${(b / 1_073_741_824).toFixed(2)} GB`);
const phone = (n: string) => (/^\+\d+$/.test(n) ? formatPhone(n) : n);

function RecordingsContent() {
  const { user } = useAuth();
  const staff = user?.role === 'TENANT_ADMIN' || user?.role === 'MANAGER';
  const { range, setRange, ready } = useDateRange('30d');
  const [q, setQ] = useState('');
  const [campaign, setCampaign] = useState('');
  const [converted, setConverted] = useState('');
  const [minTalk, setMinTalk] = useState('');
  const [page, setPage] = useState(1);
  const [playing, setPlaying] = useState<string | null>(null);
  const { data: campaigns } = useApi<{ id: string; name: string }[]>(staff ? '/campaigns' : null);
  const act = useAction();

  const query = useMemo(() => {
    const p = new URLSearchParams(rangeQuery(range));
    if (q.replace(/\D/g, '')) p.set('q', q.replace(/\D/g, ''));
    if (campaign) p.set('campaignId', campaign);
    if (converted) p.set('converted', converted);
    if (minTalk) p.set('minTalk', minTalk);
    p.set('page', String(page));
    return p.toString();
  }, [range, q, campaign, converted, minTalk, page]);
  const { data, reload, loading } = useApi<Page>(ready ? `/recordings?${query}` : null);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const remove = (r: Recording) =>
    confirm(`Delete the recording of ${phone(r.callerNumber)} on ${shortDateTime(r.startedAt)}? This can't be undone.`) &&
    act.run(() => api(`/recordings/${r.id}`, { method: 'DELETE' }), 'Recording deleted').then(reload);

  const s = data?.storage;
  return (
    <div className="w-full space-y-5">
      <PageHeader icon={Mic} title="Recordings" subtitle="Listen to and download call recordings.">
        <DateRangePicker value={range} onChange={(r) => { setRange(r); setPage(1); }} />
      </PageHeader>
      {act.error && <Alert>{act.error}</Alert>}
      {act.notice && <Success>{act.notice}</Success>}

      {s && (
        <StatStrip cols={3}>
          <Stat icon={Mic} label="Recordings kept" value={s.recordings.toLocaleString()} />
          <Stat icon={HardDrive} label="Storage used" value={size(s.bytes)} />
          <Stat
            icon={Trash2}
            label="Kept for"
            value={s.retentionDays ? `${s.retentionDays} days` : 'Forever'}
            foot={user?.role === 'TENANT_ADMIN' ? <Link href="/settings" className="text-accent">Change in Settings</Link> : 'then deleted automatically'}
          />
        </StatStrip>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-9 w-full items-center gap-2 rounded-lg border border-border-strong bg-card px-3 text-sm focus-within:border-foreground/40 sm:w-56">
          <Search size={15} className="text-faint" aria-hidden />
          <input aria-label="Caller number" placeholder="Caller number…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" inputMode="numeric" />
        </label>
        {staff && (
          <div className="w-48">
            <Select aria-label="Campaign" value={campaign} onChange={(e) => { setCampaign(e.target.value); setPage(1); }}>
              <option value="">All campaigns</option>
              {campaigns?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        )}
        <div className="w-40">
          <Select aria-label="Converted" value={converted} onChange={(e) => { setConverted(e.target.value); setPage(1); }}>
            <option value="">All calls</option>
            <option value="true">Converted</option>
            <option value="false">Not converted</option>
          </Select>
        </div>
        <div className="w-40">
          <Select aria-label="Talk time" value={minTalk} onChange={(e) => { setMinTalk(e.target.value); setPage(1); }}>
            <option value="">Any length</option>
            <option value="30">30 s or more</option>
            <option value="60">1 min or more</option>
            <option value="180">3 min or more</option>
            <option value="600">10 min or more</option>
          </Select>
        </div>
        <span className="ml-auto text-xs text-muted">{data ? `${data.total.toLocaleString()} recording${data.total === 1 ? '' : 's'}` : ''}</span>
      </div>

      <Card flush className="overflow-x-auto">
        {data?.items.length === 0 ? (
          <Empty icon={Mic} title="No recordings" text="Turn on “Record calls” in a campaign's settings. Recordings appear here shortly after each call." />
        ) : (
          <table className={`${table.wrap} min-w-[900px]`}>
            <thead className={table.head}>
              <tr>
                <th className="w-12" aria-label="Play" />
                <th>When</th>
                <th>Caller</th>
                <th>Campaign</th>
                {user?.role !== 'AGENT' && <th>Answered by</th>}
                <th className="text-right">Talk</th>
                <th className="text-right">Size</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody className={loading ? 'opacity-60' : ''}>
              {data?.items.map((r) => (
                <Fragment key={r.id}>
                  <tr className={table.row}>
                    <td>
                      <IconButton
                        icon={playing === r.id ? Pause : Play}
                        aria-label={playing === r.id ? 'Close player' : `Play recording of ${phone(r.callerNumber)}`}
                        onClick={() => setPlaying(playing === r.id ? null : r.id)}
                        className={`h-8 w-8 ${playing === r.id ? 'bg-subtle text-foreground' : ''}`}
                      />
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted">{shortDateTime(r.startedAt)}</td>
                    <td className="whitespace-nowrap">
                      <span className="font-mono">{phone(r.callerNumber)}</span>
                      {r.callerState && <span className="ml-1.5 text-xs text-faint">{r.callerState}</span>}
                      {r.converted && <span className="ml-2"><Badge tone="green"><CircleCheck size={11} aria-hidden /> Converted</Badge></span>}
                    </td>
                    <td className="max-w-[200px] truncate">{r.campaign?.name ?? '—'}</td>
                    {user?.role !== 'AGENT' && <td className="max-w-[180px] truncate">{r.target?.name ?? r.buyer?.name ?? '—'}</td>}
                    <td className="text-right font-mono tabular">{duration(r.connectedSec)}</td>
                    <td className="text-right font-mono text-xs text-muted tabular">{size(r.recordingSize)}</td>
                    <td className="whitespace-nowrap text-right">
                      <a href={`${API_BASE}${r.downloadUrl}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted hover:bg-subtle hover:text-foreground">
                        <Download size={14} aria-hidden /> Download
                      </a>
                      {user?.role === 'TENANT_ADMIN' && <IconButton icon={Trash2} aria-label="Delete recording" onClick={() => remove(r)} className="h-8 w-8 hover:text-danger" />}
                    </td>
                  </tr>
                  {playing === r.id && (
                    <tr className="border-b border-border bg-subtle/40">
                      <td colSpan={8} className="px-5 py-3">
                        <audio controls autoPlay className="w-full" src={`${API_BASE}${r.playUrl}`} />
                        {r.ivrPath && <p className="mt-1 text-xs text-muted">IVR: {r.ivrPath}</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
          <span className="text-muted">Page {page} of {pages}</span>
          <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older</Button>
        </div>
      )}
    </div>
  );
}

export default function RecordingsPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER', 'BUYER', 'AGENT']}>
      <RecordingsContent />
    </AppShell>
  );
}
