'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { Alert } from './ui';

/** Reminder shown until the user confirms their email address. */
export function EmailBanner() {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function resend() {
    setState('sending');
    try {
      await api('/auth/resend-verification', { method: 'POST' });
      setState('sent');
    } catch {
      setState('error');
    }
  }

  return (
    <div className="mb-5 w-full">
      <Alert
        tone="warning"
        action={
          state === 'sent' ? (
            <span className="font-medium text-success">Sent — check your inbox</span>
          ) : (
            <button onClick={resend} disabled={state === 'sending'} className="font-medium text-accent disabled:opacity-50">
              {state === 'sending' ? 'Sending…' : state === 'error' ? 'Try again' : 'Resend email'}
            </button>
          )
        }
      >
        <b className="font-semibold">Please confirm your email address.</b> <span className="text-muted">We sent you a link when you signed up.</span>
      </Alert>
    </div>
  );
}
