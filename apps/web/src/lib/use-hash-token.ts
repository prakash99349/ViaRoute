'use client';

import { useEffect, useState } from 'react';

/**
 * Reads the one-time token from an email link (…/reset-password#t=TOKEN) and
 * removes it from the address bar. The #fragment is never sent to any server.
 * Returns undefined while reading, then the token or null.
 */
export function useHashToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get('t');
    if (t) history.replaceState(null, '', window.location.pathname);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of browser-only state
    setToken((prev) => prev ?? t);
  }, []);
  return token;
}
