'use client';

import type { FormEvent } from 'react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-api';
import { Alert, Button, Field } from './ui';

/** Gives a publisher or buyer their own limited login to the portal. */
export function InvitePartner({ kind, partnerId, name, onDone }: { kind: 'PUBLISHER' | 'BUYER'; partnerId: string; name: string; onDone: (msg: string) => void }) {
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const json = {
      email: f.get('email'),
      name: f.get('name'),
      role: kind,
      ...(kind === 'PUBLISHER' ? { publisherId: partnerId } : { buyerId: partnerId }),
    };
    const ok = await run(() => api('/team/invite', { method: 'POST', json }));
    if (ok) onDone(`Invite sent to ${json.email}`);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted">
        {name} will get their own login to this portal and see <b>only their own calls</b>
        {kind === 'PUBLISHER' ? ' and payouts' : ' and what they pay'}.
      </p>
      {error && <Alert>{error}</Alert>}
      <Field label="Contact name" name="name" required minLength={2} autoFocus />
      <Field label="Email" name="email" type="email" required />
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send invite'}</Button>
      </div>
    </form>
  );
}
