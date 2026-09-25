'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { LoginResult } from '@/lib/types';

/** Landing page after signup / main-site login: swaps the one-time handoff token for a session. */
export default function AuthCallback() {
  const { finishLogin } = useAuth();
  const router = useRouter();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const handoffToken = new URLSearchParams(window.location.hash.slice(1)).get('h');
    history.replaceState(null, '', window.location.pathname); // drop the token from the address bar
    if (!handoffToken) {
      router.replace('/login');
      return;
    }
    api<LoginResult>('/auth/handoff', { method: 'POST', json: { handoffToken } })
      .then((r) => {
        if (r.twofaRequired && r.challengeToken) {
          sessionStorage.setItem('vr_2fa', r.challengeToken); // login page asks for the code
          router.replace('/login');
          return;
        }
        finishLogin(r);
        router.replace('/dashboard');
      })
      .catch((e) => setError((e as Error).message));
  }, [finishLogin, router]);

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <p>{error}</p>
        <a href="/login" className="text-accent">Go to login →</a>
      </div>
    );
  }
  return <Spinner />;
}
