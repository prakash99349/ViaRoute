'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, portalUrl, tokenStore } from './api';
import type { LoginResult, PortalInfo, User } from './types';

interface AuthState {
  portal: PortalInfo | null;
  portalError: string | null;
  user: User | null;
  loading: boolean;
  /** Stores the session, or sends the browser to the user's own portal. */
  finishLogin: (r: LoginResult) => void;
  logout: () => void;
  /** Reloads the current user (after verifying email, changing 2FA…). */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [portal, setPortal] = useState<PortalInfo | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped on every login/logout, so a slow check of an older session can't overwrite a newer one.
  const session = useRef(0);

  useEffect(() => {
    const started = session.current;
    (async () => {
      try {
        setPortal(await api<PortalInfo>('/tenant/public'));
        if (tokenStore.get()) {
          const me = await api<User>('/auth/me');
          if (session.current === started) setUser(me);
        }
      } catch (e) {
        if ((e as { status?: number }).status === 404) setPortalError('This portal does not exist.');
        if (session.current === started) tokenStore.clear();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const finishLogin = useCallback((r: LoginResult) => {
    if (r.redirect) {
      window.location.href = portalUrl(r.redirect.subdomain, `/auth/callback#h=${r.redirect.handoffToken}`);
      return;
    }
    if (r.token && r.user) {
      session.current++;
      tokenStore.set(r.token);
      setUser(r.user);
    }
  }, []);

  const refreshUser = useCallback(async () => {
    setUser(await api<User>('/auth/me'));
  }, []);

  const logout = useCallback(() => {
    session.current++;
    tokenStore.clear();
    setUser(null); // AppShell sees no user and redirects to /login
  }, []);

  return (
    <AuthContext.Provider value={{ portal, portalError, user, loading, finishLogin, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
