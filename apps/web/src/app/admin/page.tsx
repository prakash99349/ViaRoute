'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  ArrowDown, ArrowUp, Ban, Building2, CircleDollarSign, Crown, Download, ExternalLink, FlaskConical, Landmark, LogIn, MoreHorizontal, PlayCircle,
  Plus, Search, TrendingUp, Wallet,
} from 'lucide-react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { BarChart, type Series } from '@/components/charts';
import { CreditForm, loginAs, NewCustomerForm, STATUS_LABEL, STATUS_TONE, SuspendForm } from '@/components/admin/customer-actions';
import { Alert, Badge, Button, Card, Empty, Initials, Modal, PageHeader, Select, Stat, StatStrip, table } from '@/components/ui';
import { api, money, portalUrl } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import type { TenantStatus } from '@/lib/types';

interface Stats {
  tenants: number;
  active: number;
  trial: number;
  suspended: number;
  users: number;
  calls: number;
  numbers: number;
  incomeThisMonth: string | number;
  carrierCostThisMonth: string | number;
  walletFloat: string | number;
  daily: { day: string; calls: number; income: number }[];
}

interface CustomerRow {
  id: string;
  name: string;
  portalName: string | null;
  subdomain: string;
  status: TenantStatus;
  suspendReason: string | null;
  walletBalance: string;
  lowWallet: boolean;
  createdAt: string;
  trialEndsAt: string | null;
  billingRenewsAt: string | null;
  customDomain: string | null;
  customDomainVerified: boolean;
  plan: { id: string; name: string } | null;
  owner: { name: string; email: string } | null;
  calls30d: number;
  income30d: string;
  lastCallAt: string | null;
  numbers: number;
  _count: { users: number };
}

type SortKey = 'name' | 'created' | 'wallet' | 'calls' | 'income' | 'lastCall' | 'renews';

const CALLS: Series[] = [{ key: 'calls', label: 'Calls', color: 'var(--series-1)' }];
const INCOME: Series[] = [{ key: 'income', label: 'Income', color: 'var(--series-3)' }];

const renewal = (c: CustomerRow) => (c.status === 'TRIAL' ? c.trialEndsAt : c.status === 'ACTIVE' ? c.billingRenewsAt : null);
const shortDate = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
function ago(s: string | null) {
  if (!s) return 'Never';
  const d = (Date.now() - new Date(s).getTime()) / 86400_000;
  return d < 1 ? 'Today' : d < 2 ? 'Yesterday' : d < 30 ? `${Math.floor(d)} days ago` : shortDate(s);
}

function csvCell(v: unknown) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(rows: CustomerRow[]) {
  const header = ['Customer', 'Portal', 'Owner', 'Owner email', 'Plan', 'Status', 'Wallet', 'Calls (30d)', 'Income (30d)', 'Numbers', 'Users', 'Last call', 'Renews / trial ends', 'Signed up'];
  const lines = rows.map((c) => [
    c.name, c.subdomain, c.owner?.name, c.owner?.email, c.plan?.name, STATUS_LABEL[c.status], Number(c.walletBalance).toFixed(2), c.calls30d,
    Number(c.income30d).toFixed(2), c.numbers, c._count.users, c.lastCallAt?.slice(0, 10), renewal(c)?.slice(0, 10), c.createdAt.slice(0, 10),
  ]);
  const blob = new Blob(['﻿' + [header, ...lines].map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Sortable column header. */
function Th({ k, sort, onSort, children, right }: { k: SortKey; sort: { key: SortKey; dir: 1 | -1 }; onSort: (k: SortKey) => void; children: string; right?: boolean }) {
  return (
    <th className={right ? 'text-right' : ''} aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => onSort(k)} className={`inline-flex items-center gap-1 hover:text-foreground ${sort.key === k ? 'text-foreground' : ''}`}>
        {children}
        {sort.key === k && (sort.dir === 1 ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
      </button>
    </th>
  );
}

function AdminContent() {
  const router = useRouter();
  const { data: stats } = useApi<Stats>('/admin/stats');
  const { data: customers, reload } = useApi<CustomerRow[]>('/admin/tenants');
  const { data: plans } = useApi<{ id: string; name: string }[]>('/admin/plans');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | TenantStatus | 'open'>('open');
  const [plan, setPlan] = useState('');
  const [flag, setFlag] = useState<'' | 'lowWallet' | 'inactive' | 'domain'>('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'created', dir: -1 });
  const [modal, setModal] = useState<{ kind: 'new' } | { kind: 'credit' | 'suspend'; c: CustomerRow } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (customers ?? []).filter(
      (c) =>
        (!needle || [c.name, c.portalName, c.subdomain, c.customDomain, c.owner?.email, c.owner?.name].some((v) => v?.toLowerCase().includes(needle))) &&
        (!status || (status === 'open' ? c.status !== 'CLOSED' : c.status === status)) &&
        (!plan || c.plan?.id === plan) &&
        (!flag ||
          (flag === 'lowWallet' && c.lowWallet) ||
          (flag === 'inactive' && (!c.lastCallAt || now - new Date(c.lastCallAt).getTime() > 14 * 86400_000)) ||
          (flag === 'domain' && !!c.customDomain)),
    );
    const val = (c: CustomerRow): number | string => {
      switch (sort.key) {
        case 'name': return c.name.toLowerCase();
        case 'created': return c.createdAt;
        case 'wallet': return Number(c.walletBalance);
        case 'calls': return c.calls30d;
        case 'income': return Number(c.income30d);
        case 'lastCall': return c.lastCallAt ?? '';
        case 'renews': return renewal(c) ?? '9999';
      }
    };
    return [...list].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [customers, q, status, plan, flag, sort, now]);

  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    setError('');
    setNotice('');
    try {
      await fn();
      if (msg) setNotice(msg);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onSort = (k: SortKey) => setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : k === 'name' ? 1 : -1 }));

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={Crown} title="Customers" subtitle="Everyone on the platform: plans, wallets, usage and account status.">
        <Button variant="secondary" icon={Download} onClick={() => exportCsv(rows)} disabled={!rows.length}>Export</Button>
        <Button icon={Plus} onClick={() => setModal({ kind: 'new' })}>New customer</Button>
      </PageHeader>
      {error && <Alert>{error}</Alert>}
      {notice && <Success>{notice}</Success>}

      <StatStrip cols={5}>
        <Stat icon={Building2} label="Customers" value={stats ? stats.tenants : '—'} foot={stats ? `${stats.active} paying` : undefined} />
        <Stat icon={FlaskConical} label="Trial / suspended" value={stats ? `${stats.trial} / ${stats.suspended}` : '—'} />
        <Stat icon={CircleDollarSign} label="Income this month" value={stats ? money(stats.incomeThisMonth) : '—'} foot="plans, numbers and usage" />
        <Stat
          icon={TrendingUp}
          label="Gross margin this month"
          value={stats ? money(Number(stats.incomeThisMonth) - Number(stats.carrierCostThisMonth)) : '—'}
          foot={stats ? `after ${money(stats.carrierCostThisMonth)} carrier costs` : undefined}
        />
        <Stat icon={Landmark} label="Customer wallets" value={stats ? money(stats.walletFloat) : '—'} foot="prepaid, not yet spent" />
      </StatStrip>

      {stats && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 font-semibold">Calls per day <span className="text-sm font-normal text-muted">· {stats.calls.toLocaleString()} total</span></h2>
            <BarChart data={stats.daily} x={(d) => d.day} series={CALLS} value={(d) => d.calls} integer />
          </Card>
          <Card>
            <h2 className="mb-3 font-semibold">Income per day <span className="text-sm font-normal text-muted">· plans, numbers, usage</span></h2>
            <BarChart data={stats.daily} x={(d) => d.day} series={INCOME} value={(d) => d.income} format={(v) => (v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`)} />
          </Card>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-9 w-full items-center gap-2 rounded-lg border border-border-strong bg-card px-3 text-sm focus-within:border-foreground/40 sm:w-72">
          <Search size={15} strokeWidth={1.75} className="text-faint" aria-hidden />
          <input aria-label="Search customers" placeholder="Name, portal, domain or owner email…" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
        </label>
        <div className="w-40">
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="open">All but closed</option>
            <option value="">All statuses</option>
            {(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CLOSED'] as const).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </Select>
        </div>
        <div className="w-40">
          <Select aria-label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="">All plans</option>
            {plans?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <div className="w-48">
          <Select aria-label="Needs attention" value={flag} onChange={(e) => setFlag(e.target.value as typeof flag)}>
            <option value="">Everyone</option>
            <option value="lowWallet">Low wallet</option>
            <option value="inactive">No calls in 14 days</option>
            <option value="domain">Has a custom domain</option>
          </Select>
        </div>
        <span className="ml-auto text-xs text-muted">{rows.length} of {customers?.length ?? 0}</span>
      </div>

      <Card flush className="overflow-x-auto">
        {customers && rows.length === 0 ? (
          <Empty icon={Building2} title={customers.length ? 'No customers match' : 'No customers yet'} text={customers.length ? 'Clear a filter to see more.' : 'Customers appear here when they sign up, or create one yourself.'} />
        ) : (
          <table className={`${table.wrap} min-w-[1100px]`}>
            <thead className={table.head}>
              <tr>
                <Th k="name" sort={sort} onSort={onSort}>Customer</Th>
                <th>Plan</th>
                <th>Status</th>
                <Th k="wallet" sort={sort} onSort={onSort} right>Wallet</Th>
                <Th k="calls" sort={sort} onSort={onSort} right>Calls 30d</Th>
                <Th k="income" sort={sort} onSort={onSort} right>Income 30d</Th>
                <Th k="lastCall" sort={sort} onSort={onSort}>Last call</Th>
                <Th k="renews" sort={sort} onSort={onSort}>Renews / trial</Th>
                <Th k="created" sort={sort} onSort={onSort}>Signed up</Th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} onClick={() => router.push(`/admin/customers/${c.id}`)} className={`${table.row} ${table.rowHover} ${c.status === 'CLOSED' ? 'opacity-60' : ''}`}>
                  <td>
                    <div className="flex items-center gap-3">
                      <Initials name={c.name} />
                      <div className="min-w-0">
                        <Link href={`/admin/customers/${c.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">{c.name}</Link>
                        <div className="flex items-center gap-2 text-xs text-faint">
                          <a href={portalUrl(c.subdomain)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-accent">
                            {c.customDomainVerified ? c.customDomain : c.subdomain} <ExternalLink size={11} aria-hidden />
                          </a>
                          {c.owner && <span className="truncate">{c.owner.email}</span>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>{c.plan?.name ?? '—'}</td>
                  <td>
                    <span title={c.suspendReason ?? undefined}>
                      <Badge tone={STATUS_TONE[c.status]} dot>{STATUS_LABEL[c.status]}</Badge>
                    </span>
                  </td>
                  <td className={`text-right font-mono tabular ${Number(c.walletBalance) <= 0 ? 'text-danger' : c.lowWallet ? 'text-warning' : ''}`}>{money(c.walletBalance)}</td>
                  <td className="text-right font-mono tabular">{c.calls30d.toLocaleString()}</td>
                  <td className="text-right font-mono tabular">{money(c.income30d)}</td>
                  <td className="text-xs text-muted">{ago(c.lastCallAt)}</td>
                  <td className="text-xs text-muted">{shortDate(renewal(c))}</td>
                  <td className="text-xs text-muted">{shortDate(c.createdAt)}</td>
                  <td className="relative whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                    <Button variant="subtle" size="sm" icon={LogIn} disabled={c.status === 'CLOSED'} onClick={() => act(() => loginAs(c))}>Log in as</Button>
                    <button
                      type="button"
                      aria-label={`More actions for ${c.name}`}
                      aria-expanded={menu === c.id}
                      onClick={() => setMenu(menu === c.id ? null : c.id)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-foreground"
                    >
                      <MoreHorizontal size={16} aria-hidden />
                    </button>
                    {menu === c.id && (
                      <div className="absolute right-4 top-11 z-20 w-48 rounded-xl border border-border bg-card p-1 text-left shadow-xl" onMouseLeave={() => setMenu(null)}>
                        <button type="button" onClick={() => { setMenu(null); setModal({ kind: 'credit', c }); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] hover:bg-subtle">
                          <Wallet size={14} aria-hidden /> Adjust wallet
                        </button>
                        {c.status === 'SUSPENDED' || c.status === 'CLOSED' ? (
                          <button
                            type="button"
                            onClick={() => { setMenu(null); act(() => api(`/admin/tenants/${c.id}/status`, { method: 'PATCH', json: { status: 'ACTIVE' } }), `${c.name} reactivated`); }}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] hover:bg-subtle"
                          >
                            <PlayCircle size={14} aria-hidden /> Reactivate
                          </button>
                        ) : (
                          <button type="button" onClick={() => { setMenu(null); setModal({ kind: 'suspend', c }); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-danger hover:bg-subtle">
                            <Ban size={14} aria-hidden /> Suspend…
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {modal?.kind === 'new' && (
        <Modal wide title="New customer" onClose={() => setModal(null)}>
          <NewCustomerForm onDone={(id) => (id ? router.push(`/admin/customers/${id}`) : setModal(null))} />
        </Modal>
      )}
      {modal?.kind === 'credit' && (
        <Modal title={`Wallet — ${modal.c.name}`} onClose={() => setModal(null)}>
          <CreditForm c={modal.c} onDone={(changed) => { setModal(null); if (changed) { setNotice('Wallet updated'); reload(); } }} />
        </Modal>
      )}
      {modal?.kind === 'suspend' && (
        <Modal title={`Suspend ${modal.c.name}`} onClose={() => setModal(null)}>
          <SuspendForm c={modal.c} onDone={(changed) => { setModal(null); if (changed) { setNotice(`${modal.c.name} suspended`); reload(); } }} />
        </Modal>
      )}
    </div>
  );
}

export default function AdminPage() {
  return (
    <AppShell allow={['SUPER_ADMIN']}>
      <AdminContent />
    </AppShell>
  );
}
