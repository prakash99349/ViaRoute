'use client';

import { useState, type FormEvent } from 'react';
import { TimeZoneSelect } from '@/components/timezone-select';
import { Alert, Button, Field, Select } from '@/components/ui';
import { api, money, portalUrl, ROOT_DOMAIN } from '@/lib/api';
import { browserTimeZone } from '@/lib/date-range';
import { useAction, useApi } from '@/lib/use-api';
import type { TenantStatus } from '@/lib/types';

export const STATUS_TONE = { ACTIVE: 'green', TRIAL: 'yellow', SUSPENDED: 'red', CLOSED: 'gray' } as const;
export const STATUS_LABEL: Record<TenantStatus, string> = { ACTIVE: 'Active', TRIAL: 'Trial', SUSPENDED: 'Suspended', CLOSED: 'Closed' };

export interface CustomerRef {
  id: string;
  name: string;
  subdomain: string;
  walletBalance: string;
}

/** Opens the customer's portal as their admin (support session, 1 hour, logged). */
export async function loginAs(c: CustomerRef) {
  if (!confirm(`Open ${c.name}'s portal as their admin?\n\nThis support session lasts 1 hour and is logged.`)) return;
  const r = await api<{ subdomain: string; handoffToken: string }>(`/admin/tenants/${c.id}/impersonate`, { method: 'POST' });
  window.open(portalUrl(r.subdomain, `/auth/callback#h=${r.handoffToken}`), '_blank', 'noopener');
}

/** Add or remove wallet funds, with a reason for the customer's history. */
export function CreditForm({ c, onDone }: { c: CustomerRef; onDone: (changed: boolean) => void }) {
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('25');
  const { busy, error, run } = useAction();
  const value = Number(amount);
  const after = Number(c.walletBalance) + (direction === 'add' ? value : -value);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const note = String(new FormData(e.currentTarget).get('note') ?? '').trim();
    const signed = direction === 'add' ? value : -value;
    if (await run(() => api(`/admin/tenants/${c.id}/credit`, { method: 'POST', json: { amount: signed, note } }))) onDone(true);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div className="rounded-lg bg-subtle/60 px-4 py-3 text-sm">
        Current balance <b className="font-mono">{money(c.walletBalance)}</b>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Action" value={direction} onChange={(e) => setDirection(e.target.value as 'add' | 'remove')}>
          <option value="add">Add funds</option>
          <option value="remove">Remove funds</option>
        </Select>
        <Field label="Amount (USD)" type="number" min={0.01} max={10000} step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <Field
        label="Reason"
        name="note"
        required
        minLength={3}
        maxLength={200}
        key={direction}
        defaultValue={direction === 'add' ? 'Account credit' : 'Correction'}
        hint="Shown in the customer's transaction history."
      />
      {value > 0 && (
        <p className="text-sm text-muted">
          New balance: <b className={`font-mono ${after < 0 ? 'text-danger' : 'text-foreground'}`}>{money(after)}</b>
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => onDone(false)}>Cancel</Button>
        <Button type="submit" variant={direction === 'remove' ? 'danger' : 'primary'} disabled={busy || !(value > 0)}>
          {busy ? 'Saving…' : direction === 'add' ? `Add ${money(value || 0)}` : `Remove ${money(value || 0)}`}
        </Button>
      </div>
    </form>
  );
}

const SUSPEND_REASONS = ['Unpaid balance', 'Suspected fraud or abuse', 'Terms of service violation', 'Requested by the customer'];

/** Suspend with a reason the customer sees in their portal. */
export function SuspendForm({ c, onDone }: { c: CustomerRef; onDone: (changed: boolean) => void }) {
  const [preset, setPreset] = useState(SUSPEND_REASONS[0]);
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const detail = String(new FormData(e.currentTarget).get('detail') ?? '').trim();
    const reason = detail ? `${preset}: ${detail}` : preset;
    if (await run(() => api(`/admin/tenants/${c.id}/status`, { method: 'PATCH', json: { status: 'SUSPENDED', reason } }))) onDone(true);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-muted">
        Calls to {c.name} are rejected and their team can only view data and pay. A top-up does <b>not</b> lift this — you reactivate them.
      </p>
      <Select label="Reason" value={preset} onChange={(e) => setPreset(e.target.value)}>
        {SUSPEND_REASONS.map((r) => <option key={r}>{r}</option>)}
      </Select>
      <Field label="Details for the customer (optional)" name="detail" maxLength={200} placeholder="e.g. Please contact billing@yourcompany.com" hint="Shown in a banner in their portal." />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => onDone(false)}>Cancel</Button>
        <Button type="submit" variant="danger" disabled={busy}>{busy ? 'Suspending…' : 'Suspend account'}</Button>
      </div>
    </form>
  );
}

/** Close for good: releases numbers, stops billing, closes the portal. Needs the subdomain typed. */
export function CloseForm({ c, onDone }: { c: CustomerRef; onDone: (msg?: string) => void }) {
  const [typed, setTyped] = useState('');
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    let result: { released: number; failed: string[] } | undefined;
    const ok = await run(async () => {
      result = await api(`/admin/tenants/${c.id}/close`, { method: 'POST', json: { reason, confirm: typed } });
    });
    if (ok && result) onDone(`${c.name} closed. ${result.released} number(s) released${result.failed.length ? `; could not release ${result.failed.join(', ')}` : ''}.`);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Alert tone="warning">
        This releases all of {c.name}&apos;s phone numbers (they may be lost for good), stops billing, signs everyone out and closes their portal. Call history and
        transactions are kept. You can reopen the account later, but not the numbers.
      </Alert>
      <Field label="Reason" name="reason" required minLength={3} maxLength={300} placeholder="e.g. Customer cancelled" />
      <Field label={`Type ${c.subdomain} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => onDone()}>Cancel</Button>
        <Button type="submit" variant="danger" disabled={busy || typed.trim().toLowerCase() !== c.subdomain}>{busy ? 'Closing…' : 'Close account'}</Button>
      </div>
    </form>
  );
}

/** Set up an account for a customer; the owner gets an email to choose a password. */
export function NewCustomerForm({ onDone }: { onDone: (id?: string) => void }) {
  const { data: plans } = useApi<{ id: string; code: string; name: string; monthlyPrice: string; active: boolean }[]>('/admin/plans');
  const [sub, setSub] = useState('');
  const [touched, setTouched] = useState(false);
  const [trial, setTrial] = useState(true);
  const { busy, error, run } = useAction();

  const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    let id: string | undefined;
    const ok = await run(async () => {
      const r = await api<{ id: string }>('/admin/tenants', {
        method: 'POST',
        json: {
          companyName: f.get('companyName'),
          subdomain: sub,
          ownerName: f.get('ownerName'),
          ownerEmail: f.get('ownerEmail'),
          planId: f.get('planId') || undefined,
          trialDays: trial ? Number(f.get('trialDays')) : 0,
          startingCredit: Number(f.get('startingCredit') || 0),
          timezone: f.get('timezone'),
        },
      });
      id = r.id;
    });
    if (ok) onDone(id);
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name" name="companyName" required minLength={2} autoFocus onChange={(e) => !touched && setSub(slug(e.target.value))} />
        <Field
          label="Portal address"
          value={sub}
          onChange={(e) => {
            setTouched(true);
            setSub(slug(e.target.value));
          }}
          required
          minLength={3}
          hint={sub ? `${sub}.${ROOT_DOMAIN}` : 'Letters, numbers and dashes'}
        />
        <Field label="Owner name" name="ownerName" required minLength={2} />
        <Field label="Owner email" name="ownerEmail" type="email" required hint="They get an email to set their password." />
        <Select label="Plan" name="planId" defaultValue="">
          <option value="">Starter (default)</option>
          {plans?.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.monthlyPrice)}/mo</option>)}
        </Select>
        <TimeZoneSelect label="Timezone" name="timezone" defaultValue={browserTimeZone()} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Start as" value={trial ? 'trial' : 'active'} onChange={(e) => setTrial(e.target.value === 'trial')}>
          <option value="trial">Free trial</option>
          <option value="active">Paying customer (first month charged at renewal)</option>
        </Select>
        {trial ? (
          <Field label="Trial length (days)" name="trialDays" type="number" min={1} max={365} defaultValue={14} required />
        ) : (
          <div />
        )}
        <Field label="Starting credit (USD, optional)" name="startingCredit" type="number" min={0} max={10000} step="0.01" placeholder="0.00" hint="Added to their wallet as an adjustment." />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => onDone()}>Cancel</Button>
        <Button type="submit" disabled={busy || sub.length < 3}>{busy ? 'Creating…' : 'Create customer'}</Button>
      </div>
    </form>
  );
}
