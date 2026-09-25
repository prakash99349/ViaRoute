'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { Clock, Crosshair, Gauge, Globe, Pencil, Phone, Plus, Trash2 } from 'lucide-react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { CapsFields, capFill, capsFrom, describeCaps, DestinationFields, type CapUsage, type Caps, type DestinationType } from '@/components/routing-fields';
import { Alert, Badge, Button, Card, Empty, Field, IconButton, Modal, PageHeader, Select, Toggle, table } from '@/components/ui';
import { api, formatPhone } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

interface Target extends Caps {
  id: string;
  name: string;
  buyerId: string | null;
  buyer: { id: string; name: string; active: boolean } | null;
  destinationType: DestinationType;
  destination: string;
  ringTimeoutSec: number;
  priority: number;
  active: boolean;
  liveCalls: number;
  usage: CapUsage;
  _count: { routes: number; calls: number };
}

function TargetForm({ initial, buyers, onDone }: { initial?: Target; buyers: { id: string; name: string }[]; onDone: () => void }) {
  const [active, setActive] = useState(initial?.active ?? true);
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const json = {
      name: f.get('name'),
      buyerId: f.get('buyerId') || null,
      destinationType: f.get('destinationType'),
      destination: f.get('destination'),
      priority: Number(f.get('priority')),
      ringTimeoutSec: Number(f.get('ringTimeoutSec')),
      ...capsFrom(f),
      active,
    };
    const ok = await run(() => (initial ? api(`/targets/${initial.id}`, { method: 'PATCH', json }) : api('/targets', { method: 'POST', json })));
    if (ok) onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" defaultValue={initial?.name} required minLength={2} autoFocus placeholder="e.g. Dallas call center" />
        <Select label="Belongs to" name="buyerId" defaultValue={initial?.buyerId ?? ''} hint="Direct = no buyer, e.g. your own agents.">
          <option value="">No buyer — direct target</option>
          {buyers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      </div>
      <DestinationFields typeLabel="Target type" type={initial?.destinationType} value={initial?.destination} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Priority" name="priority" type="number" min={1} max={99} defaultValue={initial?.priority ?? 1} required hint="1 is tried first. Used when you add this target to a campaign; each campaign can change it." />
        <Field label="Ring for (seconds)" name="ringTimeoutSec" type="number" min={5} max={120} defaultValue={initial?.ringTimeoutSec ?? 20} hint="Then the call goes to the next one." />
      </div>
      <CapsFields initial={initial} hint="Counted across every campaign that sends calls to this target." />
      <Toggle label="Active" checked={active} onChange={setActive} hint="Paused targets get no calls." />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

function TargetsContent() {
  const { data, error, reload } = useApi<Target[]>('/targets');
  const { data: buyers } = useApi<{ id: string; name: string }[]>('/buyers');
  const [editing, setEditing] = useState<Target | 'new' | null>(null);
  const [owner, setOwner] = useState('');
  const act = useAction();

  const shown = useMemo(
    () => (data ?? []).filter((t) => !owner || (owner === 'direct' ? !t.buyerId : t.buyerId === owner)),
    [data, owner],
  );

  const remove = (t: Target) =>
    confirm(`Delete ${t.name}? It will be removed from all campaigns. Call history is kept.`) &&
    act.run(() => api(`/targets/${t.id}`, { method: 'DELETE' }), `${t.name} deleted`).then(reload);

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={Crosshair} title="Targets" subtitle="Where calls ring: a number or IP. Belongs to a buyer, or direct (your own agents).">
        <Button icon={Plus} onClick={() => setEditing('new')}>Add target</Button>
      </PageHeader>
      {(error || act.error) && <Alert>{error || act.error}</Alert>}
      {act.notice && <Success>{act.notice}</Success>}

      {!!data?.length && (
        <div className="w-56">
          <Select aria-label="Filter by buyer" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">All targets</option>
            <option value="direct">Direct (no buyer)</option>
            {buyers?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </div>
      )}

      <Card flush className="overflow-x-auto">
        {data?.length === 0 ? (
          <Empty
            icon={Crosshair}
            title="No targets yet"
            text="Add a target to send calls straight to a number or IP — a buyer's second call center, or your own team. Then add it to a campaign."
            action={<Button icon={Plus} onClick={() => setEditing('new')}>Add target</Button>}
          />
        ) : (
          <table className={`${table.wrap} min-w-[980px]`}>
            <thead className={table.head}>
              <tr>
                <th>Priority</th>
                <th>Target</th>
                <th>Buyer</th>
                <th>Type &amp; destination</th>
                <th>Caps (now)</th>
                <th>Ring</th>
                <th className="text-right">Campaigns</th>
                <th className="text-right">Calls</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const fill = capFill(t, t.usage);
                return (
                  <tr key={t.id} className={`${table.row} ${t.active ? '' : 'opacity-60'}`}>
                    <td>
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-subtle font-mono text-xs font-semibold">{t.priority}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2 font-medium">
                        {t.name} {!t.active && <Badge dot>Paused</Badge>}
                      </div>
                    </td>
                    <td>
                      {t.buyer ? (
                        <span className="inline-flex items-center gap-1.5">
                          {t.buyer.name} {!t.buyer.active && <Badge dot>Paused</Badge>}
                        </span>
                      ) : (
                        <Badge tone="blue">Direct</Badge>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <Badge tone={t.destinationType === 'PHONE' ? 'gray' : 'blue'}>
                          {t.destinationType === 'PHONE' ? <Phone size={11} aria-hidden /> : <Globe size={11} aria-hidden />}
                          {t.destinationType === 'PHONE' ? 'Number' : 'IP'}
                        </Badge>
                        <span className="font-mono text-xs">{t.destinationType === 'PHONE' ? formatPhone(t.destination) : t.destination.replace(/^sips?:/, '')}</span>
                      </div>
                    </td>
                    <td className="text-xs">
                      <div className="flex items-center gap-2">
                        <Gauge size={13} className={fill >= 1 ? 'text-danger' : fill >= 0.8 ? 'text-warning' : 'text-faint'} aria-hidden />
                        <span className={fill >= 1 ? 'text-danger' : 'text-muted'}>{describeCaps(t, t.usage)}</span>
                      </div>
                      {fill >= 1 && <div className="mt-0.5 text-[11px] text-danger">Full — calls go to the next one</div>}
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1.5 text-muted"><Clock size={13} aria-hidden />{t.ringTimeoutSec}s</span>
                    </td>
                    <td className="text-right font-mono tabular">{t._count.routes}</td>
                    <td className="text-right font-mono tabular">{t._count.calls}</td>
                    <td className="whitespace-nowrap text-right">
                      <IconButton icon={Pencil} aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)} className="h-8 w-8" />
                      <IconButton icon={Trash2} aria-label={`Delete ${t.name}`} onClick={() => remove(t)} className="h-8 w-8 hover:text-danger" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {!!data?.length && (
        <p className="text-xs text-muted">
          Add targets to a campaign from its page under <Link href="/campaigns" className="text-accent">Campaigns</Link> → Add buyer or target.
        </p>
      )}

      {editing && (
        <Modal wide title={editing === 'new' ? 'Add target' : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <TargetForm
            initial={editing === 'new' ? undefined : editing}
            buyers={buyers ?? []}
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

export default function TargetsPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER']}>
      <TargetsContent />
    </AppShell>
  );
}
