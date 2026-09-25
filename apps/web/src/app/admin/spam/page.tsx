'use client';

import { useState, type FormEvent } from 'react';
import { Ban, Gauge, KeyRound, Plus, Search, ShieldAlert, ShieldCheck, Trash2, Users } from 'lucide-react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { REASONS } from '@/components/call-drawer';
import { Alert, Badge, Button, Card, CardHeader, Empty, Field, IconButton, PageHeader, Stat, StatStrip, table } from '@/components/ui';
import { api, formatPhone, shortDateTime } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

interface Overview {
  reputation: { provider: string; configured: boolean; source: 'admin' | 'env' | null; keyHint: string | null };
  totalCalls30d: number;
  byReason: Record<string, number>;
  topCallers: { callerNumber: string; calls: number; customers: number; globallyBlocked: boolean }[];
  blocks: { id: string; pattern: string; reason: string | null; createdAt: string }[];
}

const show = (n: string) => (/^\+\d+$/.test(n) ? formatPhone(n) : n);

function ReputationCard({ o, onSaved }: { o: Overview; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [number, setNumber] = useState('');
  const [result, setResult] = useState<{ number: string; score: number | null; lineType: string | null } | null>(null);
  const act = useAction();

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (await act.run(() => api('/admin/spam/reputation', { method: 'PUT', json: { apiKey: key.trim() } }), 'API key saved')) {
      setKey('');
      onSaved();
    }
  }

  async function lookup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setResult(null);
    await act.run(async () => setResult(await api('/admin/spam/lookup', { method: 'POST', json: { number } })));
  }

  const r = o.reputation;
  return (
    <Card>
      <CardHeader icon={Gauge} title="Spam-score lookups" subtitle={`${r.provider} scores each caller 0–100 and flags VoIP lines. Used by campaigns with “Reject high spam scores” on; results are cached for 7 days.`}>
        {r.configured ? <Badge tone="green" dot>On{r.source === 'env' ? ' (from .env)' : ''}</Badge> : <Badge dot>Off</Badge>}
      </CardHeader>
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
      {act.notice && <div className="mt-3"><Success>{act.notice}</Success></div>}
      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        <form onSubmit={save} className="space-y-3">
          <Field
            label="IPQualityScore API key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={r.keyHint ? `Saved (${r.keyHint}) — enter a new one to replace` : 'Paste your API key'}
            hint="ipqualityscore.com → Account settings → API key. Stored encrypted. Each new number looked up uses one credit."
          />
          <div className="flex gap-2">
            <Button type="submit" icon={KeyRound} disabled={act.busy || !key.trim()}>Save key</Button>
            {r.source === 'admin' && (
              <Button type="button" variant="secondary" onClick={() => confirm('Remove the key? Spam-score rules stop working.') && act.run(() => api('/admin/spam/reputation', { method: 'PUT', json: { apiKey: null } }), 'Key removed').then(onSaved)}>
                Remove
              </Button>
            )}
          </div>
        </form>
        <form onSubmit={lookup} className="space-y-3">
          <Field label="Test a number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+13055550100" hint="Looks it up live (uses a credit)." />
          <Button type="submit" variant="secondary" icon={Search} disabled={act.busy || !r.configured || !number.trim()}>Look up</Button>
          {result && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-subtle/60 px-3 py-2 text-sm">
              <span className="font-mono">{show(result.number)}</span>
              <Badge tone={result.score !== null && result.score >= 75 ? 'red' : result.score !== null && result.score >= 50 ? 'yellow' : 'green'}>Score {result.score ?? '—'}</Badge>
              {result.lineType && <span className="text-muted">{result.lineType.replace(/_/g, ' ')}</span>}
            </div>
          )}
        </form>
      </div>
    </Card>
  );
}

function SpamAdminContent() {
  const { data: o, reload } = useApi<Overview>('/admin/spam');
  const act = useAction();
  const [pattern, setPattern] = useState('');

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    if (await act.run(() => api('/admin/spam/blocks', { method: 'POST', json: { pattern, reason: reason || null } }), `${pattern} blocked for every customer`)) {
      setPattern('');
      (e.target as HTMLFormElement).reset();
      reload();
    }
  }

  const blockEverywhere = (n: string) =>
    act.run(() => api('/admin/spam/blocks', { method: 'POST', json: { pattern: n, reason: 'Blocked from spam report' } }), `${show(n)} blocked for every customer`).then(reload);
  const remove = (b: Overview['blocks'][number]) =>
    confirm(`Unblock ${b.pattern} for every customer?`) && act.run(() => api(`/admin/spam/blocks/${b.id}`, { method: 'DELETE' }), `${b.pattern} unblocked`).then(reload);

  const blocked = Object.values(o?.byReason ?? {}).reduce((s, n) => s + n, 0);
  const reasons = Object.entries(o?.byReason ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={ShieldAlert} title="Spam protection" subtitle="Platform-wide blocklist and spam-score lookups. Each customer also sets rules per campaign." />
      {act.error && <Alert>{act.error}</Alert>}
      {act.notice && <Success>{act.notice}</Success>}

      <StatStrip cols={4}>
        <Stat icon={Ban} label="Blocked calls (30 days)" value={o ? blocked.toLocaleString() : '—'} foot={o && o.totalCalls30d ? `${Math.round((blocked / o.totalCalls30d) * 100)}% of all calls` : undefined} />
        <Stat icon={ShieldAlert} label="Top reason" value={reasons[0] ? REASONS[reasons[0][0]] ?? reasons[0][0] : '—'} foot={reasons[0] ? `${reasons[0][1]} calls` : undefined} />
        <Stat icon={ShieldCheck} label="Platform blocklist" value={o ? o.blocks.length : '—'} foot="numbers and prefixes" />
        <Stat icon={Gauge} label="Spam scores" value={o ? (o.reputation.configured ? 'On' : 'Off') : '—'} foot={o?.reputation.provider} />
      </StatStrip>

      {o && <ReputationCard o={o} onSaved={reload} />}

      <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
        <Card flush className="overflow-hidden">
          <CardHeader icon={Ban} title="Platform blocklist" subtitle="Rejected for every customer. End a prefix with * to block a range." className="px-5 pt-5" />
          <form onSubmit={add} className="flex flex-wrap items-end gap-2 px-5 pt-4">
            <div className="w-48"><Field label="Number or prefix" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="+13055550100 or +1900*" required /></div>
            <div className="min-w-0 flex-1"><Field label="Reason (optional)" name="reason" maxLength={200} placeholder="e.g. Robocaller, FTC complaint" /></div>
            <Button type="submit" icon={Plus} disabled={act.busy || !pattern.trim()}>Block</Button>
          </form>
          <div className="mt-4 overflow-x-auto">
            {o?.blocks.length === 0 ? (
              <Empty icon={ShieldCheck} title="Nothing blocked platform-wide" text="Add known robocallers or premium-rate prefixes here to protect every customer." />
            ) : (
              <table className={`${table.wrap} min-w-[520px]`}>
                <thead className={table.head}>
                  <tr>
                    <th>Pattern</th>
                    <th>Reason</th>
                    <th>Added</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {o?.blocks.map((b) => (
                    <tr key={b.id} className={table.row}>
                      <td className="whitespace-nowrap">
                        <span className="font-mono">{b.pattern.endsWith('*') ? b.pattern : show(b.pattern)}</span>
                        {b.pattern.endsWith('*') && <Badge>Prefix</Badge>}
                      </td>
                      <td className="text-muted">{b.reason ?? '—'}</td>
                      <td className="whitespace-nowrap text-xs text-muted">{shortDateTime(b.createdAt)}</td>
                      <td className="text-right"><IconButton icon={Trash2} aria-label={`Unblock ${b.pattern}`} onClick={() => remove(b)} className="h-8 w-8 hover:text-danger" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader icon={Users} title="Most blocked callers (30 days)" subtitle="Across all customers. Hitting several customers is a strong spam signal." />
          {o?.topCallers.length ? (
            <ul className="mt-4 divide-y divide-border">
              {o.topCallers.map((t) => (
                <li key={t.callerNumber} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-mono">{show(t.callerNumber)}</span>
                    <span className="block text-xs text-muted">{t.calls} calls · {t.customers} customer{t.customers === 1 ? '' : 's'}</span>
                  </span>
                  {t.globallyBlocked || !/^\+\d+$/.test(t.callerNumber) ? (
                    <Badge>{t.globallyBlocked ? 'Blocked' : 'Hidden ID'}</Badge>
                  ) : (
                    <Button variant="subtle" size="sm" icon={Ban} onClick={() => blockEverywhere(t.callerNumber)}>Block everywhere</Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-6 text-center text-sm text-muted">No blocked callers yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function AdminSpamPage() {
  return (
    <AppShell allow={['SUPER_ADMIN']}>
      <SpamAdminContent />
    </AppShell>
  );
}
