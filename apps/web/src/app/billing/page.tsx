'use client';

import { Bell, Check, CreditCard, FileText, FlaskConical, Minus, Receipt, Tag } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, Card, Field, PageHeader, Select, table } from '@/components/ui';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

interface Plan {
  id: string;
  code: string;
  name: string;
  monthlyPrice: string;
  perMinuteRate: string;
  includedNumbers: number;
  maxUsers: number | null;
  whiteLabel: boolean;
  customDomain: boolean;
}

interface Overview {
  testMode: boolean;
  status: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  walletBalance: string;
  lowBalanceThreshold: string;
  trialEndsAt: string | null;
  billingRenewsAt: string | null;
  plan: Plan | null;
  plans: Plan[];
  nextCharge: { plan: string | number; numbers: string | number; numberCount: number };
  spentThisMonth: Record<string, string | number>;
}

interface Tx {
  id: string;
  type: string;
  amount: string;
  balanceAfter: string;
  description: string | null;
  createdAt: string;
}

const TYPE_LABEL: Record<string, string> = {
  TOPUP: 'Top-up',
  SUBSCRIPTION: 'Plan',
  CALL_USAGE: 'Call usage',
  NUMBER_RENTAL: 'Numbers',
  RECORDING: 'Recording',
  ADJUSTMENT: 'Adjustment',
  REFUND: 'Refund',
};

const PRESETS = [50, 100, 250, 500];

function months() {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 12; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

function TopUp({ overview, onDone }: { overview: Overview; onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState(100);
  const { busy, error, run } = useAction();

  async function pay(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => api<{ url?: string; credited?: boolean }>('/billing/topup', { method: 'POST', json: { amount } }));
    if (r?.url) window.location.href = r.url; // Stripe Checkout
    else if (r?.credited) onDone(`${money(amount)} added to your wallet`);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[13px] text-muted">Wallet balance</div>
          <div className={`text-4xl font-semibold tabular-nums ${Number(overview.walletBalance) <= 0 ? 'text-red-600' : ''}`}>{money(overview.walletBalance)}</div>
          <p className="mt-1 text-xs text-muted">Calls, numbers and your plan are paid from this balance.</p>
        </div>
        <form onSubmit={pay} className="w-full max-w-sm space-y-3">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p}
                onClick={() => setAmount(p)}
                aria-pressed={amount === p}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${amount === p ? 'border-foreground bg-subtle text-foreground' : 'border-border'}`}
              >
                {money(p)}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Amount (USD)" type="number" min={10} max={10000} step="1" value={amount} onChange={(e) => setAmount(Number(e.target.value))} required />
            </div>
            <Button type="submit" disabled={busy}>{busy ? '…' : overview.testMode ? 'Add funds (test)' : 'Pay with card →'}</Button>
          </div>
          {error && <Alert>{error}</Alert>}
          {overview.testMode && <p className="flex items-center gap-1.5 text-xs text-warning"><FlaskConical size={13} aria-hidden /> Test mode: no card is charged. Add a Stripe key to take real payments.</p>}
        </form>
      </div>
    </Card>
  );
}

function PlanCard({ overview, onChanged }: { overview: Overview; onChanged: (msg: string) => void }) {
  const { busy, error, run } = useAction();
  const change = async (p: Plan) => {
    if (!confirm(`Switch to the ${p.name} plan?\n\nIt starts now; ${money(p.monthlyPrice)}/month is charged from your wallet at your next renewal.`)) return;
    if (await run(() => api('/billing/plan', { method: 'POST', json: { code: p.code } }))) onChanged(`You're now on the ${p.name} plan`);
  };

  return (
    <Card>
      <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Tag size={17} strokeWidth={1.75} className="text-faint" aria-hidden />Plan</h2>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {[...overview.plans].sort((a, b) => (Number(a.monthlyPrice) || Infinity) - (Number(b.monthlyPrice) || Infinity)).map((p) => {
          const current = p.id === overview.plan?.id;
          return (
            <div key={p.id} className={`flex flex-col rounded-xl border p-4 ${current ? 'border-foreground ring-4 ring-foreground/5' : 'border-border'}`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold">{p.name}</span>
                {current && <Badge tone="green">Current</Badge>}
              </div>
              <div className="mt-2 text-2xl font-semibold">
                {Number(p.monthlyPrice) ? money(p.monthlyPrice) : 'Custom'}
                {Number(p.monthlyPrice) > 0 && <span className="text-sm font-normal text-muted">/mo</span>}
              </div>
              <ul className="mt-3 flex-1 space-y-1 text-sm text-muted">
                <li className="flex items-center gap-2"><Check size={14} className="text-success" aria-hidden />{p.includedNumbers} numbers included</li>
                <li className="flex items-center gap-2"><Check size={14} className="text-success" aria-hidden />{(Number(p.perMinuteRate) * 100).toFixed(1)}¢ per call minute</li>
                <li className="flex items-center gap-2"><Check size={14} className="text-success" aria-hidden />{p.maxUsers === null ? 'Unlimited' : p.maxUsers} team members</li>
                <li className={`flex items-center gap-2 ${p.whiteLabel ? '' : 'text-faint'}`}>{p.whiteLabel ? <Check size={14} className="text-success" aria-hidden /> : <Minus size={14} aria-hidden />}Your branding</li>
                <li className={`flex items-center gap-2 ${p.customDomain ? '' : 'text-faint'}`}>{p.customDomain ? <Check size={14} className="text-success" aria-hidden /> : <Minus size={14} aria-hidden />}Custom domain</li>
              </ul>
              {!current && (
                <Button variant="secondary" className="mt-4" disabled={busy} onClick={() => change(p)}>
                  Switch to {p.name}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Alerts({ overview, onSaved }: { overview: Overview; onSaved: () => void }) {
  const { busy, error, notice, run } = useAction();
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = Number(new FormData(e.currentTarget).get('threshold'));
    if (await run(() => api('/billing/settings', { method: 'PATCH', json: { lowBalanceThreshold: v } }), 'Saved')) onSaved();
  }
  return (
    <Card>
      <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Bell size={17} strokeWidth={1.75} className="text-faint" aria-hidden />Low-balance alert</h2>
      <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-3">
        <div className="w-48">
          <Field label="Email me below ($)" name="threshold" type="number" min={0} step="1" defaultValue={Number(overview.lowBalanceThreshold)} />
        </div>
        <Button type="submit" variant="secondary" disabled={busy}>Save</Button>
        {notice && <span className="flex items-center gap-1 text-sm text-success"><Check size={14} aria-hidden /> {notice}</span>}
      </form>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      <p className="mt-2 text-xs text-muted">When your wallet reaches $0, new calls are rejected until you top up.</p>
    </Card>
  );
}

function Transactions() {
  const [month, setMonth] = useState(months()[0]);
  const { data } = useApi<{ items: Tx[]; total: number }>(`/billing/transactions?month=${month}`);
  return (
    <Card flush className="overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 px-6 pt-5">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Receipt size={17} strokeWidth={1.75} className="text-faint" aria-hidden />Transactions</h2>
        <div className="flex items-center gap-2">
          <div className="w-36">
            <Select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
              {months().map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </div>
          <Link href={`/billing/statement/${month}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-accent"><FileText size={14} aria-hidden />Statement</Link>
        </div>
      </div>
      <table className={`mt-3 ${table.wrap} min-w-[640px]`}>
        <thead className={table.head}>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Description</th>
            <th className="text-right">Amount</th>
            <th className="text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((t) => (
            <tr key={t.id} className={table.row}>
              <td className="whitespace-nowrap text-xs text-muted">{new Date(t.createdAt).toLocaleString()}</td>
              <td><Badge tone={Number(t.amount) > 0 ? 'green' : 'gray'}>{TYPE_LABEL[t.type] ?? t.type}</Badge></td>
              <td>{t.description}</td>
              <td className={`text-right tabular-nums ${Number(t.amount) > 0 ? 'text-emerald-600' : ''}`}>
                {Number(t.amount) > 0 ? '+' : '−'}{money(Math.abs(Number(t.amount)))}
              </td>
              <td className="text-right tabular-nums">{money(t.balanceAfter)}</td>
            </tr>
          ))}
          {data?.items.length === 0 && (
            <tr><td colSpan={5} className="px-6 py-10 text-center text-muted">No transactions this month.</td></tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

function BillingContent() {
  const { data, error, reload } = useApi<Overview>('/billing');
  const [notice, setNotice] = useState('');
  const [txKey, setTxKey] = useState(0);

  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('topup');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- message after returning from Stripe Checkout
    if (r === 'success') setNotice('Payment received — your wallet will update in a few seconds.');
  }, []);

  const done = (msg: string) => {
    setNotice(msg);
    reload();
    setTxKey((k) => k + 1);
  };

  const renewDate = data?.billingRenewsAt ? new Date(data.billingRenewsAt).toLocaleDateString() : null;
  const nextTotal = data ? Number(data.nextCharge.plan) + Number(data.nextCharge.numbers) : 0;
  const spent = data ? Object.values(data.spentThisMonth).reduce((s: number, v) => s + Number(v), 0) : 0;

  return (
    <div className="w-full space-y-5">
      <PageHeader
        icon={CreditCard}
        title={<>Billing {data?.testMode && <Badge tone="yellow">Test mode</Badge>}</>}
        subtitle="Prepaid wallet — top up any time, pay only for what you use."
      />
      {error && <Alert>{error}</Alert>}
      {notice && <Success>{notice}</Success>}
      {data?.status === 'SUSPENDED' && (
        <Alert>Your account is paused because the monthly charge of {money(nextTotal)} couldn&apos;t be paid. Add funds and it reactivates automatically.</Alert>
      )}

      {data && (
        <>
          <TopUp overview={data} onDone={done} />
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <div className="text-[13px] text-muted">{data.status === 'TRIAL' ? 'Free trial ends' : 'Next renewal'}</div>
              <div className="mt-1 text-xl font-semibold">{renewDate ?? '—'}</div>
              <div className="mt-1 text-xs text-muted">
                Then {money(nextTotal)}: {data.plan?.name} plan {money(data.nextCharge.plan)} + {data.nextCharge.numberCount} number(s) {money(data.nextCharge.numbers)}
              </div>
            </Card>
            <Card>
              <div className="text-[13px] text-muted">Spent this month</div>
              <div className="mt-1 text-xl font-semibold">{money(spent)}</div>
              <div className="mt-1 space-x-3 text-xs text-muted">
                {Object.entries(data.spentThisMonth).map(([k, v]) => <span key={k}>{TYPE_LABEL[k] ?? k} {money(v)}</span>)}
                {!Object.keys(data.spentThisMonth).length && 'Nothing yet'}
              </div>
            </Card>
            <Alerts overview={data} onSaved={reload} />
          </div>
          <PlanCard overview={data} onChanged={done} />
          <Transactions key={txKey} />
        </>
      )}
    </div>
  );
}

export default function BillingPage() {
  return (
    <AppShell allow={['TENANT_ADMIN']}>
      <BillingContent />
    </AppShell>
  );
}
