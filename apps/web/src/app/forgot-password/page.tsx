'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthCard, Success } from '@/components/auth-card';
import { Alert, Button, Field } from '@/components/ui';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email'));
    setError('');
    setBusy(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', json: { email } });
      setSentTo(email);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Forgot your password?"
      subtitle="We'll email you a link to choose a new one."
      footer={<Link href="/login" className="text-accent">← Back to login</Link>}
    >
      {sentTo ? (
        <Success>
          If an account exists for <b>{sentTo}</b>, a reset link is on its way. It expires in 1 hour — check your spam folder too.
        </Success>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus />
          <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</Button>
        </form>
      )}
    </AuthCard>
  );
}
