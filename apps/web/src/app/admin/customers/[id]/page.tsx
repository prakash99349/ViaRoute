'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import {
  Activity, ArrowLeft, Ban, CalendarClock, CircleDollarSign, CreditCard, ExternalLink, Hash, LayoutDashboard, LogIn, MessageSquareText, Palette,
  PhoneIncoming, PlayCircle, Radio, Receipt, TrendingUp, Users, Wallet, XCircle,
} from 'lucide-react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { CloseForm, CreditForm, loginAs, STATUS_LABEL, STATUS_TONE, SuspendForm } from '@/components/admin/customer-actions';
import { ActivityTab, NotesTab, NumbersTab, PlanTab, UsageTab, UsersTab, WalletTab, type Customer } from '@/components/admin/customer-tabs';
import { Alert, Badge, Button, Card, CardHeader, Initials, Modal, Spinner, Stat, StatStrip } from '@/components/ui';
import { BrandingCard, CustomDomainCard, type WhiteLabelTenant } from '@/components/white-label';
import { api, money, portalUrl } from '@/lib/api';
import { useApi } from '@/lib/use-api';

type Detail = Customer &
  WhiteLabelTenant & {
    plan: (Customer['plan'] & { whiteLabel: boolean; customDomain: boolean }) | null;
  };

const TABS = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'plan', label: 'Plan & limits', icon: CreditCard },
  { key: 'wallet', label: 'Wallet', icon: Wallet },
  { key: 'usage', label: 'Usage', icon: TrendingUp },
  { key: 'users', label: 'Users', icon: Users },
  { key: 'numbers', label: 'Numbers', icon: Hash },
  { key: 'branding', label: 'Branding & domain', icon: Palette },
  { key: 'notes', label: 'Notes', icon: MessageSquareText },
  { key: 'activity', label: 'Activity', icon: Activity },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const dateOnly = (s: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

function Overview({ c, go }: { c: Detail; go: (t: TabKey) => void }) {
  const renew = c.status === 'TRIAL' ? c.trialEndsAt : c.billingRenewsAt;
  const custom = [
    c.perMinuteRate && `${money(c.perMinuteRate)}/min`,
    c.numberPriceLocal && `local numbers ${money(c.numberPriceLocal)}`,
    c.numberPriceTollFree && `toll-free ${money(c.numberPriceTollFree)}`,
    c.includedNumbers !== null && `${c.includedNumbers} included numbers`,
  ].filter(Boolean);
  const callMargin = c.margin30d.usageIncome - c.margin30d.usageCarrierCost;
  const limits = [c.maxConcurrentCalls && `${c.maxConcurrentCalls} calls at once`, c.maxNumbers !== null && `max ${c.maxNumbers} numbers`].filter(Boolean);
  return (
    <div className="space-y-5">
      <StatStrip cols={5}>
        <Stat icon={Wallet} label="Wallet" value={money(c.walletBalance)} foot={Number(c.walletBalance) < Number(c.lowBalanceThreshold) ? 'Below alert level' : `alert below ${money(c.lowBalanceThreshold)}`} />
        <Stat icon={Radio} label="Live calls" value={c.liveCalls} foot={c.maxConcurrentCalls ? `limit ${c.maxConcurrentCalls}` : 'no account limit'} />
        <Stat icon={PhoneIncoming} label="Calls (30 days)" value={c.calls30d.toLocaleString()} foot={c.lastCallAt ? `last ${dateOnly(c.lastCallAt)}` : 'no calls yet'} />
        <Stat icon={CircleDollarSign} label="Income (30 days)" value={money(c.income30d)} foot="what they paid you" />
        <Stat icon={CalendarClock} label={c.status === 'TRIAL' ? 'Trial ends' : 'Renews'} value={dateOnly(renew)} foot={c.plan ? `${c.plan.name} · ${money(c.plan.monthlyPrice)}/mo` : 'no plan'} />
      </StatStrip>
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <UsageTab c={c} compact />
        <Card className="space-y-4">
          <CardHeader title="Account" />
          <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-muted">Owner</dt>
            <dd>{c.owner ? <>{c.owner.name}<div className="text-xs text-muted">{c.owner.email}</div></> : '—'}</dd>
            <dt className="text-muted">Portal</dt>
            <dd><a href={portalUrl(c.subdomain)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent">{c.customDomainVerified ? c.customDomain : c.subdomain} <ExternalLink size={12} aria-hidden /></a></dd>
            <dt className="text-muted">Signed up</dt>
            <dd>{dateOnly(c.createdAt)}</dd>
            <dt className="text-muted">Timezone</dt>
            <dd>{c.timezone.replace(/_/g, ' ')}</dd>
            <dt className="text-muted">Has</dt>
            <dd>{c.counts.users} users · {c.counts.campaigns} campaigns · {c.counts.phoneNumbers} numbers</dd>
            <dt className="text-muted">Custom deal</dt>
            <dd>{custom.length ? custom.join(' · ') : <span className="text-muted">Plan prices</span>}</dd>
            <dt className="text-muted">Limits</dt>
            <dd>{limits.length ? limits.join(' · ') : <span className="text-muted">None</span>}</dd>
            <dt className="text-muted">Carrier</dt>
            <dd>{c.carrier ? c.carrier.name : <span className="text-muted">Platform default</span>}</dd>
            <dt className="text-muted">Margin (30 days)</dt>
            <dd>
              <span className={`font-mono ${callMargin < 0 ? 'text-danger' : ''}`}>{money(callMargin)}</span> on calls
              <div className="text-xs text-muted">{money(c.margin30d.usageIncome)} billed − {money(c.margin30d.usageCarrierCost)} carrier · numbers {money(c.margin30d.numbersIncome - c.margin30d.numbersCarrierCost)}/mo</div>
            </dd>
          </dl>
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button variant="secondary" size="sm" icon={CreditCard} onClick={() => go('plan')}>Change plan or prices</Button>
            <Button variant="secondary" size="sm" icon={MessageSquareText} onClick={() => go('notes')}>{c.counts.notes ? `Notes (${c.counts.notes})` : 'Add a note'}</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function CustomerContent() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'overview') as TabKey;
  const { data: c, error, reload } = useApi<Detail>(`/admin/tenants/${id}`);
  const [modal, setModal] = useState<'credit' | 'suspend' | 'close' | null>(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');

  const go = (t: TabKey) => router.replace(`/admin/customers/${id}${t === 'overview' ? '' : `?tab=${t}`}`, { scroll: false });
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setActionError('');
    setNotice('');
    try {
      await fn();
      setNotice(msg);
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  if (error) return <Alert>{error}</Alert>;
  if (!c) return <div className="flex justify-center py-20"><Spinner /></div>;
  const closed = c.status === 'CLOSED';

  return (
    <div className="w-full space-y-5">
      <Link href="/admin" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-foreground">
        <ArrowLeft size={14} aria-hidden /> Customers
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-center gap-4">
        <Initials name={c.name} size={44} />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {c.name}
            <Badge tone={STATUS_TONE[c.status]} dot>{STATUS_LABEL[c.status]}</Badge>
            {c.plan && <Badge>{c.plan.name}</Badge>}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {c.subdomain}
            {c.owner && <> · {c.owner.name} ({c.owner.email})</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={LogIn} disabled={closed} onClick={() => act(() => loginAs(c), 'Support session opened in a new tab')}>Log in as</Button>
          <Button variant="secondary" icon={Receipt} onClick={() => setModal('credit')}>Adjust wallet</Button>
          {c.status === 'SUSPENDED' || closed ? (
            <Button icon={PlayCircle} onClick={() => act(() => api(`/admin/tenants/${c.id}/status`, { method: 'PATCH', json: { status: 'ACTIVE' } }), closed ? 'Account reopened' : 'Account reactivated')}>
              {closed ? 'Reopen' : 'Reactivate'}
            </Button>
          ) : (
            <Button variant="secondary" icon={Ban} onClick={() => setModal('suspend')} className="hover:text-danger">Suspend</Button>
          )}
          {!closed && <Button variant="ghost" icon={XCircle} onClick={() => setModal('close')} className="text-muted hover:text-danger">Close</Button>}
        </div>
      </div>

      {c.status === 'SUSPENDED' && (
        <Alert tone="warning">
          <b>Suspended</b> — {c.suspendReason ?? 'monthly payment failed (lifts automatically when they top up)'}. Calls are rejected.
        </Alert>
      )}
      {closed && <Alert tone="info"><b>Closed</b> {c.closedAt && `on ${dateOnly(c.closedAt)}`} — {c.suspendReason ?? 'no reason given'}. Portal and billing are off; history is kept.</Alert>}
      {actionError && <Alert>{actionError}</Alert>}
      {notice && <Success>{notice}</Success>}

      {/* Tabs */}
      <div role="tablist" aria-label="Customer sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => go(t.key)}
            className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 pb-2.5 text-sm ${tab === t.key ? 'border-foreground font-semibold' : 'border-transparent text-muted hover:text-foreground'}`}
          >
            <t.icon size={15} strokeWidth={1.75} aria-hidden />
            {t.label}
            {t.key === 'notes' && c.counts.notes > 0 && <span className="rounded-full bg-subtle px-1.5 text-[11px] font-medium">{c.counts.notes}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'overview' && <Overview c={c} go={go} />}
        {tab === 'plan' && <PlanTab key={JSON.stringify([c.plan?.id, c.trialEndsAt, c.billingRenewsAt])} c={c} onSaved={reload} />}
        {tab === 'wallet' && <WalletTab c={c} onChanged={reload} onCredit={() => setModal('credit')} />}
        {tab === 'usage' && <UsageTab c={c} />}
        {tab === 'users' && <UsersTab c={c} />}
        {tab === 'numbers' && <NumbersTab c={c} />}
        {tab === 'branding' && (
          <div className="space-y-5">
            <BrandingCard t={c} onSaved={reload} />
            <CustomDomainCard t={c} onChanged={reload} />
          </div>
        )}
        {tab === 'notes' && <NotesTab c={c} onChanged={reload} />}
        {tab === 'activity' && <ActivityTab c={c} />}
      </div>

      {modal === 'credit' && (
        <Modal title={`Wallet — ${c.name}`} onClose={() => setModal(null)}>
          <CreditForm c={c} onDone={(changed) => { setModal(null); if (changed) { setNotice('Wallet updated'); reload(); } }} />
        </Modal>
      )}
      {modal === 'suspend' && (
        <Modal title={`Suspend ${c.name}`} onClose={() => setModal(null)}>
          <SuspendForm c={c} onDone={(changed) => { setModal(null); if (changed) { setNotice(`${c.name} suspended`); reload(); } }} />
        </Modal>
      )}
      {modal === 'close' && (
        <Modal title={`Close ${c.name}`} onClose={() => setModal(null)}>
          <CloseForm c={c} onDone={(msg) => { setModal(null); if (msg) { setNotice(msg); reload(); } }} />
        </Modal>
      )}
    </div>
  );
}

export default function CustomerPage() {
  return (
    <AppShell allow={['SUPER_ADMIN']}>
      <Suspense fallback={<div className="flex justify-center py-20"><Spinner /></div>}>
        <CustomerContent />
      </Suspense>
    </AppShell>
  );
}
