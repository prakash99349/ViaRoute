'use client';

import { useState, type FormEvent } from 'react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { InvitePartner } from '@/components/invite-partner';
import { Link2, Megaphone, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import { Alert, Badge, Button, Card, Empty, Field, IconButton, Initials, Modal, PageHeader, Toggle, table } from '@/components/ui';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

interface Publisher {
  id: string;
  name: string;
  email: string | null;
  payoutOverride: string | null;
  postbackUrl: string | null;
  active: boolean;
  _count: { phoneNumbers: number; calls: number };
}

const MACROS = ['{call_id}', '{caller}', '{duration}', '{connected}', '{payout}', '{revenue}', '{campaign}', '{publisher}', '{tracking_number}'];

function PublisherForm({ initial, onDone }: { initial?: Publisher; onDone: () => void }) {
  const [active, setActive] = useState(initial?.active ?? true);
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const payout = String(f.get('payoutOverride') ?? '').trim();
    const json = {
      name: f.get('name'),
      email: f.get('email'),
      postbackUrl: f.get('postbackUrl'),
      payoutOverride: payout === '' ? null : Number(payout),
      active,
    };
    const ok = await run(() =>
      initial ? api(`/publishers/${initial.id}`, { method: 'PATCH', json }) : api('/publishers', { method: 'POST', json }),
    );
    if (ok) onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Field label="Name" name="name" defaultValue={initial?.name} required minLength={2} autoFocus />
      <Field label="Email (optional)" name="email" type="email" defaultValue={initial?.email ?? ''} />
      <Field
        label="Payout per converted call (optional)"
        name="payoutOverride"
        type="number"
        min={0}
        step="0.01"
        defaultValue={initial?.payoutOverride ?? ''}
        hint="Leave empty to use each campaign's payout."
      />
      <Field
        label="Postback URL (optional)"
        name="postbackUrl"
        type="url"
        placeholder="https://tracker.example.com/postback?clickid={call_id}&payout={payout}"
        defaultValue={initial?.postbackUrl ?? ''}
        hint={<>Called for every converted call. Available values: {MACROS.join(' ')}</>}
      />
      <Toggle label="Active" checked={active} onChange={setActive} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

function PublishersContent() {
  const { data, error, reload } = useApi<Publisher[]>('/publishers');
  const [editing, setEditing] = useState<Publisher | 'new' | null>(null);
  const [inviting, setInviting] = useState<Publisher | null>(null);
  const act = useAction();

  const remove = (p: Publisher) =>
    confirm(`Delete ${p.name}? Their numbers are kept but unassigned. Call history is kept.`) &&
    act.run(() => api(`/publishers/${p.id}`, { method: 'DELETE' }), `${p.name} deleted`).then(reload);

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={Megaphone} title="Publishers" subtitle="Traffic sources that send you calls — and get paid per converted call.">
        <Button icon={Plus} onClick={() => setEditing('new')}>Add publisher</Button>
      </PageHeader>
      {(error || act.error) && <Alert>{error || act.error}</Alert>}
      {act.notice && <Success>{act.notice}</Success>}

      <Card flush className="overflow-x-auto">
        {data?.length === 0 ? (
          <Empty icon={Megaphone} title="No publishers yet" text="Add the affiliates or media buyers who send you calls, then give them tracking numbers." action={<Button icon={Plus} onClick={() => setEditing('new')}>Add publisher</Button>} />
        ) : (
          <table className={`${table.wrap} min-w-[720px]`}>
            <thead className={table.head}>
              <tr>
                <th>Publisher</th>
                <th>Payout</th>
                <th>Postback</th>
                <th className="text-right">Numbers</th>
                <th className="text-right">Calls</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data?.map((p) => (
                <tr key={p.id} className={table.row}>
                  <td>
                    <div className="flex items-center gap-3">
                      <Initials name={p.name} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium">
                          {p.name} {!p.active && <Badge dot>Paused</Badge>}
                        </div>
                        <div className="text-xs text-faint">{p.email ?? 'No email'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="font-mono tabular">{p.payoutOverride ? money(p.payoutOverride) : <span className="font-sans text-muted">Campaign default</span>}</td>
                  <td>{p.postbackUrl ? <Badge tone="green"><Link2 size={12} aria-hidden /> On</Badge> : <span className="text-faint">—</span>}</td>
                  <td className="text-right font-mono tabular">{p._count.phoneNumbers}</td>
                  <td className="text-right font-mono tabular">{p._count.calls}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button variant="subtle" size="sm" icon={UserPlus} onClick={() => setInviting(p)}>Invite login</Button>
                    <IconButton icon={Pencil} aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)} className="h-8 w-8" />
                    <IconButton icon={Trash2} aria-label={`Delete ${p.name}`} onClick={() => remove(p)} className="h-8 w-8 hover:text-danger" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <Modal title={editing === 'new' ? 'Add publisher' : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <PublisherForm
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
            kind="PUBLISHER"
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

export default function PublishersPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER']}>
      <PublishersContent />
    </AppShell>
  );
}
