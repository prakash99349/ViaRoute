'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { FlaskConical, Hash, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { Alert, Badge, Button, Card, Empty, Field, IconButton, Modal, PageHeader, Select, table } from '@/components/ui';
import { api, formatPhone, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

type NumberType = 'LOCAL' | 'TOLL_FREE';

interface Overview {
  testMode: boolean;
  prices: Record<NumberType, number>;
  includedNumbers: number;
  usedNumbers: number;
  walletBalance: string;
}

interface Offer {
  e164: string;
  type: NumberType;
  locality?: string;
  region?: string;
  monthlyPrice: number;
  included: boolean;
}

interface OwnedNumber {
  id: string;
  e164: string;
  label: string | null;
  type: NumberType;
  status: 'ACTIVE' | 'PENDING';
  monthlyPrice: string;
  purchasedAt: string;
  campaign: { id: string; name: string } | null;
  publisher: { id: string; name: string } | null;
}

const TYPE_LABEL: Record<NumberType, string> = { LOCAL: 'Local', TOLL_FREE: 'Toll-free' };

function BuyPanel({ overview, onBought }: { overview: Overview; onBought: (msg: string) => void }) {
  const [type, setType] = useState<NumberType>('LOCAL');
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');

  async function search(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    const areaCode = e ? String(new FormData(e.currentTarget).get('areaCode') ?? '').trim() : '';
    setError('');
    setSearching(true);
    try {
      const qs = new URLSearchParams({ type, ...(areaCode && type === 'LOCAL' ? { areaCode } : {}) });
      setOffers(await api<Offer[]>(`/numbers/available?${qs}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function buy(o: Offer) {
    const cost = o.included ? 'This number is included in your plan.' : `${money(o.monthlyPrice)} will be charged from your wallet now, then monthly.`;
    if (!confirm(`Buy ${formatPhone(o.e164)}?\n\n${cost}`)) return;
    setError('');
    setBuying(o.e164);
    try {
      const n = await api<{ status: string }>('/numbers', { method: 'POST', json: { e164: o.e164, ...(label ? { label } : {}) } });
      setOffers((prev) => prev?.filter((x) => x.e164 !== o.e164) ?? null);
      setLabel('');
      onBought(n.status === 'PENDING' ? `${formatPhone(o.e164)} ordered — the carrier is activating it.` : `${formatPhone(o.e164)} is yours`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBuying(null);
    }
  }

  const tab = (t: NumberType) => (
    <button
      type="button"
      onClick={() => {
        setType(t);
        setOffers(null);
      }}
      className={`rounded-md px-4 py-1.5 text-sm font-medium ${type === t ? 'bg-card shadow-sm' : 'text-muted'}`}
    >
      {TYPE_LABEL[t]}
    </button>
  );

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="inline-flex rounded-lg bg-foreground/5 p-1">
          {tab('LOCAL')}
          {tab('TOLL_FREE')}
        </div>
        <form onSubmit={search} className="flex flex-1 flex-wrap items-end gap-3">
          {type === 'LOCAL' && (
            <div className="w-40">
              <Field label="Area code" name="areaCode" placeholder="e.g. 415" inputMode="numeric" pattern="[2-9][0-9]{2}" maxLength={3} />
            </div>
          )}
          <div className="w-56">
            <Field label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Google Ads – Plumbing" maxLength={60} />
          </div>
          <Button type="submit" icon={Search} disabled={searching}>{searching ? 'Searching…' : 'Search'}</Button>
        </form>
      </div>
      <p className="text-xs text-muted">
        {TYPE_LABEL[type]} numbers cost {money(overview.prices[type])}/month.{' '}
        {overview.usedNumbers < overview.includedNumbers &&
          `Your plan still includes ${overview.includedNumbers - overview.usedNumbers} free number${overview.includedNumbers - overview.usedNumbers === 1 ? '' : 's'}.`}
      </p>

      {error && <Alert>{error}</Alert>}

      {offers && offers.length === 0 && <p className="text-sm text-muted">No numbers found. Try another area code.</p>}
      {offers && offers.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {offers.map((o) => (
            <div key={o.e164} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div>
                <div className="font-mono font-medium">{formatPhone(o.e164)}</div>
                <div className="text-xs text-muted">
                  {[o.locality, o.region].filter(Boolean).join(', ') || TYPE_LABEL[o.type]} ·{' '}
                  {o.included ? <span className="text-emerald-600">Included</span> : `${money(o.monthlyPrice)}/mo`}
                </div>
              </div>
              <Button size="sm" onClick={() => buy(o)} disabled={buying !== null}>
                {buying === o.e164 ? '…' : 'Buy'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function EditNumber({ n, onDone }: { n: OwnedNumber; onDone: (msg?: string) => void }) {
  const { data: campaigns } = useApi<{ id: string; name: string; active: boolean }[]>('/campaigns');
  const { data: publishers } = useApi<{ id: string; name: string; active: boolean }[]>('/publishers');
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const json = {
      label: String(f.get('label') ?? '').trim() || null,
      campaignId: f.get('campaignId') || null,
      publisherId: f.get('publisherId') || null,
    };
    if (await run(() => api(`/numbers/${n.id}`, { method: 'PATCH', json }))) onDone(`${formatPhone(n.e164)} saved`);
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-subtle/60 px-4 py-3 text-sm">
        <span className="font-mono text-base font-semibold">{formatPhone(n.e164)}</span>
        <span className="text-muted">{TYPE_LABEL[n.type]}</span>
        <span className="text-muted">{Number(n.monthlyPrice) === 0 ? 'Included in plan' : `${money(n.monthlyPrice)}/month`}</span>
        <span className="text-muted">Since {new Date(n.purchasedAt).toLocaleDateString()}</span>
      </div>
      <Field label="Label" name="label" defaultValue={n.label ?? ''} placeholder="e.g. Google Ads – Plumbing" maxLength={60} autoFocus hint="Shown in call logs and reports so you know where calls came from." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Campaign" name="campaignId" defaultValue={n.campaign?.id ?? ''} hint="Calls to this number follow this campaign's routing.">
          <option value="">Not assigned (calls are rejected)</option>
          {campaigns?.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (paused)'}</option>)}
        </Select>
        <Select label="Publisher" name="publisherId" defaultValue={n.publisher?.id ?? ''} hint="Who gets paid for converted calls to this number.">
          <option value="">No publisher (your own traffic)</option>
          {publishers?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (paused)'}</option>)}
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => onDone()}>Cancel</Button>
        <Button type="submit" disabled={busy || !campaigns || !publishers}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

function NumbersContent() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [numbers, setNumbers] = useState<OwnedNumber[] | null>(null);
  const [showBuy, setShowBuy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<OwnedNumber | null>(null);

  const load = useCallback(() => {
    Promise.all([api<Overview>('/numbers/overview'), api<OwnedNumber[]>('/numbers')])
      .then(([o, n]) => {
        setOverview(o);
        setNumbers(n);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>, msg: string) {
    setError('');
    setNotice('');
    try {
      await fn();
      setNotice(msg);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const release = (n: OwnedNumber) => {
    if (!confirm(`Release ${formatPhone(n.e164)}?\n\nCalls to this number will stop working immediately and you may not be able to get it back.`)) return;
    act(() => api(`/numbers/${n.id}`, { method: 'DELETE' }), `${formatPhone(n.e164)} released`);
  };

  return (
    <div className="w-full space-y-5">
      <PageHeader
        icon={Hash}
        title={<>Phone numbers {overview?.testMode && <Badge tone="yellow">Test mode</Badge>}</>}
        subtitle={
          overview
            ? `${overview.usedNumbers} number${overview.usedNumbers === 1 ? '' : 's'} · ${Math.min(overview.usedNumbers, overview.includedNumbers)} of ${overview.includedNumbers} included in your plan · Wallet ${money(overview.walletBalance)}`
            : 'Tracking numbers for your campaigns'
        }
      >
        <Button icon={showBuy ? X : Plus} variant={showBuy ? 'secondary' : 'primary'} onClick={() => setShowBuy((v) => !v)}>
          {showBuy ? 'Close' : 'Buy number'}
        </Button>
      </PageHeader>

      {overview?.testMode && (
        <Alert tone="info">
          <b className="inline-flex items-center gap-1.5 font-semibold"><FlaskConical size={14} aria-hidden /> Test mode:</b> numbers are simulated (555-01XX) and won&apos;t ring. Add a Telnyx API key to buy real numbers.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {notice && <Success>{notice}</Success>}

      {showBuy && overview && (
        <BuyPanel
          overview={overview}
          onBought={(msg) => {
            setNotice(msg);
            load();
          }}
        />
      )}

      <Card flush className="overflow-x-auto">
        {numbers?.length === 0 ? (
          <Empty
            icon={Hash}
            title="No numbers yet"
            text="Buy your first tracking number to start receiving calls."
            action={!showBuy && <Button icon={Plus} onClick={() => setShowBuy(true)}>Buy number</Button>}
          />
        ) : (
          <table className={`${table.wrap} min-w-[860px]`}>
            <thead className={table.head}>
              <tr>
                <th>Number</th>
                <th>Type</th>
                <th>Campaign</th>
                <th>Publisher</th>
                <th>Status</th>
                <th className="text-right">Monthly</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {numbers?.map((n) => (
                <tr key={n.id} className={table.row}>
                  <td>
                    <div className="font-mono font-medium">{formatPhone(n.e164)}</div>
                    <div className="text-xs text-faint">{n.label ?? 'No label'}</div>
                  </td>
                  <td className="text-muted">{TYPE_LABEL[n.type]}</td>
                  <td className={n.campaign ? '' : 'text-faint'}>{n.campaign?.name ?? 'Not assigned'}</td>
                  <td className={n.publisher ? '' : 'text-faint'}>{n.publisher?.name ?? '—'}</td>
                  <td>{n.status === 'ACTIVE' ? <Badge tone="green" dot>Active</Badge> : <Badge tone="yellow" dot>Activating…</Badge>}</td>
                  <td className="text-right font-mono tabular">{Number(n.monthlyPrice) === 0 ? <span className="font-sans text-muted">Included</span> : money(n.monthlyPrice)}</td>
                  <td className="whitespace-nowrap text-right">
                    <IconButton icon={Pencil} aria-label={`Edit ${formatPhone(n.e164)}`} onClick={() => setEditing(n)} className="h-8 w-8" />
                    {n.status === 'ACTIVE' && (
                      <IconButton icon={Trash2} aria-label={`Release ${formatPhone(n.e164)}`} onClick={() => release(n)} className="h-8 w-8 hover:text-danger" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <Modal title={`Edit ${formatPhone(editing.e164)}`} onClose={() => setEditing(null)}>
          <EditNumber
            n={editing}
            onDone={(msg) => {
              setEditing(null);
              if (msg) {
                setNotice(msg);
                load();
              }
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export default function NumbersPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER']}>
      <NumbersContent />
    </AppShell>
  );
}
