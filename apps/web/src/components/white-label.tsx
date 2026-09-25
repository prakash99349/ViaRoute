'use client';

import { ExternalLink, Globe, Palette, Phone, Upload } from 'lucide-react';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { api, ROOT_DOMAIN } from '@/lib/api';
import { useAction } from '@/lib/use-api';
import type { Branding } from '@/lib/types';
import { Success } from './auth-card';
import { Alert, Badge, Button, Card, CardHeader, Field } from './ui';

/** What the white-label cards need to know about a customer. */
export interface WhiteLabelTenant {
  id: string;
  name: string;
  subdomain: string;
  branding: Branding | null;
  customDomain: string | null;
  customDomainVerified: boolean;
  customDomainTarget: string;
  plan: { name: string; whiteLabel: boolean; customDomain: boolean } | null;
}

/** Portal name, logo and color for one customer. Managed by the platform admin. */
export function BrandingCard({ t, onSaved }: { t: WhiteLabelTenant; onSaved: () => void }) {
  const [logo, setLogo] = useState<string | null>(t.branding?.logoUrl ?? null);
  const [color, setColor] = useState(t.branding?.primaryColor ?? '#16181d');
  const { busy, error, notice, setError, run } = useAction();

  function pickLogo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setError('Use a PNG, JPEG or WebP image');
    if (file.size > 200 * 1024) return setError('Logo must be smaller than 200 KB');
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await run(
      () => api(`/admin/tenants/${t.id}/branding`, { method: 'PATCH', json: { portalName: f.get('portalName') || null, primaryColor: color, logoUrl: logo } }),
      'Branding saved. The customer sees it on their next page load.',
    );
    if (ok) onSaved();
  }

  const reset = () =>
    run(() => api(`/admin/tenants/${t.id}/branding`, { method: 'PATCH', json: { portalName: null, primaryColor: null, logoUrl: null } }), 'Branding removed').then((ok) => {
      if (!ok) return;
      setLogo(null);
      setColor('#16181d');
      onSaved();
    });

  return (
    <Card>
      <CardHeader icon={Palette} title="Branding" subtitle="Portal name, logo and color on this customer's portal, login page and emails.">
        {t.plan && !t.plan.whiteLabel && <Badge tone="yellow">Not in {t.plan.name} plan</Badge>}
      </CardHeader>
      <form onSubmit={save} className="mt-4 grid max-w-2xl gap-4 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        {notice && <div className="sm:col-span-2"><Success>{notice}</Success></div>}
        <Field label="Portal name" name="portalName" defaultValue={t.branding?.portalName ?? ''} placeholder={t.name} maxLength={60} />
        <div className="space-y-1.5">
          <label htmlFor="brand-color" className="block text-sm font-medium">Main color</label>
          <div className="flex items-center gap-2">
            <input id="brand-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 cursor-pointer rounded-lg border border-border-strong bg-card" />
            <code className="font-mono text-[13px]">{color}</code>
          </div>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <span className="block text-sm font-medium">Logo</span>
          <div className="flex flex-wrap items-center gap-3">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- preview of an uploaded data URL
              <img src={logo} alt="Logo preview" className="h-12 w-12 rounded-lg border border-border object-contain" />
            ) : (
              <span className="flex h-12 w-12 items-center justify-center rounded-lg text-white" style={{ background: color }}><Phone size={20} aria-hidden /></span>
            )}
            <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium hover:bg-subtle">
              <Upload size={14} aria-hidden />Upload…
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={pickLogo} />
            </label>
            {logo && <button type="button" onClick={() => setLogo(null)} className="text-[13px] text-danger">Remove</button>}
            <span className="text-xs text-muted">PNG, JPEG or WebP, square, under 200 KB</span>
          </div>
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save branding'}</Button>
          {t.branding && <Button type="button" variant="secondary" disabled={busy} onClick={reset}>Reset to default</Button>}
        </div>
      </form>
    </Card>
  );
}

/** Customer's own web address (calls.theircompany.com). Managed by the platform admin. */
export function CustomDomainCard({ t, onChanged }: { t: WhiteLabelTenant; onChanged: () => void }) {
  const { busy, error, notice, run } = useAction();
  const base = `/admin/tenants/${t.id}/domain`;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const domain = String(new FormData(e.currentTarget).get('domain'));
    if (await run(() => api(base, { method: 'PUT', json: { domain } }))) onChanged();
  }

  return (
    <Card>
      <CardHeader icon={Globe} title="Custom domain" subtitle={`Always available at ${t.subdomain}.${ROOT_DOMAIN}. A custom domain adds an address like calls.theircompany.com.`}>
        {t.plan && !t.plan.customDomain && <Badge tone="yellow">Not in {t.plan.name} plan</Badge>}
        {t.customDomain && (t.customDomainVerified ? <Badge tone="green" dot>Connected</Badge> : <Badge tone="yellow" dot>Waiting for DNS</Badge>)}
      </CardHeader>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {notice && <div className="mt-3"><Success>{notice}</Success></div>}
      {!t.customDomain ? (
        <form onSubmit={save} className="mt-4 flex max-w-lg items-end gap-2">
          <div className="flex-1"><Field label="Domain" name="domain" placeholder="calls.theircompany.com" required /></div>
          <Button type="submit" disabled={busy}>Connect</Button>
        </form>
      ) : (
        <div className="mt-4 space-y-4 text-sm">
          {!t.customDomainVerified && (
            <div className="rounded-lg border border-border bg-subtle/50 p-4">
              <div className="font-medium">The customer adds this DNS record at their domain provider:</div>
              <table className="mt-2 w-full max-w-lg text-left font-mono text-xs">
                <thead className="text-muted"><tr><th className="py-1">Type</th><th>Name</th><th>Value</th></tr></thead>
                <tbody><tr><td className="py-1">CNAME</td><td>{t.customDomain}</td><td>{t.customDomainTarget}</td></tr></tbody>
              </table>
              <p className="mt-2 text-xs text-muted">Then click Verify. DNS changes can take up to an hour. HTTPS is set up automatically.</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{t.customDomain}</span>
            {t.customDomainVerified ? (
              <a href={`https://${t.customDomain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent">Open <ExternalLink size={13} aria-hidden /></a>
            ) : (
              <Button disabled={busy} onClick={() => run(() => api(`${base}/verify`, { method: 'POST' }), 'Domain connected.').then((r) => r && onChanged())}>
                Verify
              </Button>
            )}
            <Button variant="secondary" disabled={busy} onClick={() => confirm('Disconnect this domain?') && run(() => api(base, { method: 'DELETE' })).then(onChanged)}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
