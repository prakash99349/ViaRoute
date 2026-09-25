'use client';

import { Users } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, Card, Field, table } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Role } from '@/lib/types';

interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  pending: boolean;
  emailVerified: boolean;
  twofaEnabled: boolean;
  lastLoginAt: string | null;
}

const ROLE_LABEL: Partial<Record<Role, string>> = { TENANT_ADMIN: 'Admin', MANAGER: 'Manager', PUBLISHER: 'Publisher', BUYER: 'Buyer', AGENT: 'Agent' };
const selectCls = 'h-9 rounded-lg border border-border-strong bg-card px-3 text-sm outline-none focus:border-foreground/40';

function TeamContent() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'TENANT_ADMIN';
  const [members, setMembers] = useState<Member[]>([]);
  const [maxUsers, setMaxUsers] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ members: Member[]; maxUsers: number | null }>('/team')
      .then((r) => {
        setMembers(r.members);
        setMaxUsers(r.maxUsers);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
      load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function onInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const json = Object.fromEntries(new FormData(form));
    setBusy(true);
    const ok = await run(() => api('/team/invite', { method: 'POST', json }), `Invite sent to ${json.email}`);
    setBusy(false);
    if (ok) {
      form.reset();
      setShowInvite(false);
    }
  }

  const atLimit = maxUsers !== null && members.length >= maxUsers;

  return (
    <div className="w-full space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight"><Users size={22} strokeWidth={1.75} className="text-faint" aria-hidden />Team</h1>
          <p className="text-sm text-muted">
            {members.length} {maxUsers !== null ? `of ${maxUsers}` : ''} users on your plan
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setShowInvite((v) => !v)} disabled={atLimit} title={atLimit ? 'Upgrade your plan to add more users' : undefined}>
            + Invite member
          </Button>
        )}
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Success>{notice}</Success>}

      {showInvite && (
        <Card>
          <form onSubmit={onInvite} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
            <Field label="Name" name="name" required minLength={2} autoFocus />
            <Field label="Email" name="email" type="email" required />
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Role</span>
              <select name="role" className={`w-full ${selectCls}`} defaultValue="MANAGER">
                <option value="MANAGER">Manager</option>
                <option value="TENANT_ADMIN">Admin</option>
                <option value="AGENT">Agent (softphone only)</option>
              </select>
            </label>
            <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send invite'}</Button>
          </form>
          <p className="mt-3 text-xs text-muted">
            <b>Admin</b>: everything, including billing and team. <b>Manager</b>: campaigns, numbers and reports. <b>Agent</b>: takes calls in the softphone and sees only their own calls — add them under Agents.
          </p>
        </Card>
      )}

      <Card flush className="overflow-x-auto">
        <table className={`${table.wrap} min-w-[640px]`}>
          <thead className={table.head}>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Security</th>
              <th>Last login</th>
              {isAdmin && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isMe = m.id === user?.id;
              return (
                <tr key={m.id} className={table.row}>
                  <td>
                    <div className="font-medium">
                      {m.name} {isMe && <span className="text-xs text-muted">(you)</span>}
                    </div>
                    <div className="text-xs text-muted">{m.email}</div>
                  </td>
                  <td>
                    {isAdmin && !isMe && !m.pending ? (
                      <select
                        className={selectCls}
                        value={m.role}
                        onChange={(e) => run(() => api(`/team/${m.id}/role`, { method: 'PATCH', json: { role: e.target.value } }), `${m.name}'s role updated`)}
                      >
                        <option value="TENANT_ADMIN">Admin</option>
                        <option value="MANAGER">Manager</option>
                      </select>
                    ) : (
                      ROLE_LABEL[m.role]
                    )}
                  </td>
                  <td className="space-x-1">
                    {m.pending ? (
                      <Badge tone="yellow">Invite pending</Badge>
                    ) : (
                      <>
                        {m.twofaEnabled ? <Badge tone="green">2FA on</Badge> : <Badge>2FA off</Badge>}
                        {!m.emailVerified && <Badge tone="yellow">Unverified</Badge>}
                      </>
                    )}
                  </td>
                  <td className="text-muted">{m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : '—'}</td>
                  {isAdmin && (
                    <td className="space-x-3 whitespace-nowrap text-right">
                      {m.pending && (
                        <button className="text-xs font-medium text-accent" onClick={() => run(() => api(`/team/${m.id}/resend-invite`, { method: 'POST' }), `Invite re-sent to ${m.email}`)}>
                          Resend
                        </button>
                      )}
                      {!isMe && (
                        <button
                          className="text-xs font-medium text-red-600"
                          onClick={() => confirm(`Remove ${m.name} from the team?`) && run(() => api(`/team/${m.id}`, { method: 'DELETE' }), `${m.name} was removed`)}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export default function TeamPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER']}>
      <TeamContent />
    </AppShell>
  );
}
