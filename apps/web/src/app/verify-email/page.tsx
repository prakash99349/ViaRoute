'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AuthCard, Success } from '@/components/auth-card';
import { Alert, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useHashToken } from '@/lib/use-hash-token';

export default function VerifyEmailPage() {
  const token = useHashToken();
  const { user, refreshUser } = useAuth();
  const [state, setState] = useState<'working' | 'done' | string>('working');
  const started = useRef(false);

  useEffect(() => {
    if (token === undefined || started.current) return;
    started.current = true;
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to the one-time hash read
      setState('This link is missing its code. Please use the link from your email.');
      return;
    }
    api('/auth/verify-email', { method: 'POST', json: { token } })
      .then(() => {
        setState('done');
        if (user) refreshUser().catch(() => {});
      })
      .catch((e) => setState((e as Error).message));
  }, [token, user, refreshUser]);

  if (state === 'working') return <Spinner />;

  return (
    <AuthCard title={state === 'done' ? 'Email confirmed' : 'Could not confirm email'}>
      <div className="space-y-4">
        {state === 'done' ? <Success>Thanks! Your email address is confirmed.</Success> : <Alert>{state}</Alert>}
        <Link href={user ? '/dashboard' : '/login'} className="block w-full rounded-lg bg-brand px-4 py-2 text-center text-sm font-medium text-brand-contrast">
          {user ? 'Go to dashboard' : 'Log in'}
        </Link>
      </div>
    </AuthCard>
  );
}
