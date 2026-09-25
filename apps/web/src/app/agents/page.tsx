'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Headphones, KeyRound, PhoneIncoming, Plus, Radio, Timer, Trash2, UserPlus } from 'lucide-react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, Card, Empty, Field, IconButton, Modal, PageHeader, Select, Stat, StatStrip, table } from '@/components/ui';
import { api, duration, formatPhone } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useApi } from '@/lib/use-api';

interface AgentRow {
  id: string;
  targetId: string;
  user: { id: string; name: string; email: string; role: string; lastLoginAt: string | null };
  target: { id: string; name: string; ringTimeoutSec: number; active: boolean; _count: { routes: number } };
  available: boolean;
  legs: { legId: string; caller: string; state: 'ringing' | 'active'; campaign: string | null }[];
  callsToday: number;
  talkSecToday: number;
  sipUsername: string | null;
}

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  pending: boolean;
}

function AddAgent({ agents, onDone }: { agents: AgentRow[]; onDone: (msg?: string) => void }) {
  const { data: team } = useApi<{ members: Member[] }>('/team');
  const { busy, error, run } = useAction();
  const taken = new Set(agents.map((a) => a.user.id));
  const eligible = (team?.members ?? []).filter((m) => !taken.has(m.id) && ['TENANT_ADMIN', 'MANAGER', 'AGENT'].includes(m.role));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const user = eligible.find((m) => m.id === f.get('userId'));
    if (await run(() => api('/agents', { method: 'POST', json: { userId: f.get('userId'), ringTimeoutSec: Number(f.get('ring')) } }))) onDone(`${user?.name} is now an agent`);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {team && eligible.length === 0 ? (
        <p className="text-sm text-muted">
          Everyone on your team is already an agent. <Link href="/team" className="text-accent">Invite someone</Link> with the <b>Agent</b> role — they&apos;ll only see their softphone and their own calls.
        </p>
      ) : (
        <>
          <Select label="Team member" name="userId" required defaultValue="">
            <option value="" disabled>Choose…</option>
            {eligible.map((m) => <option key={m.id} value={m.id}>{m.name} — {m.email}{m.pending ? ' (invited)' : ''}</option>)}
          </Select>
          <Field label="Ring for (seconds)" name="ring" type="number" min={5} max={120} defaultValue={20} hint="Then the call goes to the next buyer or agent." />
          <p className="text-xs text-muted">The agent becomes a <b>target</b>: add it to campaigns like any buyer, with priority, hours and caps. They take one call at a time and only ring while Available.</p>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => onDone()}>Cancel</Button>
        <Button type="submit" disabled={busy || !eligible.length}>{busy ? 'Adding…' : 'Add agent'}</Button>
      </div>
    </form>
  );
}

function AgentsContent() {
  const { user } = useAuth();
  const { data, reload } = useApi<AgentRow[]>('/agents');
  const [adding, setAdding] = useState(false);
  const [sip, setSip] = useState<{ name: string; username: string; password: string; domain: string } | null>(null);
  const act = useAction();

  const remove = (a: AgentRow) =>
    confirm(`Remove ${a.user.name} as an agent? They'll be taken off every campaign. Their login stays.`) &&
    act.run(() => api(`/agents/${a.id}`, { method: 'DELETE' }), `${a.user.name} removed`).then(reload);
  const showSip = (a: AgentRow) =>
    act.run(async () => {
      const s = await api<{ username: string; password: string; domain: string }>(`/agents/${a.id}/sip`, { method: 'POST' });
      setSip({ name: a.user.name, ...s });
    });

  const online = data?.filter((a) => a.available).length ?? 0;
  const onCall = data?.filter((a) => a.legs.some((l) => l.state === 'active')).length ?? 0;
  const calls = data?.reduce((s, a) => s + a.callsToday, 0) ?? 0;
  const talk = data?.reduce((s, a) => s + a.talkSecToday, 0) ?? 0;

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={Headphones} title="Agents" subtitle="Your own team taking calls in the browser softphone or on a SIP phone.">
        <Button icon={Plus} onClick={() => setAdding(true)}>Add agent</Button>
      </PageHeader>
      {act.error && <Alert>{act.error}</Alert>}
      {act.notice && <Success>{act.notice}</Success>}

      <StatStrip cols={4}>
        <Stat icon={Radio} label="Available now" value={data ? `${online} / ${data.length}` : '—'} />
        <Stat icon={PhoneIncoming} label="On a call" value={data ? onCall : '—'} />
        <Stat icon={Headphones} label="Calls today" value={data ? calls : '—'} />
        <Stat icon={Timer} label="Talk time today" value={data ? duration(talk) : '—'} />
      </StatStrip>

      <Card flush className="overflow-x-auto">
        {data?.length === 0 ? (
          <Empty
            icon={Headphones}
            title="No agents yet"
            text="Add a team member as an agent, then add them to a campaign. They answer in the softphone that appears in their portal."
            action={<Button icon={UserPlus} onClick={() => setAdding(true)}>Add agent</Button>}
          />
        ) : (
          <table className={`${table.wrap} min-w-[860px]`}>
            <thead className={table.head}>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Now</th>
                <th className="text-right">Campaigns</th>
                <th className="text-right">Calls today</th>
                <th className="text-right">Talk today</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data?.map((a) => {
                const now = a.legs[0];
                return (
                  <tr key={a.id} className={table.row}>
                    <td>
                      <div className="font-medium">{a.user.name}</div>
                      <div className="text-xs text-faint">{a.user.email} · {a.user.role === 'AGENT' ? 'Agent login' : a.user.role === 'TENANT_ADMIN' ? 'Admin' : 'Manager'}</div>
                    </td>
                    <td>{a.available ? <Badge tone="green" dot>Available</Badge> : <Badge dot>Away</Badge>}</td>
                    <td className="text-xs">
                      {now ? (
                        <span className={now.state === 'ringing' ? 'text-warning' : 'text-success'}>
                          {now.state === 'ringing' ? 'Ringing' : 'Talking'} · {/^\+\d+$/.test(now.caller) ? formatPhone(now.caller) : now.caller}
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="text-right font-mono tabular">
                      {a.target._count.routes === 0 ? <Link href="/campaigns" className="font-sans text-xs text-warning">Not on a campaign</Link> : a.target._count.routes}
                    </td>
                    <td className="text-right font-mono tabular">{a.callsToday}</td>
                    <td className="text-right font-mono tabular">{duration(a.talkSecToday)}</td>
                    <td className="whitespace-nowrap text-right">
                      {user?.role === 'TENANT_ADMIN' && <Button variant="subtle" size="sm" icon={KeyRound} onClick={() => showSip(a)}>SIP phone</Button>}
                      <IconButton icon={Trash2} aria-label={`Remove ${a.user.name}`} onClick={() => remove(a)} className="h-8 w-8 hover:text-danger" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <p className="text-xs text-muted">
        Audio works on <b>Telnyx</b> and <b>Twilio</b> carriers (browser softphone), and SIP phones on Telnyx. On the Test carrier the softphone rings and can be answered, without audio.
      </p>

      {adding && (
        <Modal title="Add an agent" onClose={() => setAdding(false)}>
          <AddAgent agents={data ?? []} onDone={(msg) => { setAdding(false); if (msg) { act.setNotice(msg); reload(); } }} />
        </Modal>
      )}
      {sip && (
        <Modal title={`SIP phone — ${sip.name}`} onClose={() => setSip(null)}>
          <div className="space-y-4 text-sm">
            <p className="text-muted">Enter these in any SIP phone or app (Zoiper, Linphone, a desk phone). Calls ring there while the agent is Available.</p>
            <dl className="grid grid-cols-[110px_1fr] gap-y-2">
              <dt className="text-muted">Server</dt><dd className="font-mono">{sip.domain}</dd>
              <dt className="text-muted">Username</dt><dd className="font-mono">{sip.username}</dd>
              <dt className="text-muted">Password</dt><dd className="font-mono">{sip.password}</dd>
              <dt className="text-muted">Transport</dt><dd>TLS or UDP, port 5061 / 5060</dd>
            </dl>
            <Alert tone="warning">Treat the password like any other — anyone with it can take this agent&apos;s calls.</Alert>
            <div className="flex justify-end"><Button onClick={() => setSip(null)}>Done</Button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function AgentsPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER']}>
      <AgentsContent />
    </AppShell>
  );
}
