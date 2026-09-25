'use client';

import { Globe, KeyRound, Settings, ShieldCheck, UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Success } from '@/components/auth-card';
import { AccountSettings } from '@/components/account-settings';
import { AppShell } from '@/components/app-shell';
import { TimeZoneSelect } from '@/components/timezone-select';
import { Alert, Badge, Button, Card, CardHeader, Field } from '@/components/ui';
import { api, tokenStore } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { browserTimeZone } from '@/lib/date-range';
import { useAction } from '@/lib/use-api';
import type { LoginResult } from '@/lib/types';

function ChangePassword() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get('newPassword') !== f.get('confirm')) return setMsg({ ok: false, text: "New passwords don't match" });
    setBusy(true);
    try {
      const r = await api<LoginResult>('/auth/change-password', {
        method: 'POST',
        json: { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') },
      });
      if (r.token) tokenStore.set(r.token); // this device stays logged in
      form.reset();
      setMsg({ ok: true, text: 'Password changed. Other devices have been logged out.' });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="flex items-center gap-2 text-[15px] font-semibold"><KeyRound size={17} strokeWidth={1.75} className="text-faint" aria-hidden />Change password</h2>
      <form onSubmit={onSubmit} className="mt-4 max-w-sm space-y-4">
        {msg && (msg.ok ? <Success>{msg.text}</Success> : <Alert>{msg.text}</Alert>)}
        <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" required />
        <Field label="New password" name="newPassword" type="password" minLength={8} autoComplete="new-password" required hint="At least 8 characters" />
        <Field label="Confirm new password" name="confirm" type="password" minLength={8} autoComplete="new-password" required />
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</Button>
      </form>
    </Card>
  );
}

function TwoFactor() {
  const { user, refreshUser } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(fn: () => Promise<unknown>, success?: string) {
    setMsg(null);
    setBusy(true);
    try {
      await fn();
      if (success) setMsg({ ok: true, text: success });
      return true;
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const start = () => call(async () => setSetup(await api('/auth/2fa/setup', { method: 'POST' })));

  const enable = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = new FormData(e.currentTarget).get('code');
    if (await call(() => api('/auth/2fa/enable', { method: 'POST', json: { code } }), 'Two-factor authentication is on.')) {
      setSetup(null);
      await refreshUser();
    }
  };

  const disable = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = new FormData(e.currentTarget).get('password');
    if (await call(() => api('/auth/2fa/disable', { method: 'POST', json: { password } }), 'Two-factor authentication is off.')) {
      setDisabling(false);
      await refreshUser();
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold"><ShieldCheck size={17} strokeWidth={1.75} className="text-faint" aria-hidden />Two-factor authentication</h2>
        {user?.twofaEnabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted">
        Protect your account with a 6-digit code from an app like Google Authenticator, Authy or 1Password.
      </p>

      <div className="mt-4 max-w-md space-y-4">
        {msg && (msg.ok ? <Success>{msg.text}</Success> : <Alert>{msg.text}</Alert>)}

        {!user?.twofaEnabled && !setup && <Button onClick={start} disabled={busy}>Set up 2FA</Button>}

        {setup && (
          <form onSubmit={enable} className="space-y-4">
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              <li>
                Scan this QR code with your authenticator app:
                {/* eslint-disable-next-line @next/next/no-img-element -- local data: URL */}
                <img src={setup.qrDataUrl} alt="2FA QR code" width={180} height={180} className="mt-2 rounded-lg border border-border bg-white p-2" />
                <div className="mt-2 text-xs text-muted">
                  Can&apos;t scan? Enter this key: <code className="break-all font-mono">{setup.secret}</code>
                </div>
              </li>
              <li>Enter the 6-digit code it shows:</li>
            </ol>
            <Field label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>Turn on</Button>
              <Button type="button" variant="secondary" onClick={() => setSetup(null)}>Cancel</Button>
            </div>
          </form>
        )}

        {user?.twofaEnabled && !disabling && (
          <Button variant="secondary" onClick={() => setDisabling(true)}>Turn off 2FA</Button>
        )}
        {disabling && (
          <form onSubmit={disable} className="space-y-4">
            <Field label="Confirm with your password" name="password" type="password" autoComplete="current-password" required autoFocus />
            <div className="flex gap-2">
              <Button type="submit" variant="danger" disabled={busy}>Turn off</Button>
              <Button type="button" variant="secondary" onClick={() => setDisabling(false)}>Cancel</Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

function Preferences() {
  const { user, portal, refreshUser } = useAuth();
  const { busy, error, notice, run } = useAction();
  const fallback = portal?.timezone ?? browserTimeZone();

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const tz = String(new FormData(e.currentTarget).get('timezone') ?? '');
    const ok = await run(() => api('/auth/me', { method: 'PATCH', json: { timezone: tz || null } }), 'Saved. Dates and reports now use this timezone.');
    if (!ok) return;
    try {
      sessionStorage.removeItem('vr_range'); // pick up the new default on the next page
    } catch {
      /* private mode */
    }
    await refreshUser();
  }

  return (
    <Card>
      <CardHeader icon={Globe} title="Preferences" subtitle="Your default timezone for dates, the date range picker, reports and CSV downloads." />
      <form onSubmit={save} className="mt-4 grid max-w-2xl gap-4 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        {notice && <div className="sm:col-span-2"><Success>{notice}</Success></div>}
        <TimeZoneSelect
          key={user?.timezone ?? ''}
          label="Default timezone"
          name="timezone"
          defaultValue={user?.timezone ?? ''}
          emptyLabel={`${portal?.timezone ? 'Same as portal' : 'Same as this device'} (${fallback.replace(/_/g, ' ')})`}
        />
        <div className="flex items-end"><Button type="submit" disabled={busy}>Save</Button></div>
      </form>
    </Card>
  );
}

function SettingsContent() {
  const { user } = useAuth();
  return (
    <div className="w-full space-y-5">
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight"><Settings size={22} strokeWidth={1.75} className="text-faint" aria-hidden />Settings</h1>
        <p className="text-sm text-muted">Your profile, security{" "}{user?.role === 'TENANT_ADMIN' ? 'and company settings' : ''}.</p>
      </div>
      <Card>
        <h2 className="flex items-center gap-2 text-[15px] font-semibold"><UserRound size={17} strokeWidth={1.75} className="text-faint" aria-hidden />Profile</h2>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[140px_1fr]">
          <dt className="text-muted">Name</dt>
          <dd>{user?.name}</dd>
          <dt className="text-muted">Email</dt>
          <dd className="flex items-center gap-2">
            {user?.email} {user?.emailVerified ? <Badge tone="green">Verified</Badge> : <Badge tone="yellow">Not verified</Badge>}
          </dd>
        </dl>
      </Card>
      <Preferences />
      <ChangePassword />
      <TwoFactor />
      {user?.role === 'TENANT_ADMIN' && <AccountSettings />}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <AppShell allow={['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'PUBLISHER', 'BUYER']}>
      <SettingsContent />
    </AppShell>
  );
}
