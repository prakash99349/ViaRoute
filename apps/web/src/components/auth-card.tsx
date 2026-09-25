'use client';

import { Phone } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useDocumentBrand, ViaRouteMark } from './brand';
import { Alert, Card, Spinner } from './ui';

/** Centered, portal-branded card used by login, reset password, invites, etc. */
export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const { portal, portalError, loading } = useAuth();
  const tenantPortal = portal && !portal.platform ? portal : null;
  useDocumentBrand(title, tenantPortal);
  if (loading) return <Spinner />;
  if (portalError) return <div className="p-8 text-center">{portalError}</div>;

  const brandName = portal?.branding?.portalName ?? portal?.name ?? 'ViaRoute';
  const color = portal?.branding?.primaryColor;

  return (
    <div className="flex flex-1 items-center justify-center p-4" style={color ? ({ '--brand': color } as CSSProperties) : undefined}>
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          {portal?.branding?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- tenant logo (data URL)
            <img src={portal.branding.logoUrl} alt={brandName} className="mx-auto h-12 w-12 rounded-xl object-contain" />
          ) : tenantPortal ? (
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-brand-contrast"><Phone size={22} strokeWidth={2} aria-hidden /></div>
          ) : (
            <ViaRouteMark size={48} className="mx-auto" />
          )}
          <div className="mt-3 text-sm font-medium text-muted">{brandName}</div>
          <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        <Card>{children}</Card>
        {footer && <div className="text-center text-sm text-muted">{footer}</div>}
      </div>
    </div>
  );
}

export function Success({ children }: { children: ReactNode }) {
  return <Alert tone="success">{children}</Alert>;
}
