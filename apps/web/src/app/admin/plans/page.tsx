'use client';

import { Plus, Tag } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, Card, Field, Modal, PageHeader, Toggle, table } from '@/components/ui';
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
  active: boolean;
  _count: { tenants: number };
}

function PlanForm({ plan, onDone }: { plan?: Plan; onDone: () => void }) {
  const [white, setWhite] = useState(plan?.whiteLabel ?? false);
  const [domain, setDomain] = useState(plan?.customDomain ?? false);
  const [active, setActive] = useState(plan?.active ?? true);
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const maxUsers = String(f.get('maxUsers') ?? '').trim();
    const json = {
      code: f.get('code'),
      name: f.get('name'),
      monthlyPrice: Number(f.get('monthlyPrice')),
      perMinuteRate: Number(f.get('perMinuteRate')),
      includedNumbers: Number(f.get('includedNumbers')),
      maxUsers: maxUsers === '' ? null : Number(maxUsers),
      whiteLabel: white,
      customDomain: domain,
      active,
    };
    const ok = await run(() => (plan ? api(`/admin/plans/${plan.id}`, { method: 'PATCH', json }) : api('/admin/plans', { method: 'POST', json })));
    if (ok) onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" defaultValue={plan?.name} required minLength={2} />
        <Field label="Code" name="code" defaultValue={plan?.code} required pattern="[a-z0-9-]{2,30}" hint="Lowercase, e.g. growth" />
        <Field label="Monthly price ($)" name="monthlyPrice" type="number" min={0} step="0.01" defaultValue={plan?.monthlyPrice ?? 0} required hint="0 = custom / contact sales" />
        <Field label="Per call minute ($)" name="perMinuteRate" type="number" min={0} step="0.0001" defaultValue={plan?.perMinuteRate ?? 0.025} required />
        <Field label="Numbers included" name="includedNumbers" type="number" min={0} defaultValue={plan?.includedNumbers ?? 5} required />
        <Field label="Team members" name="maxUsers" type="number" min={1} defaultValue={plan?.maxUsers ?? ''} hint="Empty = unlimited" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Toggle label="Custom branding" checked={white} onChange={setWhite} />
        <Toggle label="Custom domain" checked={domain} onChange={setDomain} />
        <Toggle label="Offered to customers" checked={active} onChange={setActive} />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save plan'}</Button>
      </div>
    </form>
  );
}

function PlansContent() {
  const { data, error, reload } = useApi<Plan[]>('/admin/plans');
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={Tag} title="Plans" subtitle="What customers pay. Price changes apply at each customer's next renewal.">
        <Button icon={Plus} onClick={() => setEditing('new')}>New plan</Button>
      </PageHeader>
      {error && <Alert>{error}</Alert>}
      <Card flush className="overflow-x-auto">
        <table className={`${table.wrap} min-w-[820px]`}>
          <thead className={table.head}>
            <tr>
              <th>Plan</th>
              <th className="text-right">Monthly</th>
              <th className="text-right">Per minute</th>
              <th className="text-right">Numbers</th>
              <th className="text-right">Users</th>
              <th>Features</th>
              <th className="text-right">Customers</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id} className={table.row}>
                <td>
                  <div className="flex items-center gap-2 font-medium">{p.name} {!p.active && <Badge>Hidden</Badge>}</div>
                  <div className="font-mono text-xs text-muted">{p.code}</div>
                </td>
                <td className="text-right tabular-nums">{Number(p.monthlyPrice) ? money(p.monthlyPrice) : 'Custom'}</td>
                <td className="text-right tabular-nums">{(Number(p.perMinuteRate) * 100).toFixed(2)}¢</td>
                <td className="text-right">{p.includedNumbers}</td>
                <td className="text-right">{p.maxUsers ?? '∞'}</td>
                <td className="space-x-1">
                  {p.whiteLabel && <Badge tone="green">Branding</Badge>}
                  {p.customDomain && <Badge tone="green">Domain</Badge>}
                </td>
                <td className="text-right">{p._count.tenants}</td>
                <td className="text-right">
                  <button className="text-xs font-medium text-accent" onClick={() => setEditing(p)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {editing && (
        <Modal wide title={editing === 'new' ? 'New plan' : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <PlanForm
            plan={editing === 'new' ? undefined : editing}
            onDone={() => {
              setEditing(null);
              reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export default function PlansPage() {
  return (
    <AppShell allow={['SUPER_ADMIN']}>
      <PlansContent />
    </AppShell>
  );
}
