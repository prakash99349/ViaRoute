const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const ROOT_DOMAIN =
  (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? '').trim().replace(/^["']|["']$/g, '').replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase() ||
  'localhost:3000';

const TOKEN_KEY = 'vr_token';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const tokenStore = {
  get: () => (typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** Calls the API as the current portal (the browser's host tells the API which tenant this is). */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Tenant-Host', window.location.host);
  const token = tokenStore.get();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.json !== undefined) headers.set('Content-Type', 'application/json');

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = Array.isArray(body?.message) ? body.message.join('. ') : body?.message ?? res.statusText;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

/** URL of a customer's portal, e.g. http://acme.localhost:3000/auth/callback */
export function portalUrl(subdomain: string, path = '/') {
  return `${window.location.protocol}//${subdomain}.${ROOT_DOMAIN}${path}`;
}

export const money = (v: string | number) =>
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** +14155550123 → (415) 555-0123 */
export function formatPhone(e164: string) {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** 125 → "2:05" */
export function duration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Downloads a file from the API with the session (plain links can't send the login token). */
export async function download(path: string, filename: string) {
  const headers = new Headers({ 'X-Tenant-Host': window.location.host });
  const token = tokenStore.get();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${API_URL}${path}`, { headers });
  if (!res.ok) throw new ApiError(res.status, 'Download failed');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

export const API_BASE = API_URL;

/** "Sep 25, 6:07 PM" */
export function shortDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
