'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Alert, Button, Field, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useHashToken } from '@/lib/use-hash-token';
import type { LoginResult } from '@/lib/types';

export default function AcceptInvitePage() {
  const token = useHashToken();
  const { portal, finishLogin } = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get('password') !== form.get('confirm')) return setError("Passwords don't match");
    setError('');
    setBusy(true);
    try {
      const r = await api<LoginResult>('/auth/accept-invite', { method: 'POST', json: { token, password: form.get('password') } });
      finishLogin(r);
      router.replace('/dashboard');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (token === undefined) return <Spinner />;

  return (
    <AuthCard title={`Join ${portal?.name ?? 'your team'}`} subtitle="Set a password to activate your account.">
      {!token ? (
        <Alert>This invite link is missing its code. Please use the link from your email, or ask your admin to resend it. <Link href="/login" className="underline">Log in</Link></Alert>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label="Password" name="password" type="password" minLength={8} autoComplete="new-password" required autoFocus hint="At least 8 characters" />
          <Field label="Confirm password" name="confirm" type="password" minLength={8} autoComplete="new-password" required />
          <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Activating…' : 'Activate account'}</Button>
        </form>
      )}
    </AuthCard>
  );
}
