'use client';

import { Building2 } from 'lucide-react';
import { type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';
import { Success } from './auth-card';
import { TimeZoneSelect } from './timezone-select';
import { Alert, Button, Card, CardHeader, Field, Select } from './ui';

interface TenantInfo {
  name: string;
  timezone: string;
  recordingRetentionDays: number | null;
}

/** Company-level settings, for account admins. Branding and domains are set by the platform admin. */
export function AccountSettings() {
  const { data: t, reload } = useApi<TenantInfo>('/tenant');
  const { busy, error, notice, run } = useAction();
  if (!t) return null;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (await run(() => api('/tenant/settings', { method: 'PATCH', json: { name: f.get('name'), timezone: f.get('timezone'), recordingRetentionDays: f.get('retention') === 'forever' ? null : Number(f.get('retention')) } }), 'Saved')) reload();
  }

  return (
    <Card>
      <CardHeader icon={Building2} title="Company" subtitle="Company name, portal timezone and how long recordings are kept." />
      <form onSubmit={save} className="mt-4 grid max-w-2xl gap-4 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        {notice && <div className="sm:col-span-2"><Success>{notice}</Success></div>}
        <Field label="Company name" name="name" defaultValue={t.name} required minLength={2} />
        <TimeZoneSelect label="Portal timezone" name="timezone" defaultValue={t.timezone} />
        <Select label="Keep call recordings for" name="retention" defaultValue={t.recordingRetentionDays === null ? 'forever' : String(t.recordingRetentionDays)} hint="Older recordings are deleted automatically.">
          {[30, 60, 90, 180, 365, 730].map((d) => <option key={d} value={d}>{d < 365 ? `${d} days` : `${d / 365} year${d === 365 ? '' : 's'}`}</option>)}
          {t.recordingRetentionDays !== null && ![30, 60, 90, 180, 365, 730].includes(t.recordingRetentionDays) && <option value={t.recordingRetentionDays}>{t.recordingRetentionDays} days</option>}
          <option value="forever">Forever</option>
        </Select>
        <p className="text-xs text-muted sm:col-span-2">
          Used for buyer business hours and daily caps, and as the default for reports. Each person can choose their own under Preferences.
        </p>
        <div><Button type="submit" disabled={busy}>Save</Button></div>
      </form>
    </Card>
  );
}
