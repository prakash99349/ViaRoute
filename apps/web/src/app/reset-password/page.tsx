'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthCard, Success } from '@/components/auth-card';
import { Alert, Button, Field, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useHashToken } from '@/lib/use-hash-token';

export default function ResetPasswordPage() {
  const token = useHashToken();
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get('password') !== form.get('confirm')) return setError("Passwords don't match");
    setError('');
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', json: { token, password: form.get('password') } });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (token === undefined) return <Spinner />;

  return (
    <AuthCard title="Choose a new password" footer={<Link href="/login" className="text-accent">← Back to login</Link>}>
      {!token ? (
        <Alert>This link is missing its code. Please use the link from your email, or <Link href="/forgot-password" className="underline">request a new one</Link>.</Alert>
      ) : done ? (
        <div className="space-y-4">
          <Success>Your password has been changed. For your security, you&apos;ve been logged out everywhere.</Success>
          <Link href="/login" className="block w-full rounded-lg bg-brand px-4 py-2 text-center text-sm font-medium text-brand-contrast">Log in</Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label="New password" name="password" type="password" minLength={8} autoComplete="new-password" required autoFocus hint="At least 8 characters" />
          <Field label="Confirm new password" name="confirm" type="password" minLength={8} autoComplete="new-password" required />
          <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</Button>
        </form>
      )}
    </AuthCard>
  );
}
