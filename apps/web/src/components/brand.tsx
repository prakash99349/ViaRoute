'use client';

import { useEffect } from 'react';

/**
 * The ViaRoute mark: a "V" drawn as a call route — caller → ViaRoute → buyer.
 * Shown on platform pages and on customer portals without white-label branding (see isWhiteLabeled).
 */
export const BRAND_NAME = 'ViaRoute';

type PortalBrand = { platform?: boolean; branding?: { portalName?: string; logoUrl?: string; primaryColor?: string } | null } | null | undefined;

/** A customer portal with its own name, logo or color. Without that, portals show the ViaRoute brand. */
export const isWhiteLabeled = (portal: PortalBrand) =>
  !!portal && !portal.platform && !!(portal.branding?.portalName || portal.branding?.logoUrl || portal.branding?.primaryColor);

/**
 * Browser tab title and icon. Platform pages: "Page · ViaRoute" with the ViaRoute icon.
 * Customer portals: "Page · Their portal" with their logo, or a plain square in their color.
 */
export function useDocumentBrand(page: string | undefined, portal: { name: string; branding?: { portalName?: string; logoUrl?: string; primaryColor?: string } | null } | null) {
  const name = portal ? portal.branding?.portalName ?? portal.name : BRAND_NAME;
  const logo = portal?.branding?.logoUrl;
  const color = portal?.branding?.primaryColor ?? '#16181d';
  useEffect(() => {
    document.title = page ? `${page} · ${name}` : name;
    const href = !portal
      ? '/icon.svg'
      : logo ??
        `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/></svg>`)}`;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-brand]');
    if (!link) {
      document.querySelectorAll('link[rel="icon"]').forEach((l) => l.remove());
      link = document.createElement('link');
      link.rel = 'icon';
      link.dataset.brand = '1';
      document.head.appendChild(link);
    }
    link.href = href;
  }, [page, name, logo, color, portal]);
}

export function ViaRouteMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={BRAND_NAME} className={`shrink-0 ${className}`}>
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path d="M9 10 L16 22 L23 10" fill="none" stroke="var(--brand-contrast)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="10" r="2.5" fill="var(--brand-contrast)" />
      <circle cx="16" cy="22" r="2.5" fill="var(--brand-contrast)" />
      <circle cx="23" cy="10" r="2.9" fill="var(--series-1)" stroke="var(--brand)" strokeWidth="1" />
    </svg>
  );
}

/** Mark + wordmark. */
export function ViaRouteLogo({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <ViaRouteMark size={size} />
      <span className="text-lg font-semibold tracking-tight">
        Via<span className="text-accent">Route</span>
      </span>
    </span>
  );
}
