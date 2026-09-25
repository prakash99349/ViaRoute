'use client';

import { Building2 } from 'lucide-react';
import { type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';
import { Success } from './auth-card';
import { TimeZoneSelect } from './timezone-select';
import { Alert, Button, Card, CardHeader, Field } from './ui';

interface TenantInfo {
  name: string;
  timezone: string;
}

/** Company-level settings, for account admins. Branding and domains are set by the platform admin. */
export function AccountSettings() {
  const { data: t, reload } = useApi<TenantInfo>('/tenant');
  const { busy, error, notice, run } = useAction();
  if (!t) return null;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (await run(() => api('/tenant/settings', { method: 'PATCH', json: { name: f.get('name'), timezone: f.get('timezone') } }), 'Saved')) reload();
  }

  return (
    <Card>
      <CardHeader icon={Building2} title="Company" subtitle="Your company name and the portal's timezone." />
      <form onSubmit={save} className="mt-4 grid max-w-2xl gap-4 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        {notice && <div className="sm:col-span-2"><Success>{notice}</Success></div>}
        <Field label="Company name" name="name" defaultValue={t.name} required minLength={2} />
        <TimeZoneSelect label="Portal timezone" name="timezone" defaultValue={t.timezone} />
        <p className="text-xs text-muted sm:col-span-2">
          Used for buyer business hours and daily caps, and as the default for reports. Each person can choose their own under Preferences.
        </p>
        <div><Button type="submit" disabled={busy}>Save</Button></div>
      </form>
    </Card>
  );
}
