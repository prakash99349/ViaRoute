'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Briefcase, Hash, PhoneIncoming, Plus, Target, TrendingUp } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, Card, Empty, Field, Initials, Modal, PageHeader } from '@/components/ui';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

interface CampaignRow {
  id: string;
  name: string;
  active: boolean;
  revenue: string;
  payout: string;
  convertAfterSeconds: number;
  _count: { routes: number; phoneNumbers: number };
  last24h: { calls: number; revenue: string | number; payout: string | number };
}

function NewCampaign({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const created = await run(() =>
      api<{ id: string }>('/campaigns', {
        method: 'POST',
        json: {
          name: f.get('name'),
          revenue: Number(f.get('revenue') || 0),
          payout: Number(f.get('payout') || 0),
          convertAfterSeconds: Number(f.get('convertAfterSeconds') || 90),
        },
      }),
    );
    if (created) router.push(`/campaigns/${created.id}`);
  }

  return (
    <Modal title="New campaign" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Campaign name" name="name" required minLength={2} placeholder="e.g. Auto Insurance – US" autoFocus />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Revenue per converted call ($)" name="revenue" type="number" min={0} step="0.01" defaultValue={0} hint="What buyers pay you." />
          <Field label="Payout per converted call ($)" name="payout" type="number" min={0} step="0.01" defaultValue={0} hint="What you pay publishers." />
        </div>
        <Field label="A call converts after (seconds)" name="convertAfterSeconds" type="number" min={0} max={3600} defaultValue={90} hint="Talk time with the buyer needed to count as a sale." />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create campaign'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function CampaignsContent() {
  const { data, error } = useApi<CampaignRow[]>('/campaigns');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    // Arriving from "New campaign" elsewhere (e.g. the dashboard).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the URL
    if (new URLSearchParams(window.location.search).get('new') === '1') setCreating(true);
  }, []);

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={Target} title="Campaigns" subtitle="A campaign connects your tracking numbers to the buyers who take the calls.">
        <Button icon={Plus} onClick={() => setCreating(true)}>New campaign</Button>
      </PageHeader>
      {error && <Alert>{error}</Alert>}

      {data?.length === 0 && (
        <Card>
          <Empty
            icon={Target}
            title="No campaigns yet"
            text="Create a campaign, add buyers and assign a tracking number — then calls start routing."
            action={<Button icon={Plus} onClick={() => setCreating(true)}>New campaign</Button>}
          />
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {data?.map((c) => {
          const profit = Number(c.last24h.revenue) - Number(c.last24h.payout);
          const needs = c._count.routes === 0 ? 'Add a buyer' : c._count.phoneNumbers === 0 ? 'Assign a tracking number' : null;
          return (
            <Link key={c.id} href={`/campaigns/${c.id}`} className="group block rounded-xl border border-border bg-card p-5 transition hover:border-border-strong hover:shadow-sm">
              <div className="flex items-start gap-3">
                <Initials name={c.name} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold group-hover:underline">{c.name}</div>
                  <div className="text-xs text-muted">
                    {money(c.revenue)} revenue · {money(c.payout)} payout · {c.convertAfterSeconds}s
                  </div>
                </div>
                {c.active ? <Badge tone="green" dot>Active</Badge> : <Badge dot>Paused</Badge>}
              </div>
              <dl className="mt-4 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-border bg-border text-center">
                {[
                  { icon: Briefcase, label: 'Buyers', v: c._count.routes },
                  { icon: Hash, label: 'Numbers', v: c._count.phoneNumbers },
                  { icon: PhoneIncoming, label: 'Calls 24h', v: c.last24h.calls },
                  { icon: TrendingUp, label: 'Profit 24h', v: money(profit) },
                ].map(({ icon: Icon, label, v }) => (
                  <div key={label} className="bg-card px-1 py-2.5">
                    <dd className="font-mono text-sm font-medium tabular">{v}</dd>
                    <dt className="mt-0.5 flex items-center justify-center gap-1 text-[11px] text-faint">
                      <Icon size={11} aria-hidden /> {label}
                    </dt>
                  </div>
                ))}
              </dl>
              {needs && (
                <div className="mt-3 flex items-center gap-1.5 text-xs text-warning">
                  <AlertTriangle size={13} aria-hidden /> {needs} to start receiving calls
                </div>
              )}
            </Link>
          );
        })}
      </div>

      {creating && <NewCampaign onClose={() => setCreating(false)} />}
    </div>
  );
}

export default function CampaignsPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER']}>
      <CampaignsContent />
    </AppShell>
  );
}
