'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Spinner } from '@/components/ui';
import { api, ROOT_DOMAIN } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { LoginResult } from '@/lib/types';

const toSubdomain = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32);

export default function SignupPage() {
  const { portal, loading, finishLogin } = useAuth();
  const [subdomain, setSubdomain] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const json = Object.fromEntries(new FormData(e.currentTarget));
    setError('');
    setBusy(true);
    try {
      finishLogin(await api<LoginResult>('/auth/signup', { method: 'POST', json }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;
  if (!portal?.platform) {
    return <div className="p-8 text-center text-muted">Sign up is only available on the main site.</div>;
  }

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Create your call portal</h1>
          <p className="text-sm text-muted">14-day free trial · no card required</p>
        </div>
        <Card>
          <form onSubmit={onSubmit} className="space-y-4">
            {error && <Alert>{error}</Alert>}
            <Field
              label="Company name"
              name="companyName"
              required
              autoFocus
              onChange={(e) => !touched && setSubdomain(toSubdomain(e.target.value).replace(/-+$/, ''))}
            />
            <Field
              label="Portal address"
              name="subdomain"
              required
              value={subdomain}
              onChange={(e) => {
                setTouched(true);
                setSubdomain(toSubdomain(e.target.value));
              }}
              hint={<>Your portal: <b>{subdomain || 'yourcompany'}.{ROOT_DOMAIN}</b></>}
            />
            <Field label="Your name" name="name" required autoComplete="name" />
            <Field label="Work email" name="email" type="email" required autoComplete="email" />
            <Field label="Password" name="password" type="password" required minLength={8} autoComplete="new-password" hint="At least 8 characters" />
            <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Creating portal…' : 'Create portal'}</Button>
          </form>
        </Card>
        <p className="text-center text-sm text-muted">
          Already have an account? <Link href="/login" className="font-medium text-accent">Log in</Link>
        </p>
      </div>
    </div>
  );
}
