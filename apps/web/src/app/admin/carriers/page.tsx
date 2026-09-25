'use client';

import { useState, type FormEvent } from 'react';
import {
  Activity, AlertTriangle, CheckCircle2, Code2, Copy, FileText, FlaskConical, KeyRound, Network, RefreshCw, Pencil, PhoneIncoming, Plug, Plus, Star, Timer, Trash2, TrendingUp, Webhook,
} from 'lucide-react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, Card, Empty, Field, IconButton, Modal, PageHeader, Select, Spinner, Stat, StatStrip, Toggle } from '@/components/ui';
import { api, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

type CarrierType = 'TELNYX' | 'CUSTOM' | 'TWILIO' | 'SIGNALWIRE' | 'PLIVO' | 'BANDWIDTH' | 'VONAGE' | 'TEST';
type MarkupType = 'TWILIO' | 'SIGNALWIRE' | 'PLIVO' | 'BANDWIDTH' | 'VONAGE';
const isMarkup = (t: CarrierType): t is MarkupType => ['TWILIO', 'SIGNALWIRE', 'PLIVO', 'BANDWIDTH', 'VONAGE'].includes(t);
type CarrierStatus = 'ACTIVE' | 'DRAINING' | 'DISABLED';

interface Carrier {
  id: string;
  name: string;
  type: CarrierType;
  status: CarrierStatus;
  isDefault: boolean;
  credentialHint: string | null;
  hasApiKey: boolean;
  hasPublicKey: boolean;
  baseUrl: string | null;
  numbersApi: boolean;
  hasWebhookSecret: boolean;
  statusUrl: string | null;
  settings: Record<string, string>;
  secretsSet: string[];
  connectionId: string | null;
  webhookUrl: string | null;
  inboundPerMinute: string;
  outboundPerMinute: string;
  numberLocalMonthly: string;
  numberTollFreeMonthly: string;
  lastWebhookAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  notes: string | null;
  createdAt: string;
  stats: {
    numbers: number;
    numbersIncome: number;
    numbersCost: number;
    customers: number;
    callsToday: number;
    calls30d: number;
    minutes30d: number;
    usageIncome30d: number;
    usageCost30d: number;
    usageMargin30d: number;
  };
}

const TYPE_LABEL: Record<CarrierType, string> = {
  TELNYX: 'Telnyx', CUSTOM: 'Custom API', TWILIO: 'Twilio', SIGNALWIRE: 'SignalWire', PLIVO: 'Plivo', BANDWIDTH: 'Bandwidth', VONAGE: 'Vonage', TEST: 'Test (simulated)',
};

/** What can be added today, and what's on the roadmap. */
const CATALOG: { type?: CarrierType; name: string; text: string; icon: typeof Network }[] = [
  { type: 'TELNYX', name: 'Telnyx', text: 'Numbers, calls and recordings through your Telnyx account.', icon: Network },
  { type: 'CUSTOM', name: 'Custom API', text: 'Any carrier, softswitch or SIP platform (FreeSWITCH, Asterisk, wholesale carriers) via the ViaRoute Carrier API.', icon: Code2 },
  { type: 'TWILIO', name: 'Twilio', text: 'Numbers, calls and recordings through your Twilio account (TwiML).', icon: Network },
  { type: 'SIGNALWIRE', name: 'SignalWire', text: 'Your SignalWire space, through its Twilio-compatible LaML API.', icon: Network },
  { type: 'PLIVO', name: 'Plivo', text: 'Numbers, calls and recordings through Plivo (Plivo XML).', icon: Network },
  { type: 'BANDWIDTH', name: 'Bandwidth', text: 'Calls and recordings through Bandwidth (BXML). Numbers are ordered in Bandwidth and added here.', icon: Network },
  { type: 'VONAGE', name: 'Vonage', text: 'Calls through a Vonage Voice application (NCCO); numbers with the account API key.', icon: Network },
  { type: 'TEST', name: 'Test', text: 'Simulated numbers and calls for trying things out. Never rings anyone.', icon: FlaskConical },
];

interface CredField {
  key: string;
  label: string;
  secret?: boolean;
  textarea?: boolean;
  optional?: boolean;
  placeholder?: string;
  hint?: string;
}

/** Credentials each markup carrier needs (Telnyx and Custom API have their own sections). */
const FIELDS: Record<MarkupType, CredField[]> = {
  TWILIO: [
    { key: 'accountSid', label: 'Account SID', placeholder: 'AC…', hint: 'Twilio Console → Account info.' },
    { key: 'authToken', label: 'Auth Token', secret: true },
    { key: 'apiKeySid', label: 'API key SID', optional: true, placeholder: 'SK…', hint: 'For agents’ browser softphone (Console → API keys).' },
    { key: 'apiKeySecret', label: 'API key secret', secret: true, optional: true },
  ],
  SIGNALWIRE: [
    { key: 'spaceUrl', label: 'Space URL', placeholder: 'yourspace.signalwire.com' },
    { key: 'projectId', label: 'Project ID', placeholder: 'xxxxxxxx-xxxx-…' },
    { key: 'apiToken', label: 'API token', secret: true, hint: 'API → Tokens, with Voice and Numbers scopes.' },
  ],
  PLIVO: [
    { key: 'authId', label: 'Auth ID', placeholder: 'MA…' },
    { key: 'authToken', label: 'Auth Token', secret: true },
    { key: 'appId', label: 'Application ID', optional: true, hint: 'Voice → Applications. Numbers bought through ViaRoute are attached to it.' },
  ],
  BANDWIDTH: [
    { key: 'accountId', label: 'Account ID' },
    { key: 'applicationId', label: 'Voice application ID' },
    { key: 'username', label: 'API username' },
    { key: 'password', label: 'API password', secret: true },
  ],
  VONAGE: [
    { key: 'applicationId', label: 'Application ID', hint: 'Applications → your Voice app.' },
    { key: 'privateKey', label: 'Private key (PEM)', secret: true, textarea: true, placeholder: '-----BEGIN PRIVATE KEY-----', hint: 'Downloaded when the application was created.' },
    { key: 'apiKey', label: 'API key', optional: true, hint: 'Optional: needed to search, buy and release numbers.' },
    { key: 'apiSecret', label: 'API secret', secret: true, optional: true },
  ],
};

/** Where to paste our two URLs in each carrier's console. */
const SETUP: Record<MarkupType, string[]> = {
  TWILIO: [
    'Numbers bought through ViaRoute are configured automatically.',
    'For numbers you add yourself: Phone Numbers → the number → Voice: “A call comes in” → Webhook, HTTP POST = Answer URL; “Call status changes” = Status URL.',
  ],
  SIGNALWIRE: [
    'Numbers bought through ViaRoute are configured automatically.',
    'For numbers you add yourself: Phone Numbers → the number → “Handle calls using LaML Webhooks”: When a call comes in = Answer URL (POST); Status change callback = Status URL.',
  ],
  PLIVO: [
    'Voice → Applications → your application (the ID above): Answer URL = Answer URL, Hangup URL = Status URL, both POST.',
    'Numbers bought through ViaRoute are attached to that application.',
  ],
  BANDWIDTH: [
    'Your Voice application (the ID above): Call-initiated callback URL = Answer URL; Call status / disconnect callback URL = Status URL; method POST.',
    'Order numbers in the Bandwidth dashboard, assign them to the application, then add them to customers under Admin → Customers → Numbers → Add existing number.',
  ],
  VONAGE: [
    'Applications → your Voice application: Answer URL = Answer URL (HTTP POST), Event URL = Status URL (HTTP POST).',
    'With the API key and secret, numbers bought through ViaRoute are linked to the application automatically.',
  ],
};
const STATUS: Record<CarrierStatus, { label: string; tone: 'green' | 'yellow' | 'gray'; hint: string }> = {
  ACTIVE: { label: 'Active', tone: 'green', hint: 'New numbers and calls' },
  DRAINING: { label: 'Draining', tone: 'yellow', hint: 'Existing numbers keep working; no new numbers' },
  DISABLED: { label: 'Off', tone: 'gray', hint: 'Calls to its numbers are refused' },
};

function ago(s: string | null) {
  if (!s) return 'never';
  const min = (Date.now() - new Date(s).getTime()) / 60_000;
  return min < 2 ? 'just now' : min < 60 ? `${Math.round(min)} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
}
/** A live Telnyx account with numbers but no webhooks for a day: probably misconfigured. */
function isQuiet(c: Carrier) {
  return c.type !== 'TEST' && c.status === 'ACTIVE' && c.stats.numbers > 0 && (!c.lastWebhookAt || Date.now() - new Date(c.lastWebhookAt).getTime() > 24 * 3600_000);
}
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

/** A secret shown once, with a copy button. */
function SecretBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
      <code className="min-w-0 break-all rounded-md bg-warning-bg px-2 py-1 font-mono text-xs text-warning">{value}</code>
      <Button variant="secondary" size="sm" icon={Copy} onClick={() => navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

// ---------------------------------------------------------------------------

function CarrierForm({ initial, onDone }: { initial?: Carrier; onDone: (changed: boolean, secret?: { name: string; secret: string; url: string }) => void }) {
  const [type, setType] = useState<CarrierType>(initial?.type ?? 'TELNYX');
  const [numbersApi, setNumbersApi] = useState(initial?.numbersApi ?? false);
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const { busy, error, run } = useAction();
  const editing = !!initial;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? '').trim();
    const json = {
      name: str('name'),
      ...(editing ? {} : { type }),
      status: f.get('status') ?? undefined,
      ...(type === 'TELNYX' ? { credentials: { apiKey: str('apiKey'), publicKey: str('publicKey'), connectionId: str('connectionId'), sipConnectionId: str('sipConnectionId') } } : {}),
      ...(type === 'CUSTOM' ? { credentials: { apiKey: str('apiKey'), baseUrl: str('baseUrl'), numbersApi } } : {}),
      ...(isMarkup(type) ? { credentials: Object.fromEntries(FIELDS[type].map((f) => [f.key, str(f.key)])) } : {}),
      inboundPerMinute: Number(f.get('inboundPerMinute') || 0),
      outboundPerMinute: Number(f.get('outboundPerMinute') || 0),
      numberLocalMonthly: Number(f.get('numberLocalMonthly') || 0),
      numberTollFreeMonthly: Number(f.get('numberTollFreeMonthly') || 0),
      notes: str('notes') || null,
      ...(isDefault && !initial?.isDefault ? { isDefault: true } : {}),
    };
    let created: { name: string; webhookSecret?: string; webhookUrl: string | null } | undefined;
    const ok = await run(async () => {
      if (editing) await api(`/admin/providers/${initial.id}`, { method: 'PATCH', json });
      else created = await api('/admin/providers', { method: 'POST', json });
    });
    if (ok) onDone(true, created?.webhookSecret ? { name: created.name, secret: created.webhookSecret, url: created.webhookUrl ?? '' } : undefined);
  }

  const secret = (has: boolean | undefined, label: string) => (editing && has ? `Saved — leave blank to keep` : label);

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" defaultValue={initial?.name} required minLength={2} placeholder="e.g. Telnyx — main, or Wholesale switch" autoFocus />
        {editing ? (
          <Select label="Status" name="status" defaultValue={initial.status} disabled={initial.isDefault} hint={initial.isDefault ? 'The default carrier is always active.' : undefined}>
            {(Object.keys(STATUS) as CarrierStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label} — {STATUS[s].hint}</option>)}
          </Select>
        ) : (
          <div />
        )}
      </div>

      {!editing && (
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Carrier type</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {CATALOG.map((k) => {
              const picked = k.type === type;
              return (
                <button
                  type="button"
                  key={k.name}
                  disabled={!k.type}
                  aria-pressed={picked}
                  onClick={() => k.type && setType(k.type)}
                  className={`flex flex-col items-start justify-start rounded-xl border p-3 text-left transition ${picked ? 'border-foreground bg-subtle' : 'border-border hover:border-border-strong'} disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <k.icon size={15} aria-hidden /> {k.name}
                    {!k.type && <Badge>Planned</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted">{k.text}</p>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      {type === 'TELNYX' && (
        <fieldset className="space-y-3 rounded-xl border border-border p-4">
          <legend className="flex items-center gap-1.5 px-1 text-[13px] font-medium"><KeyRound size={14} aria-hidden /> Credentials (stored encrypted, never shown again)</legend>
          <Field label="API key" name="apiKey" type="password" autoComplete="off" required={!editing} placeholder={secret(initial?.hasApiKey, 'KEY0123…')} hint="Telnyx portal → Keys & Credentials → API Keys." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Public key (webhook signing)" name="publicKey" type="password" autoComplete="off" placeholder={secret(initial?.hasPublicKey, 'Base64 public key')} hint="Keys & Credentials → Public Key. Needed to trust webhooks." />
            <Field label="Call Control app ID" name="connectionId" defaultValue={initial?.connectionId ?? ''} placeholder="e.g. 1293384261075731499" hint="Voice → Programmable Voice → your app." />
          </div>
          <Field label="SIP credential connection ID (optional)" name="sipConnectionId" defaultValue={initial?.settings?.sipConnectionId ?? ''} placeholder="For agent softphones and SIP phones" hint="Voice → SIP Trunking → a Credential connection. Agents’ browser softphone and SIP phone logins are created on it." />
        </fieldset>
      )}

      {isMarkup(type) && (
        <fieldset className="space-y-3 rounded-xl border border-border p-4">
          <legend className="flex items-center gap-1.5 px-1 text-[13px] font-medium"><KeyRound size={14} aria-hidden /> {TYPE_LABEL[type]} credentials (secrets are stored encrypted and never shown again)</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS[type].map((f) => {
              const saved = editing && (f.secret ? initial?.secretsSet.includes(f.key) : !!initial?.settings[f.key]);
              const placeholder = f.secret && saved ? 'Saved — leave blank to keep' : f.placeholder;
              const required = !editing && !f.optional;
              return f.textarea ? (
                <div key={f.key} className="space-y-1.5 sm:col-span-2">
                  <label htmlFor={`cred-${f.key}`} className="block text-[13px] font-medium">{f.label}</label>
                  <textarea id={`cred-${f.key}`} name={f.key} rows={4} required={required} placeholder={placeholder} autoComplete="off" spellCheck={false} className="w-full rounded-lg border border-border-strong bg-card px-3 py-2 font-mono text-xs outline-none focus:border-foreground/40" />
                  {f.hint && <span className="block text-xs text-muted">{f.hint}</span>}
                </div>
              ) : (
                <Field
                  key={f.key}
                  label={f.optional ? `${f.label} (optional)` : f.label}
                  name={f.key}
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  required={required}
                  defaultValue={f.secret ? undefined : initial?.settings[f.key] ?? ''}
                  placeholder={placeholder}
                  hint={f.hint}
                />
              );
            })}
          </div>
          <p className="text-xs text-muted">After saving, the carrier card shows the Answer and Status URLs to paste into {TYPE_LABEL[type]}.</p>
        </fieldset>
      )}

      {type === 'CUSTOM' && (
        <fieldset className="space-y-3 rounded-xl border border-border p-4">
          <legend className="flex items-center gap-1.5 px-1 text-[13px] font-medium"><Code2 size={14} aria-hidden /> ViaRoute Carrier API</legend>
          <Field label="API base URL" name="baseUrl" type="url" required={!editing} defaultValue={initial?.baseUrl ?? ''} placeholder="https://switch.example.com/viaroute/v1" hint="ViaRoute sends call commands here (answer, speak, dial, bridge, record, hangup)." />
          <Field label="API key" name="apiKey" type="password" autoComplete="off" placeholder={secret(initial?.hasApiKey, 'Sent as Authorization: Bearer …')} hint="Your platform checks it on every command." />
          <Toggle label="Carrier has a numbers API" checked={numbersApi} onChange={setNumbersApi} hint="On: customers search and buy numbers. Off: you add numbers to customers in Admin → Customers → Numbers." />
          <p className="text-xs text-muted">
            A webhook URL and signing secret are created when you save. Give your developers the{' '}
            <a href="/carrier-api.md" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent"><FileText size={12} aria-hidden /> API spec</a>.
          </p>
        </fieldset>
      )}

      <fieldset className="space-y-3">
        <legend className="text-[13px] font-medium">What this carrier charges you (USD)</legend>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Inbound / min" name="inboundPerMinute" type="number" min={0} step="0.0001" defaultValue={initial?.inboundPerMinute ?? ''} placeholder="0.0035" />
          <Field label="Outbound / min" name="outboundPerMinute" type="number" min={0} step="0.0001" defaultValue={initial?.outboundPerMinute ?? ''} placeholder="0.0050" />
          <Field label="Local number / mo" name="numberLocalMonthly" type="number" min={0} step="0.01" defaultValue={initial?.numberLocalMonthly ?? ''} placeholder="1.00" />
          <Field label="Toll-free / mo" name="numberTollFreeMonthly" type="number" min={0} step="0.01" defaultValue={initial?.numberTollFreeMonthly ?? ''} placeholder="1.50" />
        </div>
        <p className="text-xs text-muted">Used for margin reports. Number costs quoted by the carrier at purchase take priority.</p>
      </fieldset>

      <Field label="Notes (optional)" name="notes" defaultValue={initial?.notes ?? ''} placeholder="e.g. Account manager, contract end date" />
      {!initial?.isDefault && <Toggle label="Make this the default carrier" checked={isDefault} onChange={setIsDefault} hint="New numbers are bought here unless a customer has their own carrier." />}

      <div className="sticky -bottom-6 -mx-6 -mb-6 flex justify-end gap-2 border-t border-border bg-card px-6 py-4">
        <Button type="button" variant="secondary" onClick={() => onDone(false)}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Add carrier'}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function CarrierCard({ c, onEdit, onChanged }: { c: Carrier; onEdit: () => void; onChanged: (msg: string) => void }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const act = useAction();
  const s = c.stats;
  const numbersMargin = s.numbersIncome - s.numbersCost;
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [newUrls, setNewUrls] = useState<{ answerUrl: string; statusUrl: string } | null>(null);
  const costsMissing = c.type !== 'TEST' && Number(c.inboundPerMinute) === 0 && Number(c.outboundPerMinute) === 0;
  const stale = isQuiet(c);

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api<{ ok: boolean; message: string }>(`/admin/providers/${c.id}/test`, { method: 'POST' }));
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const remove = () =>
    confirm(`Delete ${c.name}? This can't be undone.`) && act.run(() => api(`/admin/providers/${c.id}`, { method: 'DELETE' })).then((ok) => ok && onChanged(`${c.name} deleted`));
  const rotate = () =>
    confirm('Create a new webhook secret? The old one stops working immediately — update your platform right after.') &&
    act.run(async () => setNewSecret((await api<{ webhookSecret: string }>(`/admin/providers/${c.id}/rotate-secret`, { method: 'POST' })).webhookSecret));
  const rotateUrls = () =>
    confirm('Create new webhook URLs? The current ones stop working immediately — update them in the carrier right after.') &&
    act.run(async () => setNewUrls(await api<{ answerUrl: string; statusUrl: string }>(`/admin/providers/${c.id}/rotate-secret`, { method: 'POST' })));
  const makeDefault = () => act.run(() => api(`/admin/providers/${c.id}`, { method: 'PATCH', json: { isDefault: true } })).then((ok) => ok && onChanged(`${c.name} is now the default carrier`));

  return (
    <Card className={c.status === 'DISABLED' ? 'opacity-70' : ''}>
      {/* Title row */}
      <div className="flex flex-wrap items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${c.type === 'TEST' ? 'bg-warning-bg text-warning' : 'bg-subtle text-foreground'}`}>
          {c.type === 'TEST' ? <FlaskConical size={19} aria-hidden /> : c.type === 'CUSTOM' ? <Code2 size={19} aria-hidden /> : <Network size={19} aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold">{c.name}</h2>
            <Badge>{TYPE_LABEL[c.type]}</Badge>
            <Badge tone={STATUS[c.status].tone} dot>{STATUS[c.status].label}</Badge>
            {c.isDefault && <Badge tone="blue"><Star size={11} aria-hidden /> Default</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {c.type === 'TELNYX' && <span>API key {c.credentialHint ?? <span className="text-danger">missing</span>}</span>}
            {c.type === 'TELNYX' && <span>Webhook signing {c.hasPublicKey ? 'on' : <span className="text-warning">off — add the public key</span>}</span>}
            {c.type === 'CUSTOM' && <span className="font-mono">{c.baseUrl}</span>}
            {c.type === 'CUSTOM' && <span>{c.numbersApi ? 'Numbers API on' : 'Numbers added by admin'}</span>}
            {isMarkup(c.type) && Object.entries(c.settings).map(([k, v]) => <span key={k}>{FIELDS[c.type as MarkupType].find((f) => f.key === k)?.label ?? k}: <span className="font-mono">{v}</span></span>)}
            {c.type === 'BANDWIDTH' && <span>Numbers added by admin</span>}
            {c.type === 'VONAGE' && <span>{c.secretsSet.includes('apiSecret') ? 'Numbers API on' : 'Numbers added by admin (no API key)'}</span>}
            {c.type !== 'TEST' && <span>Last webhook {ago(c.lastWebhookAt)}</span>}
            {c.notes && <span className="truncate">{c.notes}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="secondary" size="sm" icon={Plug} disabled={testing} onClick={test}>{testing ? 'Testing…' : 'Test connection'}</Button>
          {!c.isDefault && c.status === 'ACTIVE' && <Button variant="subtle" size="sm" icon={Star} onClick={makeDefault}>Make default</Button>}
          <IconButton icon={Pencil} aria-label={`Edit ${c.name}`} onClick={onEdit} className="h-8 w-8" />
          {!c.isDefault && <IconButton icon={Trash2} aria-label={`Delete ${c.name}`} onClick={remove} className="h-8 w-8 hover:text-danger" />}
        </div>
      </div>

      {testing && <div className="mt-3 flex items-center gap-2 text-sm text-muted"><Spinner /> Contacting {TYPE_LABEL[c.type]}…</div>}
      {result && (
        <div className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${result.ok ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'}`}>
          {result.ok ? <CheckCircle2 size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />} {result.message}
        </div>
      )}
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
      {c.lastError && !result && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>Last error {ago(c.lastErrorAt)}: {c.lastError}</span>
        </div>
      )}
      {stale && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          No webhooks from this account in 24 hours while it has live numbers — check the webhook URL below.
        </div>
      )}

      {/* Usage & money */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg bg-subtle/60 p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted"><PhoneIncoming size={13} aria-hidden /> Numbers & customers</div>
          <div className="mt-1 font-mono text-lg font-semibold tabular">{s.numbers}</div>
          <div className="text-xs text-muted">{s.customers ? `${s.customers} customer(s) pinned here` : 'no customers pinned'}</div>
        </div>
        <div className="rounded-lg bg-subtle/60 p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted"><Activity size={13} aria-hidden /> Calls</div>
          <div className="mt-1 font-mono text-lg font-semibold tabular">{s.callsToday} <span className="font-sans text-xs font-normal text-muted">today</span></div>
          <div className="text-xs text-muted">{s.calls30d.toLocaleString()} in 30 days · {s.minutes30d.toLocaleString()} min</div>
        </div>
        <div className="rounded-lg bg-subtle/60 p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted"><TrendingUp size={13} aria-hidden /> Call margin (30 days)</div>
          <div className={`mt-1 font-mono text-lg font-semibold tabular ${s.usageMargin30d < 0 ? 'text-danger' : ''}`}>{money(s.usageMargin30d)}</div>
          <div className="text-xs text-muted">{money(s.usageIncome30d)} billed − {money(s.usageCost30d)} carrier · {pct(s.usageMargin30d, s.usageIncome30d)}</div>
        </div>
        <div className="rounded-lg bg-subtle/60 p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted"><Timer size={13} aria-hidden /> Number margin (monthly)</div>
          <div className={`mt-1 font-mono text-lg font-semibold tabular ${numbersMargin < 0 ? 'text-danger' : ''}`}>{money(numbersMargin)}</div>
          <div className="text-xs text-muted">{money(s.numbersIncome)} rent − {money(s.numbersCost)} carrier</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span>Costs: {money(c.inboundPerMinute)}/min in · {money(c.outboundPerMinute)}/min out · {money(c.numberLocalMonthly)} local · {money(c.numberTollFreeMonthly)} toll-free</span>
        {costsMissing && <span className="text-warning">Per-minute costs not set — margins will look too high.</span>}
      </div>

      {/* Webhook setup */}
      {c.webhookUrl && (
        <details className="mt-4 rounded-lg border border-border">
          <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-[13px] font-medium"><Webhook size={14} aria-hidden /> {c.type === 'CUSTOM' ? 'Connect your platform' : `Setup in ${TYPE_LABEL[c.type]}`}</summary>
          <div className="space-y-3 border-t border-border px-4 py-3 text-sm">
            {isMarkup(c.type) ? (
              <>
                <div className="grid gap-2 text-xs sm:grid-cols-[90px_1fr]">
                  <span className="pt-1.5 text-muted">Answer URL</span>
                  <SecretBox value={newUrls?.answerUrl ?? c.webhookUrl} />
                  <span className="pt-1.5 text-muted">Status URL</span>
                  <SecretBox value={newUrls?.statusUrl ?? c.statusUrl ?? ''} />
                </div>
                {newUrls && <p className="text-xs text-warning">New URLs — paste them into {TYPE_LABEL[c.type]} now; the old ones no longer work.</p>}
                <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
                  {SETUP[c.type as MarkupType].map((step) => <li key={step}>{step}</li>)}
                  <li>Place a test call; <b>Last webhook</b> above should change to “just now”.</li>
                </ol>
                <p className="text-xs text-muted">
                  The URLs contain a secret token — treat them like a password.{' '}
                  <button type="button" onClick={rotateUrls} className="font-medium text-accent">Create new URLs</button>
                </p>
              </>
            ) : (
            <>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-subtle px-2.5 py-1.5 font-mono text-xs">{c.webhookUrl}</code>
              <Button
                variant="secondary"
                size="sm"
                icon={Copy}
                onClick={() => navigator.clipboard.writeText(c.webhookUrl!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            {c.type === 'CUSTOM' ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted">Webhook secret:</span>
                  {newSecret ? <SecretBox value={newSecret} /> : <span className="font-mono">{c.hasWebhookSecret ? 'whsec_•••••••• (hidden)' : 'not set'}</span>}
                  <Button variant="subtle" size="sm" icon={RefreshCw} onClick={rotate}>New secret</Button>
                </div>
                <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
                  <li>Your platform sends call events to the URL above, signed with the webhook secret (<code>X-ViaRoute-Signature</code>).</li>
                  <li>It accepts commands at <b>{c.baseUrl}</b> with the API key as a Bearer token.</li>
                  <li>Click <b>Test connection</b> — it calls <code>GET /health</code>.</li>
                  <li>Place a test call; <b>Last webhook</b> should change to “just now”.</li>
                </ol>
                <a href="/carrier-api.md" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-accent"><FileText size={12} aria-hidden /> Full API spec for developers</a>
              </>
            ) : (
            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
              <li>Telnyx portal → Voice → Programmable Voice → your Call Control app → set <b>Webhook URL</b> to the address above (API v2).</li>
              <li>Copy the app&apos;s ID into this carrier&apos;s <b>Call Control app ID</b>, so new numbers are attached to it.</li>
              <li>Keys & Credentials → <b>Public Key</b> → paste it here so ViaRoute can verify each webhook.</li>
              <li>Buy a test number and place a call; <b>Last webhook</b> above should change to “just now”.</li>
            </ol>
            )}
            </>
            )}
          </div>
        </details>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function CarriersContent() {
  const { data, error, reload } = useApi<Carrier[]>('/admin/providers');
  const [editing, setEditing] = useState<Carrier | 'new' | null>(null);
  const [notice, setNotice] = useState('');
  const [secret, setSecret] = useState<{ name: string; secret: string; url: string } | null>(null);

  const totals = (data ?? []).reduce(
    (t, c) => ({
      numbers: t.numbers + c.stats.numbers,
      calls: t.calls + c.stats.calls30d,
      margin: t.margin + c.stats.usageMargin30d,
      income: t.income + c.stats.usageIncome30d,
      numbersMargin: t.numbersMargin + c.stats.numbersIncome - c.stats.numbersCost,
    }),
    { numbers: 0, calls: 0, margin: 0, income: 0, numbersMargin: 0 },
  );
  const liveOnTest = data?.some((c) => c.type === 'TEST' && c.isDefault);

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={Network} title="Carriers" subtitle="Phone carrier accounts the platform buys numbers and connects calls through.">
        <Button icon={Plus} onClick={() => setEditing('new')}>Add carrier</Button>
      </PageHeader>
      {error && <Alert>{error}</Alert>}
      {notice && <Success>{notice}</Success>}
      {liveOnTest && (
        <Alert tone="warning">
          The default carrier is the <b>Test</b> carrier: numbers are simulated and won&apos;t ring. Add a Telnyx account and make it the default before going live.
        </Alert>
      )}

      <StatStrip cols={4}>
        <Stat icon={Network} label="Carriers" value={data ? data.filter((c) => c.status === 'ACTIVE').length : '—'} foot={data ? `${data.length} in total` : undefined} />
        <Stat icon={PhoneIncoming} label="Live numbers" value={data ? totals.numbers : '—'} />
        <Stat icon={Activity} label="Calls (30 days)" value={data ? totals.calls.toLocaleString() : '—'} />
        <Stat icon={TrendingUp} label="Call margin (30 days)" value={data ? money(totals.margin) : '—'} foot={data ? `${pct(totals.margin, totals.income)} · numbers ${money(totals.numbersMargin)}/mo` : undefined} />
      </StatStrip>

      {data?.length === 0 && <Card><Empty icon={Network} title="No carriers" /></Card>}
      <div className="space-y-4">
        {data?.map((c) => (
          <CarrierCard
            key={c.id}
            c={c}
            onEdit={() => setEditing(c)}
            onChanged={(msg) => {
              setNotice(msg);
              reload();
            }}
          />
        ))}
      </div>

      <p className="text-xs text-muted">
        A live call stays on the carrier its number belongs to — the caller and buyer legs must be on the same account to be connected. To move traffic, pin
        customers to another carrier (their new numbers go there) and set the old one to <b>Draining</b>.
      </p>

      {editing && (
        <Modal wide title={editing === 'new' ? 'Add carrier' : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <CarrierForm
            initial={editing === 'new' ? undefined : editing}
            onDone={(changed, created) => {
              setEditing(null);
              if (changed) {
                setNotice('Carrier saved');
                reload();
              }
              if (created) setSecret(created);
            }}
          />
        </Modal>
      )}
      {secret && (
        <Modal title={`${secret.name} — webhook secret`} onClose={() => setSecret(null)}>
          <div className="space-y-4 text-sm">
            <Alert tone="warning">Copy this secret now. It won&apos;t be shown again (you can create a new one later).</Alert>
            <div className="space-y-1.5">
              <div className="text-[13px] font-medium">Webhook URL</div>
              <SecretBox value={secret.url} />
            </div>
            <div className="space-y-1.5">
              <div className="text-[13px] font-medium">Webhook secret</div>
              <SecretBox value={secret.secret} />
            </div>
            <p className="text-xs text-muted">Your platform signs every event with it. See the <a href="/carrier-api.md" target="_blank" rel="noreferrer" className="text-accent">API spec</a>.</p>
            <div className="flex justify-end"><Button onClick={() => setSecret(null)}>I&apos;ve saved it</Button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function CarriersPage() {
  return (
    <AppShell allow={['SUPER_ADMIN']}>
      <CarriersContent />
    </AppShell>
  );
}
