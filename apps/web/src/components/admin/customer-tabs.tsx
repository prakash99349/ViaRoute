'use client';

import { useState, type FormEvent } from 'react';
import {
  ArrowLeftRight, Ban, Hash, KeyRound, LogOut, Mail, MessageSquareText, PhoneIncoming, Receipt, RotateCcw, ShieldOff, Timer,
  Trash2, TrendingUp, Undo2, UserCheck, Users,
} from 'lucide-react';
import { Success } from '@/components/auth-card';
import { BarChart, Legend, type Series } from '@/components/charts';
import { Alert, Badge, Button, Card, CardHeader, Empty, Field, IconButton, Modal, Select, Stat, StatStrip, table } from '@/components/ui';
import { api, formatPhone, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

export interface Customer {
  id: string;
  name: string;
  subdomain: string;
  status: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  suspendReason: string | null;
  closedAt: string | null;
  timezone: string;
  walletBalance: string;
  lowBalanceThreshold: string;
  createdAt: string;
  trialEndsAt: string | null;
  billingRenewsAt: string | null;
  perMinuteRate: string | null;
  numberPriceLocal: string | null;
  numberPriceTollFree: string | null;
  includedNumbers: number | null;
  maxConcurrentCalls: number | null;
  maxNumbers: number | null;
  plan: { id: string; code: string; name: string; monthlyPrice: string; perMinuteRate: string; includedNumbers: number; maxUsers: number | null } | null;
  platformPrices: { perMinuteRate: number; numberPrice: { LOCAL: number; TOLL_FREE: number } };
  owner: { id: string; name: string; email: string; lastLoginAt: string | null } | null;
  providerId: string | null;
  carrier: { id: string; name: string; type: string; status: string } | null;
  margin30d: { usageIncome: number; usageCarrierCost: number; numbersIncome: number; numbersCarrierCost: number };
  liveCalls: number;
  calls30d: number;
  income30d: string;
  lastCallAt: string | null;
  counts: { users: number; calls: number; campaigns: number; phoneNumbers: number; notes: number };
}

const dateTime = (s: string) => new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const dateOnly = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
/** "2026-10-25T…" → "2026-10-25" for <input type="date"> */
const toInput = (s: string | null) => (s ? s.slice(0, 10) : '');

// ---------------------------------------------------------------------------
// Usage (also used on Overview)

interface Usage {
  days: { day: string; calls: number; converted: number; minutes: number; usage: number; subscription: number; topups: number }[];
  totals: { calls: number; converted: number; minutes: number; income: number; byType: Record<string, number> };
}

const CALL_SERIES: Series[] = [
  { key: 'converted', label: 'Converted', color: 'var(--series-1)' },
  { key: 'other', label: 'Other calls', color: 'var(--series-1-soft)' },
];
const MONEY_SERIES: Series[] = [
  { key: 'usage', label: 'Call usage', color: 'var(--series-1)' },
  { key: 'subscription', label: 'Plan & numbers', color: 'var(--series-3)' },
];

export function UsageTab({ c, compact }: { c: Customer; compact?: boolean }) {
  const [days, setDays] = useState(30);
  const { data } = useApi<Usage>(`/admin/tenants/${c.id}/usage?days=${days}`);
  const t = data?.totals;
  return (
    <div className="space-y-4">
      {!compact && (
        <div className="flex items-center justify-between">
          <div className="w-40">
            <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </Select>
          </div>
        </div>
      )}
      {!compact && (
        <StatStrip cols={4}>
          <Stat icon={PhoneIncoming} label="Calls" value={t ? t.calls.toLocaleString() : '—'} foot={t ? `${t.converted.toLocaleString()} converted` : undefined} />
          <Stat icon={Timer} label="Billed minutes" value={t ? t.minutes.toLocaleString() : '—'} foot="caller + buyer legs" />
          <Stat icon={TrendingUp} label="Income to you" value={t ? money(t.income) : '—'} foot="usage, plan and numbers, after refunds" />
          <Stat icon={Receipt} label="Top-ups" value={t ? money(t.byType.TOPUP ?? 0) : '—'} />
        </StatStrip>
      )}
      <div className={`grid gap-4 ${compact ? '' : 'lg:grid-cols-2'}`}>
        <Card>
          <CardHeader title="Calls per day"><Legend series={CALL_SERIES} /></CardHeader>
          <div className="mt-3">
            <BarChart data={data?.days ?? []} x={(d) => d.day} series={CALL_SERIES} stacked integer value={(d, k) => (k === 'converted' ? d.converted : d.calls - d.converted)} />
          </div>
        </Card>
        {!compact && (
          <Card>
            <CardHeader title="What they paid per day"><Legend series={MONEY_SERIES} /></CardHeader>
            <div className="mt-3">
              <BarChart data={data?.days ?? []} x={(d) => d.day} series={MONEY_SERIES} stacked value={(d, k) => (k === 'usage' ? d.usage : d.subscription)} format={(v) => (v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`)} />
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan, prices & limits

export function PlanTab({ c, onSaved }: { c: Customer; onSaved: () => void }) {
  const { data: plans } = useApi<{ id: string; name: string; monthlyPrice: string; perMinuteRate: string; includedNumbers: number; active: boolean }[]>('/admin/plans');
  const { data: carriers } = useApi<{ id: string; name: string; type: string; status: string; isDefault: boolean }[]>('/admin/providers');
  const { busy, error, notice, run } = useAction();
  const [planId, setPlanId] = useState(c.plan?.id ?? '');
  const plan = plans?.find((p) => p.id === planId);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (String(f.get(k) ?? '').trim() === '' ? null : Number(f.get(k)));
    const date = (k: string) => (String(f.get(k) ?? '') ? new Date(`${f.get(k)}T12:00:00Z`).toISOString() : null);
    const json = {
      planId: planId || undefined,
      ...(c.status === 'TRIAL' ? { trialEndsAt: date('trialEndsAt') } : {}),
      ...(c.status === 'ACTIVE' || c.status === 'SUSPENDED' ? { billingRenewsAt: date('billingRenewsAt') } : {}),
      lowBalanceThreshold: Number(f.get('lowBalanceThreshold')),
      perMinuteRate: num('perMinuteRate'),
      numberPriceLocal: num('numberPriceLocal'),
      numberPriceTollFree: num('numberPriceTollFree'),
      includedNumbers: num('includedNumbers'),
      maxConcurrentCalls: num('maxConcurrentCalls'),
      maxNumbers: num('maxNumbers'),
      providerId: String(f.get('providerId') ?? '') || null,
    };
    if (await run(() => api(`/admin/tenants/${c.id}`, { method: 'PATCH', json }), 'Saved. Changes apply to new calls and numbers right away.')) onSaved();
  }

  const planRate = plan?.perMinuteRate ?? c.plan?.perMinuteRate;
  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <Alert>{error}</Alert>}
      {notice && <Success>{notice}</Success>}
      <Card>
        <CardHeader title="Plan & billing dates" subtitle="Plan changes take effect now; the new price is charged at the next renewal." />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select label="Plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {!c.plan && <option value="">No plan</option>}
            {plans?.map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.monthlyPrice)}/mo{p.active ? '' : ' (hidden)'}</option>)}
          </Select>
          {c.status === 'TRIAL' && <Field label="Trial ends" name="trialEndsAt" type="date" defaultValue={toInput(c.trialEndsAt)} hint="Extend or shorten the trial." />}
          {(c.status === 'ACTIVE' || c.status === 'SUSPENDED') && (
            <Field label="Next renewal" name="billingRenewsAt" type="date" defaultValue={toInput(c.billingRenewsAt)} hint="Next plan + number charge." />
          )}
          <Field label="Low-balance alert ($)" name="lowBalanceThreshold" type="number" min={0} step="0.01" defaultValue={c.lowBalanceThreshold} hint="Email when the wallet drops below." />
        </div>
      </Card>

      <Card>
        <CardHeader title="Custom prices" subtitle="Leave empty to use the plan / platform price. Applies from the next call or number." />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Per minute ($)" name="perMinuteRate" type="number" min={0} max={10} step="0.0001" defaultValue={c.perMinuteRate ?? ''} placeholder={`${planRate ?? c.platformPrices.perMinuteRate} (plan)`} />
          <Field label="Local number ($/mo)" name="numberPriceLocal" type="number" min={0} step="0.01" defaultValue={c.numberPriceLocal ?? ''} placeholder={`${c.platformPrices.numberPrice.LOCAL} (standard)`} />
          <Field label="Toll-free number ($/mo)" name="numberPriceTollFree" type="number" min={0} step="0.01" defaultValue={c.numberPriceTollFree ?? ''} placeholder={`${c.platformPrices.numberPrice.TOLL_FREE} (standard)`} />
          <Field label="Included numbers" name="includedNumbers" type="number" min={0} defaultValue={c.includedNumbers ?? ''} placeholder={`${plan?.includedNumbers ?? c.plan?.includedNumbers ?? 0} (plan)`} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Safety limits" subtitle="Protect the platform from runaway usage or abuse. Empty = no limit." />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Concurrent calls (whole account)" name="maxConcurrentCalls" type="number" min={1} defaultValue={c.maxConcurrentCalls ?? ''} placeholder="No limit" hint="Extra calls are rejected." />
          <Field label="Max phone numbers" name="maxNumbers" type="number" min={0} defaultValue={c.maxNumbers ?? ''} placeholder="No limit" hint={`They have ${c.counts.phoneNumbers} now.`} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Carrier" subtitle="Where this customer's new numbers are bought. Existing numbers stay on their carrier." />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select label="Carrier for new numbers" name="providerId" defaultValue={c.providerId ?? ''}>
            <option value="">Platform default{carriers ? ` (${carriers.find((x) => x.isDefault)?.name ?? '—'})` : ''}</option>
            {carriers?.filter((x) => x.status === 'ACTIVE' || x.id === c.providerId).map((x) => <option key={x.id} value={x.id}>{x.name}{x.status !== 'ACTIVE' ? ` (${x.status.toLowerCase()})` : ''}</option>)}
          </Select>
        </div>
      </Card>
      <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Wallet & transactions

interface Tx {
  id: string;
  type: string;
  amount: string;
  balanceAfter: string;
  description: string | null;
  createdAt: string;
  refunded: boolean;
  refundable: boolean;
}

const TX_LABEL: Record<string, string> = {
  TOPUP: 'Top-up', SUBSCRIPTION: 'Plan', CALL_USAGE: 'Call usage', NUMBER_RENTAL: 'Numbers', RECORDING: 'Recording', ADJUSTMENT: 'Adjustment', REFUND: 'Refund',
};

export function WalletTab({ c, onChanged, onCredit }: { c: Customer; onChanged: () => void; onCredit: () => void }) {
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const { data, reload } = useApi<{ items: Tx[]; total: number; pageSize: number }>(`/admin/tenants/${c.id}/transactions?page=${page}&pageSize=50${type ? `&type=${type}` : ''}`);
  const [refunding, setRefunding] = useState<Tx | null>(null);
  const act = useAction();
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  async function refund(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const note = String(new FormData(e.currentTarget).get('note') ?? '').trim();
    if (!refunding) return;
    const ok = await act.run(() => api(`/admin/transactions/${refunding.id}/refund`, { method: 'POST', json: { note: note || undefined } }), 'Refunded to their wallet');
    if (ok) {
      setRefunding(null);
      reload();
      onChanged();
    }
  }

  return (
    <div className="space-y-4">
      {act.notice && <Success>{act.notice}</Success>}
      <div className="flex flex-wrap items-center gap-3">
        <div className="rounded-xl border border-border bg-card px-4 py-2.5">
          <div className="text-xs text-muted">Wallet balance</div>
          <div className={`font-mono text-xl font-semibold tabular ${Number(c.walletBalance) <= 0 ? 'text-danger' : ''}`}>{money(c.walletBalance)}</div>
        </div>
        <Button onClick={onCredit}>Add or remove funds</Button>
        <div className="ml-auto w-44">
          <Select aria-label="Type" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
            <option value="">All types</option>
            {Object.entries(TX_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
      </div>
      <Card flush className="overflow-x-auto">
        {data?.items.length === 0 ? (
          <Empty icon={Receipt} title="No transactions" />
        ) : (
          <table className={`${table.wrap} min-w-[760px]`}>
            <thead className={table.head}>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Description</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Balance after</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data?.items.map((x) => (
                <tr key={x.id} className={table.row}>
                  <td className="whitespace-nowrap text-xs text-muted">{dateTime(x.createdAt)}</td>
                  <td><Badge tone={Number(x.amount) >= 0 ? 'green' : 'gray'}>{TX_LABEL[x.type] ?? x.type}</Badge></td>
                  <td className="max-w-[340px] truncate" title={x.description ?? undefined}>{x.description ?? '—'}</td>
                  <td className={`text-right font-mono tabular ${Number(x.amount) >= 0 ? 'text-success' : ''}`}>{Number(x.amount) >= 0 ? '+' : ''}{money(x.amount)}</td>
                  <td className="text-right font-mono tabular text-muted">{money(x.balanceAfter)}</td>
                  <td className="whitespace-nowrap text-right">
                    {x.refunded ? <Badge tone="blue">Refunded</Badge> : x.refundable && <Button variant="subtle" size="sm" icon={Undo2} onClick={() => setRefunding(x)}>Refund</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <span className="text-muted">Page {page} of {pages}</span>
          <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
      {refunding && (
        <Modal title="Refund charge" onClose={() => setRefunding(null)}>
          <form onSubmit={refund} className="space-y-4">
            {act.error && <Alert>{act.error}</Alert>}
            <p className="text-sm">
              Give <b className="font-mono">{money(-Number(refunding.amount))}</b> back to {c.name}&apos;s wallet for “{refunding.description ?? TX_LABEL[refunding.type]}”. A charge can only be refunded once.
            </p>
            <Field label="Note (optional)" name="note" maxLength={200} placeholder="e.g. Carrier outage on Sep 12" hint="Shown in their transaction history." />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setRefunding(null)}>Cancel</Button>
              <Button type="submit" disabled={act.busy}>{act.busy ? 'Refunding…' : 'Refund'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users

interface AccountUser {
  id: string;
  name: string;
  email: string;
  role: string;
  emailVerified: boolean;
  twofaEnabled: boolean;
  lastLoginAt: string | null;
  disabledAt: string | null;
  invited: boolean;
}

const ROLE_LABEL: Record<string, string> = { TENANT_ADMIN: 'Admin', MANAGER: 'Manager', PUBLISHER: 'Publisher', BUYER: 'Buyer' };
const ACTION_DONE: Record<string, string> = {
  reset_password: 'Password reset email sent',
  resend_invite: 'Invite sent again',
  disable_2fa: 'Two-factor turned off; they were signed out',
  logout: 'Signed out of every device',
  disable: 'Login disabled; they were signed out',
  enable: 'Login enabled',
};

export function UsersTab({ c }: { c: Customer }) {
  const { data, reload } = useApi<AccountUser[]>(`/admin/tenants/${c.id}/users`);
  const act = useAction();
  const run = (u: AccountUser, action: string, ask?: string) => {
    if (ask && !confirm(ask)) return;
    act.run(() => api(`/admin/users/${u.id}/actions`, { method: 'POST', json: { action } }), `${u.email}: ${ACTION_DONE[action]}`).then(reload);
  };

  return (
    <div className="space-y-4">
      {act.error && <Alert>{act.error}</Alert>}
      {act.notice && <Success>{act.notice}</Success>}
      <Card flush className="overflow-x-auto">
        {data?.length === 0 ? (
          <Empty icon={Users} title="No users" />
        ) : (
          <table className={`${table.wrap} min-w-[900px]`}>
            <thead className={table.head}>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Security</th>
                <th>Last login</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data?.map((u) => (
                <tr key={u.id} className={`${table.row} ${u.disabledAt ? 'opacity-60' : ''}`}>
                  <td>
                    <div className="font-medium">{u.name}</div>
                    <div className="text-xs text-faint">{u.email}</div>
                  </td>
                  <td>{ROLE_LABEL[u.role] ?? u.role}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {u.disabledAt ? <Badge tone="red" dot>Disabled</Badge> : u.invited ? <Badge tone="yellow" dot>Invited</Badge> : <Badge tone="green" dot>Active</Badge>}
                      {u.twofaEnabled && <Badge tone="blue">2FA</Badge>}
                      {!u.emailVerified && !u.invited && <Badge>Email not verified</Badge>}
                    </div>
                  </td>
                  <td className="text-xs text-muted">{u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Never'}</td>
                  <td className="whitespace-nowrap text-right">
                    {u.invited ? (
                      <Button variant="subtle" size="sm" icon={Mail} onClick={() => run(u, 'resend_invite')}>Resend invite</Button>
                    ) : (
                      <Button variant="subtle" size="sm" icon={KeyRound} onClick={() => run(u, 'reset_password', `Email ${u.email} a password reset link?`)}>Reset password</Button>
                    )}
                    {u.twofaEnabled && (
                      <IconButton icon={ShieldOff} aria-label={`Turn off 2FA for ${u.email}`} title="Turn off 2FA" onClick={() => run(u, 'disable_2fa', `Turn off two-factor for ${u.email}? Only do this after confirming who they are.`)} className="h-8 w-8" />
                    )}
                    <IconButton icon={LogOut} aria-label={`Sign ${u.email} out everywhere`} title="Sign out everywhere" onClick={() => run(u, 'logout')} className="h-8 w-8" />
                    {u.disabledAt ? (
                      <IconButton icon={UserCheck} aria-label={`Enable ${u.email}`} title="Enable login" onClick={() => run(u, 'enable')} className="h-8 w-8" />
                    ) : (
                      <IconButton icon={Ban} aria-label={`Disable ${u.email}`} title="Disable login" onClick={() => run(u, 'disable', `Disable ${u.email}? They are signed out and can't log in until you enable them.`)} className="h-8 w-8 hover:text-danger" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numbers

interface AdminNumber {
  id: string;
  e164: string;
  label: string | null;
  type: 'LOCAL' | 'TOLL_FREE';
  status: 'ACTIVE' | 'PENDING';
  monthlyPrice: string;
  carrierCost: string | null;
  provider: string;
  purchasedAt: string;
  campaign: { name: string } | null;
  publisher: { name: string } | null;
}

export function NumbersTab({ c }: { c: Customer }) {
  const { data, reload } = useApi<AdminNumber[]>(`/admin/tenants/${c.id}/numbers`);
  const { data: customers } = useApi<{ id: string; name: string; subdomain: string; status: string }[]>('/admin/tenants');
  const [moving, setMoving] = useState<AdminNumber | null>(null);
  const [adding, setAdding] = useState(false);
  const { data: carriers } = useApi<{ id: string; name: string; type: string; status: string; isDefault: boolean; numberLocalMonthly: string; numberTollFreeMonthly: string }[]>(adding ? '/admin/providers' : null);
  const [to, setTo] = useState('');
  const act = useAction();

  const release = (n: AdminNumber) =>
    confirm(`Release ${formatPhone(n.e164)}? Calls to it stop immediately and it may not be recoverable.`) &&
    act.run(() => api(`/admin/numbers/${n.id}`, { method: 'DELETE' }), `${formatPhone(n.e164)} released`).then(reload);

  async function move(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!moving || !to) return;
    const target = customers?.find((x) => x.id === to);
    if (await act.run(() => api(`/admin/numbers/${moving.id}/move`, { method: 'POST', json: { tenantId: to } }), `${formatPhone(moving.e164)} moved to ${target?.name}`)) {
      setMoving(null);
      setTo('');
      reload();
    }
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const cost = String(f.get('carrierCost') ?? '').trim();
    const json = {
      e164: String(f.get('e164') ?? '').replace(/[^\d+]/g, ''),
      providerId: f.get('providerId'),
      type: f.get('type'),
      monthlyPrice: Number(f.get('monthlyPrice') || 0),
      ...(cost ? { carrierCost: Number(cost) } : {}),
      label: String(f.get('label') ?? '').trim() || undefined,
    };
    if (await act.run(() => api(`/admin/tenants/${c.id}/numbers`, { method: 'POST', json }), `${formatPhone(json.e164)} added to ${c.name}`)) {
      setAdding(false);
      reload();
    }
  }

  return (
    <div className="space-y-4">
      {act.error && !moving && !adding && <Alert>{act.error}</Alert>}
      {act.notice && <Success>{act.notice}</Success>}
      <div className="flex justify-end">
        <Button variant="secondary" icon={Hash} onClick={() => { act.setError(''); setAdding(true); }}>Add existing number</Button>
      </div>
      <Card flush className="overflow-x-auto">
        {data?.length === 0 ? (
          <Empty icon={Hash} title="No numbers" />
        ) : (
          <table className={`${table.wrap} min-w-[900px]`}>
            <thead className={table.head}>
              <tr>
                <th>Number</th>
                <th>Campaign</th>
                <th>Publisher</th>
                <th>Status</th>
                <th className="text-right">They pay</th>
                <th className="text-right">Carrier cost</th>
                <th>Since</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data?.map((n) => (
                <tr key={n.id} className={table.row}>
                  <td>
                    <div className="font-mono font-medium">{formatPhone(n.e164)}</div>
                    <div className="text-xs text-faint">{n.label ?? (n.type === 'LOCAL' ? 'Local' : 'Toll-free')} · {n.provider}</div>
                  </td>
                  <td className={n.campaign ? '' : 'text-faint'}>{n.campaign?.name ?? 'Not assigned'}</td>
                  <td className={n.publisher ? '' : 'text-faint'}>{n.publisher?.name ?? '—'}</td>
                  <td>{n.status === 'ACTIVE' ? <Badge tone="green" dot>Active</Badge> : <Badge tone="yellow" dot>Activating</Badge>}</td>
                  <td className="text-right font-mono tabular">{Number(n.monthlyPrice) === 0 ? <span className="font-sans text-muted">Included</span> : money(n.monthlyPrice)}</td>
                  <td className="text-right font-mono tabular text-muted">{n.carrierCost !== null ? money(n.carrierCost) : '—'}</td>
                  <td className="text-xs text-muted">{dateOnly(n.purchasedAt)}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button variant="subtle" size="sm" icon={ArrowLeftRight} onClick={() => { act.setError(''); setMoving(n); }}>Move</Button>
                    {n.status === 'ACTIVE' && <IconButton icon={Trash2} aria-label={`Release ${formatPhone(n.e164)}`} onClick={() => release(n)} className="h-8 w-8 hover:text-danger" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {adding && (
        <Modal title={`Add a number to ${c.name}`} onClose={() => setAdding(false)}>
          <form onSubmit={add} className="space-y-4">
            {act.error && <Alert>{act.error}</Alert>}
            <p className="text-sm text-muted">For numbers you already have on a carrier — bought outside ViaRoute, or on a carrier without a numbers API. Nothing is ordered; make sure the carrier sends this number&apos;s calls to ViaRoute.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone number" name="e164" required placeholder="+14155550123" />
              <Select label="Carrier" name="providerId" required defaultValue="">
                <option value="" disabled>Choose…</option>
                {carriers?.map((x) => <option key={x.id} value={x.id}>{x.name}{x.isDefault ? ' (default)' : ''}</option>)}
              </Select>
              <Select label="Type" name="type" defaultValue="LOCAL">
                <option value="LOCAL">Local</option>
                <option value="TOLL_FREE">Toll-free</option>
              </Select>
              <Field label="Label (optional)" name="label" maxLength={60} placeholder="e.g. Main line" />
              <Field label="Customer pays ($/month)" name="monthlyPrice" type="number" min={0} step="0.01" required defaultValue="0" hint="Charged from their next renewal. 0 = included." />
              <Field label="Carrier cost ($/month)" name="carrierCost" type="number" min={0} step="0.0001" placeholder="Carrier's standard price" hint="For margin reports." />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" disabled={act.busy}>{act.busy ? 'Adding…' : 'Add number'}</Button>
            </div>
          </form>
        </Modal>
      )}
      {moving && (
        <Modal title={`Move ${formatPhone(moving.e164)}`} onClose={() => setMoving(null)}>
          <form onSubmit={move} className="space-y-4">
            {act.error && <Alert>{act.error}</Alert>}
            <p className="text-sm text-muted">The number is taken off its campaign and publisher. Past calls stay in {c.name}&apos;s history. Billing moves with it from the next renewal.</p>
            <Select label="Move to" value={to} onChange={(e) => setTo(e.target.value)} required>
              <option value="">Choose a customer…</option>
              {customers?.filter((x) => x.id !== c.id && x.status !== 'CLOSED').map((x) => <option key={x.id} value={x.id}>{x.name} ({x.subdomain})</option>)}
            </Select>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setMoving(null)}>Cancel</Button>
              <Button type="submit" disabled={act.busy || !to}>{act.busy ? 'Moving…' : 'Move number'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes

interface Note {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export function NotesTab({ c, onChanged }: { c: Customer; onChanged: () => void }) {
  const { data, reload } = useApi<Note[]>(`/admin/tenants/${c.id}/notes`);
  const [text, setText] = useState('');
  const act = useAction();

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (await act.run(() => api(`/admin/tenants/${c.id}/notes`, { method: 'POST', json: { body: text } }))) {
      setText('');
      reload();
      onChanged();
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        {data?.length === 0 && (
          <Card><Empty icon={MessageSquareText} title="No notes yet" text="Keep deal terms, contacts and support history here. Customers never see notes." /></Card>
        )}
        {data?.map((n) => (
          <Card key={n.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="text-xs text-muted"><b className="font-medium text-foreground">{n.authorName}</b> · {dateTime(n.createdAt)}</div>
              <IconButton
                icon={Trash2}
                aria-label="Delete note"
                onClick={() => confirm('Delete this note?') && act.run(() => api(`/admin/notes/${n.id}`, { method: 'DELETE' })).then(() => { reload(); onChanged(); })}
                className="h-7 w-7 hover:text-danger"
              />
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm">{n.body}</p>
          </Card>
        ))}
      </div>
      <Card className="h-fit">
        <form onSubmit={add} className="space-y-3">
          {act.error && <Alert>{act.error}</Alert>}
          <label htmlFor="note" className="block text-[13px] font-medium">Add a note</label>
          <textarea
            id="note"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            maxLength={4000}
            required
            placeholder="e.g. Agreed $0.018/min until March; main contact is Dana (ops)."
            className="w-full rounded-lg border border-border-strong bg-card px-3 py-2 text-sm outline-none focus:border-foreground/40"
          />
          <p className="text-xs text-muted">Only your team sees notes.</p>
          <Button type="submit" disabled={act.busy || !text.trim()}>Save note</Button>
        </form>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity

interface Activity {
  id: string;
  action: string;
  entity: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  user: { name: string; email: string; role: string } | null;
}

const ACTION_LABEL: Record<string, string> = {
  'admin.customer_create': 'Account created by the platform',
  'admin.customer_update': 'Account settings changed',
  'admin.customer_close': 'Account closed',
  'tenant.status': 'Status changed',
  'tenant.branding': 'Branding changed',
  'tenant.domain': 'Custom domain changed',
  'tenant.settings': 'Company settings changed',
  'wallet.adjust': 'Wallet adjusted',
  'wallet.refund': 'Charge refunded',
  'support.impersonate': 'Support login',
  'billing.plan_change': 'Plan changed by customer',
  'campaign.create': 'Campaign created',
  'campaign.update': 'Campaign edited',
  'campaign.delete': 'Campaign deleted',
  'number.release': 'Number released',
  'admin.number_move_in': 'Number moved in',
  'admin.number_move_out': 'Number moved out',
  'team.invite': 'Team member invited',
  'user.password_reset': 'Password reset',
};

function describe(a: Activity) {
  const label = ACTION_LABEL[a.action] ?? a.action.replace(/[._]/g, ' ');
  const m = a.meta ?? {};
  const bits: string[] = [];
  if (a.action === 'admin.customer_update') {
    for (const [k, v] of Object.entries(m)) {
      const ch = v as { from: unknown; to: unknown };
      if (ch && typeof ch === 'object' && 'to' in ch) bits.push(`${k}: ${ch.from ?? '—'} → ${ch.to ?? '—'}`);
    }
  } else {
    for (const [k, v] of Object.entries(m)) if (v !== null && v !== undefined && typeof v !== 'object') bits.push(`${k}: ${v}`);
  }
  return { label, detail: bits.join(' · ') };
}

export function ActivityTab({ c }: { c: Customer }) {
  const [page, setPage] = useState(1);
  const { data } = useApi<{ items: Activity[]; total: number; pageSize: number }>(`/admin/tenants/${c.id}/activity?page=${page}&pageSize=50`);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="space-y-4">
      <Card flush>
        {data?.items.length === 0 ? (
          <Empty icon={RotateCcw} title="No activity yet" />
        ) : (
          <ol className="divide-y divide-border">
            {data?.items.map((a) => {
              const d = describe(a);
              const byAdmin = a.user?.role === 'SUPER_ADMIN';
              return (
                <li key={a.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3">
                  <span className="w-40 shrink-0 text-xs text-muted">{dateTime(a.createdAt)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {d.label}
                      {byAdmin && <Badge tone="blue">Platform</Badge>}
                    </div>
                    {d.detail && <div className="mt-0.5 break-words font-mono text-xs text-muted">{d.detail}</div>}
                  </div>
                  <span className="text-xs text-muted">{a.user ? `${a.user.name}` : 'System'}</span>
                </li>
              );
            })}
          </ol>
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

