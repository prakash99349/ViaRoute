'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Alert, Button, Field, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { LoginResult } from '@/lib/types';

export default function LoginPage() {
  const { portal, user, finishLogin } = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);

  useEffect(() => {
    if (user) router.replace(user.role === 'SUPER_ADMIN' ? '/admin' : '/dashboard');
  }, [user, router]);

  // Arriving from the main site with 2FA on: go straight to the code step.
  useEffect(() => {
    const pending = sessionStorage.getItem('vr_2fa');
    if (!pending) return;
    sessionStorage.removeItem('vr_2fa');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of browser-only state
    setChallengeToken(pending);
  }, []);

  async function submit(path: string, json: object) {
    setError('');
    setBusy(true);
    try {
      const r = await api<LoginResult>(path, { method: 'POST', json });
      if (r.twofaRequired && r.challengeToken) {
        setChallengeToken(r.challengeToken);
        setBusy(false);
        return;
      }
      finishLogin(r);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const onPassword = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit('/auth/login', Object.fromEntries(new FormData(e.currentTarget)));
  };
  const onCode = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit('/auth/login/2fa', { challengeToken, code: new FormData(e.currentTarget).get('code') });
  };

  if (user) return <Spinner />;

  if (challengeToken) {
    return (
      <AuthCard title="Two-factor authentication" subtitle="Enter the 6-digit code from your authenticator app.">
        <form onSubmit={onCode} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus />
          <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</Button>
          <button type="button" onClick={() => setChallengeToken(null)} className="w-full text-sm text-muted hover:text-foreground">
            ← Back
          </button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Log in"
      subtitle="Welcome back"
      footer={portal?.platform && <>New here? <Link href="/signup" className="font-medium text-accent">Create your portal</Link></>}
    >
      <form onSubmit={onPassword} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <div className="-mt-2 text-right">
          <Link href="/forgot-password" className="text-xs text-accent">Forgot password?</Link>
        </div>
        <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</Button>
      </form>
    </AuthCard>
  );
}
