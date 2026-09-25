'use client';

import { useState, type FormEvent } from 'react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { InvitePartner } from '@/components/invite-partner';
import Link from 'next/link';
import { Briefcase, Clock, Crosshair, Gauge, Globe, Pencil, Phone, Plus, Trash2, UserPlus } from 'lucide-react';
import { CapsFields, capFill, capsFrom, describeCaps, DestinationFields, type CapUsage, type Caps } from '@/components/routing-fields';
import { Alert, Badge, Button, Card, Empty, Field, IconButton, Initials, Modal, PageHeader, Toggle, table } from '@/components/ui';
import { api, formatPhone } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

interface Buyer extends Caps {
  id: string;
  name: string;
  destinationType: 'PHONE' | 'SIP';
  destination: string;
  email: string | null;
  ringTimeoutSec: number;
  active: boolean;
  usage: CapUsage;
  _count: { routes: number; calls: number; targets: number };
}

function BuyerForm({ initial, onDone }: { initial?: Buyer; onDone: () => void }) {
  const [active, setActive] = useState(initial?.active ?? true);
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const json = {
      name: f.get('name'),
      destinationType: f.get('destinationType'),
      destination: f.get('destination'),
      email: f.get('email'),
      ringTimeoutSec: Number(f.get('ringTimeoutSec')),
      ...capsFrom(f),
      active,
    };
    const ok = await run(() => (initial ? api(`/buyers/${initial.id}`, { method: 'PATCH', json }) : api('/buyers', { method: 'POST', json })));
    if (ok) onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <Alert>{error}</Alert>}
      <Field label="Name" name="name" defaultValue={initial?.name} required minLength={2} autoFocus />
      <DestinationFields typeLabel="Main line type" type={initial?.destinationType} value={initial?.destination} />
      <Field label="Ring for (seconds)" name="ringTimeoutSec" type="number" min={5} max={120} defaultValue={initial?.ringTimeoutSec ?? 20} hint="If they don't answer in time, the call goes to the next buyer." />
      <Field label="Email (optional)" name="email" type="email" defaultValue={initial?.email ?? ''} />
      <CapsFields initial={initial} hint="Buyer-wide: counts every call to this buyer — main line and all its targets — across every campaign." />
      <Toggle label="Active" checked={active} onChange={setActive} hint="Paused buyers get no calls." />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

function BuyersContent() {
  const { data, error, reload } = useApi<Buyer[]>('/buyers');
  const [editing, setEditing] = useState<Buyer | 'new' | null>(null);
  const [inviting, setInviting] = useState<Buyer | null>(null);
  const act = useAction();

  const remove = (b: Buyer) =>
    confirm(`Delete ${b.name}? It will be removed from all campaigns. Call history is kept.`) &&
    act.run(() => api(`/buyers/${b.id}`, { method: 'DELETE' }), `${b.name} deleted`).then(reload);

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={Briefcase} title="Buyers" subtitle="Businesses that receive and pay for your calls.">
        <Button icon={Plus} onClick={() => setEditing('new')}>Add buyer</Button>
      </PageHeader>
      {(error || act.error) && <Alert>{error || act.error}</Alert>}
      {act.notice && <Success>{act.notice}</Success>}

      <Card flush className="overflow-x-auto">
        {data?.length === 0 ? (
          <Empty icon={Briefcase} title="No buyers yet" text="Add the call centers or businesses you sell calls to, then add them to a campaign." action={<Button icon={Plus} onClick={() => setEditing('new')}>Add buyer</Button>} />
        ) : (
          <table className={`${table.wrap} min-w-[960px]`}>
            <thead className={table.head}>
              <tr>
                <th>Buyer</th>
                <th>Main line</th>
                <th>Caps (now)</th>
                <th>Ring time</th>
                <th className="text-right">Targets</th>
                <th className="text-right">Campaigns</th>
                <th className="text-right">Calls</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data?.map((b) => (
                <tr key={b.id} className={table.row}>
                  <td>
                    <div className="flex items-center gap-3">
                      <Initials name={b.name} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium">
                          {b.name} {!b.active && <Badge dot>Paused</Badge>}
                        </div>
                        <div className="text-xs text-faint">{b.email ?? 'No email'}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <Badge tone={b.destinationType === 'PHONE' ? 'gray' : 'blue'}>
                        {b.destinationType === 'PHONE' ? <Phone size={11} aria-hidden /> : <Globe size={11} aria-hidden />}
                        {b.destinationType === 'PHONE' ? 'Number' : 'IP'}
                      </Badge>
                      <span className="font-mono text-xs">{b.destinationType === 'PHONE' ? formatPhone(b.destination) : b.destination.replace(/^sips?:/, '')}</span>
                    </div>
                  </td>
                  <td className="text-xs">
                    <span className={`inline-flex items-center gap-1.5 ${capFill(b, b.usage) >= 1 ? 'text-danger' : 'text-muted'}`}>
                      <Gauge size={13} aria-hidden />{describeCaps(b, b.usage)}
                    </span>
                  </td>
                  <td>
                    <span className="inline-flex items-center gap-1.5 text-muted"><Clock size={13} aria-hidden />{b.ringTimeoutSec}s</span>
                  </td>
                  <td className="text-right">
                    <Link href="/targets" className="inline-flex items-center gap-1 font-mono tabular text-accent"><Crosshair size={12} aria-hidden />{b._count.targets}</Link>
                  </td>
                  <td className="text-right font-mono tabular">{b._count.routes}</td>
                  <td className="text-right font-mono tabular">{b._count.calls}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button variant="subtle" size="sm" icon={UserPlus} onClick={() => setInviting(b)}>Invite login</Button>
                    <IconButton icon={Pencil} aria-label={`Edit ${b.name}`} onClick={() => setEditing(b)} className="h-8 w-8" />
                    <IconButton icon={Trash2} aria-label={`Delete ${b.name}`} onClick={() => remove(b)} className="h-8 w-8 hover:text-danger" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <Modal title={editing === 'new' ? 'Add buyer' : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <BuyerForm
            initial={editing === 'new' ? undefined : editing}
            onDone={() => {
              setEditing(null);
              reload();
            }}
          />
        </Modal>
      )}
      {inviting && (
        <Modal title={`Portal login for ${inviting.name}`} onClose={() => setInviting(null)}>
          <InvitePartner
            kind="BUYER"
            partnerId={inviting.id}
            name={inviting.name}
            onDone={(msg) => {
              setInviting(null);
              act.setNotice(msg);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export default function BuyersPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER']}>
      <BuyersContent />
    </AppShell>
  );
}
