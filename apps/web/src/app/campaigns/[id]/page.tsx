'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Success } from '@/components/auth-card';
import { AppShell } from '@/components/app-shell';
import { ArrowLeft, Briefcase, Clock, Crosshair, ShieldAlert, FlaskConical, Gauge, Hash, MapPin, Pencil, PhoneOutgoing, Plus, Route as RouteIcon, SlidersHorizontal, Target, Trash2, Unlink } from 'lucide-react';
import { Alert, Badge, Button, Card, CardHeader, Empty, Field, IconButton, Initials, Modal, Select, Spinner, Toggle, table } from '@/components/ui';
import { IvrBuilder, type IvrFlow } from '@/components/ivr-builder';
import { CapsFields, capsFrom } from '@/components/routing-fields';
import { api, duration, formatPhone, money } from '@/lib/api';
import { useAction, useApi } from '@/lib/use-api';

type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
const DAYS: Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL: Record<Day, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

interface Buyer {
  id: string;
  name: string;
  destination: string;
  destinationType?: 'PHONE' | 'SIP';
  active: boolean;
}

interface RouteTarget {
  id: string;
  name: string;
  destinationType: 'PHONE' | 'SIP';
  destination: string;
  active: boolean;
  buyer: { id: string; name: string } | null;
}

interface TargetOption {
  id: string;
  name: string;
  active: boolean;
  buyer: { name: string } | null;
}

interface Route {
  id: string;
  buyerId: string | null;
  buyer: Buyer | null;
  targetId: string | null;
  target: RouteTarget | null;
  priority: number;
  weight: number;
  hourlyCap: number | null;
  dailyCap: number | null;
  monthlyCap: number | null;
  concurrencyCap: number | null;
  schedule: Partial<Record<Day, [string, string][]>> | null;
  geoRules: { allowStates?: string[] } | null;
  revenueOverride: string | null;
  active: boolean;
}

interface NumberRow {
  id: string;
  e164: string;
  label: string | null;
  campaignId: string | null;
  publisherId: string | null;
  publisher?: { id: string; name: string } | null;
  status: string;
}

interface Campaign {
  id: string;
  name: string;
  active: boolean;
  convertAfterSeconds: number;
  payout: string;
  revenue: string;
  recordCalls: boolean;
  playRecordingNotice: boolean;
  recordingNotice: string | null;
  duplicateWindowSec: number;
  fallbackNumber: string | null;
  repeatRouting: 'DIFFERENT' | 'SAME' | 'NORMAL';
  blockAnonymous: boolean;
  callerRateLimit: number | null;
  callerRateWindowMin: number;
  blockedPrefixes: string[];
  minAttestation: 'A' | 'B' | null;
  maxSpamScore: number | null;
  autoBlockShortCalls: number | null;
  shortCallSec: number;
  ivr: IvrFlow | null;
  whisperText: string | null;
  routes: Route[];
  phoneNumbers: NumberRow[];
}

// ---------------------------------------------------------------------------

/** Spam protection rules, checked before any buyer is dialed. */
function SpamCard({ c, onSaved }: { c: Campaign; onSaved: () => void }) {
  const [anon, setAnon] = useState(c.blockAnonymous);
  const [rate, setRate] = useState(c.callerRateLimit !== null);
  const [score, setScore] = useState(c.maxSpamScore !== null);
  const [auto, setAuto] = useState(c.autoBlockShortCalls !== null);
  const { busy, error, notice, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const n = (k: string) => Number(f.get(k));
    const prefixes = String(f.get('prefixes') ?? '')
      .split(/[\s,;]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const ok = await run(
      () =>
        api(`/campaigns/${c.id}`, {
          method: 'PATCH',
          json: {
            blockAnonymous: anon,
            callerRateLimit: rate ? n('rateLimit') : null,
            ...(rate ? { callerRateWindowMin: n('rateWindow') } : {}),
            blockedPrefixes: prefixes,
            minAttestation: f.get('attestation') || null,
            maxSpamScore: score ? n('maxScore') : null,
            autoBlockShortCalls: auto ? n('autoCalls') : null,
            ...(auto ? { shortCallSec: n('autoSec') } : {}),
          },
        }),
      'Spam protection saved',
    );
    if (ok) onSaved();
  }

  const box = (on: boolean) => `rounded-lg border p-3 transition ${on ? 'border-border-strong' : 'border-border bg-subtle/40'}`;
  const num = 'h-9 w-20 rounded-lg border border-border-strong bg-card px-2.5 text-sm outline-none focus:border-foreground/40';

  return (
    <Card>
      <CardHeader icon={ShieldAlert} title="Spam protection" subtitle="Checked before any buyer is dialed. Blocked calls are rejected — never billed, never paid.">
        <Link href="/spam" className="text-[13px] font-medium text-accent">Blocked calls →</Link>
      </CardHeader>
      <form onSubmit={submit} className="mt-4 space-y-4">
        {error && <Alert>{error}</Alert>}
        {notice && <Success>{notice}</Success>}
        <div className="grid gap-3 lg:grid-cols-2">
          <div className={box(anon)}>
            <Toggle label="Block hidden caller IDs" checked={anon} onChange={setAnon} hint="Anonymous, private, restricted or impossible numbers." />
          </div>
          <div className={box(rate)}>
            <Toggle label="Limit calls per caller" checked={rate} onChange={setRate} hint={rate ? undefined : 'Off — a caller can call any number of times.'} />
            {rate && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                At most <input name="rateLimit" type="number" min={1} max={1000} required defaultValue={c.callerRateLimit ?? 3} aria-label="Calls" className={num} />
                calls per <input name="rateWindow" type="number" min={1} max={10080} required defaultValue={c.callerRateWindowMin} aria-label="Minutes" className={num} /> minutes
              </div>
            )}
          </div>
          <div className={box(auto)}>
            <Toggle label="Auto-block short-call spammers" checked={auto} onChange={setAuto} hint={auto ? undefined : 'Off — robo-dialers that hang up fast keep getting through.'} />
            {auto && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                Block after <input name="autoCalls" type="number" min={2} max={100} required defaultValue={c.autoBlockShortCalls ?? 3} aria-label="Short calls" className={num} />
                calls shorter than <input name="autoSec" type="number" min={1} max={120} required defaultValue={c.shortCallSec} aria-label="Seconds" className={num} /> sec in 24 h
              </div>
            )}
          </div>
          <div className={box(score)}>
            <Toggle label="Reject high spam scores" checked={score} onChange={setScore} hint={score ? undefined : 'Off — uses the platform\'s spam-score lookup when on.'} />
            {score && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                Reject when the score is <input name="maxScore" type="number" min={1} max={100} required defaultValue={c.maxSpamScore ?? 85} aria-label="Score" className={num} /> or higher (0–100)
              </div>
            )}
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Select label="Caller ID verification (STIR/SHAKEN)" name="attestation" defaultValue={c.minAttestation ?? ''} hint="Carriers grade how sure they are the caller ID is real. Strict settings also block some real callers.">
            <option value="">Don&apos;t check</option>
            <option value="B">Require grade A or B (known customer)</option>
            <option value="A">Require grade A only (fully verified)</option>
          </Select>
          <Field
            label="Blocked prefixes"
            name="prefixes"
            defaultValue={c.blockedPrefixes.join(', ')}
            placeholder="e.g. +1900, +234, +1702555"
            hint="Callers starting with these are rejected: area codes, countries or exchanges."
          />
        </div>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save spam protection'}</Button>
      </form>
    </Card>
  );
}

function SettingsCard({ c, onSaved }: { c: Campaign; onSaved: () => void }) {
  const [active, setActive] = useState(c.active);
  const [record, setRecord] = useState(c.recordCalls);
  const [sayNotice, setSayNotice] = useState(c.playRecordingNotice);
  const { busy, error, notice, run } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(
      () =>
        api(`/campaigns/${c.id}`, {
          method: 'PATCH',
          json: {
            name: f.get('name'),
            revenue: Number(f.get('revenue')),
            payout: Number(f.get('payout')),
            convertAfterSeconds: Number(f.get('convertAfterSeconds')),
            duplicateWindowSec: Math.round(Number(f.get('duplicateHours')) * 3600),
            fallbackNumber: f.get('fallbackNumber'),
            repeatRouting: f.get('repeatRouting'),
            recordCalls: record,
            playRecordingNotice: sayNotice,
            ...(record && sayNotice ? { recordingNotice: String(f.get('recordingNotice') ?? '').trim() || null } : {}),
            active,
          },
        }),
      'Campaign saved',
    );
    onSaved();
  }

  return (
    <Card>
      <CardHeader icon={SlidersHorizontal} title="Settings" subtitle="Money, conversion rule, recording and fallback" />
      <form onSubmit={submit} className="mt-4 space-y-4">
        {error && <Alert>{error}</Alert>}
        {notice && <Success>{notice}</Success>}
        <Field label="Name" name="name" defaultValue={c.name} required minLength={2} />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Revenue ($)" name="revenue" type="number" min={0} step="0.01" defaultValue={c.revenue} hint="Buyer pays per converted call" />
          <Field label="Payout ($)" name="payout" type="number" min={0} step="0.01" defaultValue={c.payout} hint="You pay the publisher" />
          <Field label="Converts after (sec)" name="convertAfterSeconds" type="number" min={0} max={3600} defaultValue={c.convertAfterSeconds} hint="Talk time with a buyer" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Repeat-caller window (hours)" name="duplicateHours" type="number" min={0} step="0.5" defaultValue={c.duplicateWindowSec / 3600} hint="Someone calling again within this time is a repeat caller. The publisher isn't paid again. 0 = off." />
          <Select label="Send repeat callers to" name="repeatRouting" defaultValue={c.repeatRouting} hint="A buyer only pays once per caller, so a different buyer can buy the repeat call.">
            <option value="DIFFERENT">A different buyer or target, if available</option>
            <option value="SAME">The same buyer or target as last time</option>
            <option value="NORMAL">Normal routing (ignore earlier calls)</option>
          </Select>
        </div>
        <Field label="Fallback number (optional)" name="fallbackNumber" defaultValue={c.fallbackNumber ?? ''} placeholder="+14155550123" hint="Gets calls no buyer can take (unpaid)." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle label="Campaign active" checked={active} onChange={setActive} hint="Paused campaigns reject calls." />
          <Toggle label="Record calls" checked={record} onChange={setRecord} hint="Both sides, from when the buyer answers. Listen in Recordings." />
        </div>
        {record && (
          <div className="space-y-3 rounded-xl border border-border p-4">
            <Toggle
              label="Say a recording notice first"
              checked={sayNotice}
              onChange={setSayNotice}
              hint={sayNotice ? undefined : 'Off: calls are recorded without telling the caller. Only allowed where one-party consent applies — not in CA, FL, IL, PA, WA and other all-party states.'}
            />
            {sayNotice && (
              <Field
                label="Notice"
                name="recordingNotice"
                defaultValue={c.recordingNotice ?? ''}
                maxLength={300}
                placeholder="This call may be recorded for quality assurance."
                hint="Leave empty for the standard notice."
              />
            )}
          </div>
        )}
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function describeHours(s: Route['schedule']) {
  if (!s || !Object.keys(s).length) return '24/7';
  const days = DAYS.filter((d) => s[d]?.length);
  const first = s[days[0]]?.[0];
  const same = days.every((d) => JSON.stringify(s[d]) === JSON.stringify(s[days[0]]));
  const dayText = days.length === 5 && days.join() === 'mon,tue,wed,thu,fri' ? 'Mon–Fri' : days.map((d) => DAY_LABEL[d]).join(', ');
  return same && first ? `${dayText} ${first[0]}–${first[1]}` : `${days.length} days (custom)`;
}

function describeCaps(r: Route) {
  const parts = [
    r.concurrencyCap && `${r.concurrencyCap} at once`,
    r.hourlyCap && `${r.hourlyCap}/hr`,
    r.dailyCap && `${r.dailyCap}/day`,
    r.monthlyCap && `${r.monthlyCap}/mo`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No caps';
}

/** A route rings a buyer's main line, or a target. */
const routeName = (r: Route) => r.target?.name ?? r.buyer?.name ?? 'Deleted';
const routeKey = (r: Pick<Route, 'buyerId' | 'targetId'>) => (r.targetId ? `t:${r.targetId}` : `b:${r.buyerId}`);
const routeLive = (r: Route) => r.active && (r.target ? r.target.active : true) && (r.buyer ? r.buyer.active : true);

function RouteWho({ r }: { r: Route }) {
  const dest = r.target ?? (r.buyer ? { destinationType: r.buyer.destinationType ?? 'PHONE', destination: r.buyer.destination } : null);
  return (
    <div className="flex items-center gap-3">
      {r.target ? (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-subtle text-muted"><Crosshair size={15} aria-hidden /></span>
      ) : (
        <Initials name={routeName(r)} />
      )}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 font-medium">
          {routeName(r)}
          {r.target && (r.target.buyer ? <span className="text-xs font-normal text-muted">{r.target.buyer.name}</span> : <Badge tone="blue">Direct</Badge>)}
          {!r.active && <Badge dot>Route paused</Badge>}
          {r.target && !r.target.active && <Badge dot>Target paused</Badge>}
          {r.buyer && !r.buyer.active && <Badge dot>Buyer paused</Badge>}
        </div>
        <div className="font-mono text-xs text-faint">
          {r.target ? 'Target · ' : 'Main line · '}
          {dest ? (dest.destinationType === 'PHONE' ? formatPhone(dest.destination) : dest.destination.replace(/^sips?:/, '')) : ''}
        </div>
      </div>
    </div>
  );
}

function RouteForm({ campaignId, route, buyers, targets, taken, onDone }: { campaignId: string; route?: Route; buyers: Buyer[]; targets: TargetOption[]; taken: string[]; onDone: () => void }) {
  const existingDays = route?.schedule ? DAYS.filter((d) => route.schedule![d]?.length) : [];
  const firstRange = route?.schedule && existingDays.length ? route.schedule[existingDays[0]]![0] : ['09:00', '17:00'];
  const [limited, setLimited] = useState(existingDays.length > 0);
  const [days, setDays] = useState<Day[]>(existingDays.length ? existingDays : ['mon', 'tue', 'wed', 'thu', 'fri']);
  const [active, setActive] = useState(route?.active ?? true);
  const { busy, error, run } = useAction();
  const freeBuyers = buyers.filter((b) => !taken.includes(`b:${b.id}`));
  const freeTargets = targets.filter((t) => !taken.includes(`t:${t.id}`));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (String(f.get(k) ?? '').trim() === '' ? null : Number(f.get(k)));
    const states = String(f.get('states') ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const from = String(f.get('from'));
    const to = String(f.get('to'));
    const json = {
      ...(route
        ? {}
        : String(f.get('sendTo')).startsWith('t:')
          ? { targetId: String(f.get('sendTo')).slice(2) }
          : { buyerId: String(f.get('sendTo')).slice(2) }),
      // Empty priority on a new route = the target's own priority (or 1).
      priority: num('priority') ?? (route ? 1 : undefined),
      weight: Number(f.get('weight')),
      revenueOverride: num('revenueOverride'),
      ...capsFrom(f),
      schedule: limited ? Object.fromEntries(days.map((d) => [d, [[from, to]]])) : null,
      geoRules: states.length ? { allowStates: states } : null,
      active,
    };
    const ok = await run(() =>
      route ? api(`/routes/${route.id}`, { method: 'PATCH', json }) : api(`/campaigns/${campaignId}/routes`, { method: 'POST', json }),
    );
    if (ok) onDone();
  }

  if (!route && freeBuyers.length + freeTargets.length === 0) {
    return (
      <Empty
        icon={Briefcase}
        title="Nothing to add"
        text="Every buyer and target is already on this campaign, or you haven't created any yet."
        action={
          <span className="flex gap-4 text-sm font-medium">
            <Link href="/buyers" className="text-accent">Go to Buyers →</Link>
            <Link href="/targets" className="text-accent">Go to Targets →</Link>
          </span>
        }
      />
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <Alert>{error}</Alert>}
      {route ? (
        <RouteWho r={route} />
      ) : (
        <Select label="Send calls to" name="sendTo" required defaultValue="" hint="A buyer's main line, or a target: one of a buyer's call centers, or a direct target with no buyer.">
          <option value="" disabled>Choose a buyer or target…</option>
          {freeBuyers.length > 0 && (
            <optgroup label="Buyers — main line">
              {freeBuyers.map((b) => (
                <option key={b.id} value={`b:${b.id}`}>{b.name}{b.active ? '' : ' (paused)'}</option>
              ))}
            </optgroup>
          )}
          {freeTargets.length > 0 && (
            <optgroup label="Targets">
              {freeTargets.map((t) => (
                <option key={t.id} value={`t:${t.id}`}>{t.name} — {t.buyer?.name ?? 'Direct'}{t.active ? '' : ' (paused)'}</option>
              ))}
            </optgroup>
          )}
        </Select>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Priority"
          name="priority"
          type="number"
          min={1}
          max={99}
          defaultValue={route?.priority ?? ''}
          placeholder={route ? undefined : "Target's own, or 1"}
          required={!!route}
          hint="1 is tried first"
        />
        <Field label="Weight" name="weight" type="number" min={0} max={1000} defaultValue={route?.weight ?? 100} hint="Share among equal priority" />
        <Field label="Revenue override ($)" name="revenueOverride" type="number" min={0} step="0.01" defaultValue={route?.revenueOverride ?? ''} hint="Empty = campaign revenue" />
      </div>

      <CapsFields initial={route} hint="Only for this campaign. The target's and buyer's own caps also apply." />

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Hours</legend>
        <Toggle label="Only during business hours" checked={limited} onChange={setLimited} hint="In your account's timezone. Off = 24/7." />
        {limited && (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d) => (
                <button
                  type="button"
                  key={d}
                  aria-pressed={days.includes(d)}
                  onClick={() => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${days.includes(d) ? 'bg-brand text-brand-contrast' : 'bg-foreground/5'}`}
                >
                  {DAY_LABEL[d]}
                </button>
              ))}
            </div>
            <div className="grid max-w-xs grid-cols-2 gap-3">
              <Field label="From" name="from" type="time" defaultValue={firstRange[0]} required />
              <Field label="To" name="to" type="time" defaultValue={firstRange[1]} required />
            </div>
          </div>
        )}
      </fieldset>

      <Field
        label="Only callers from these states (optional)"
        name="states"
        defaultValue={route?.geoRules?.allowStates?.join(', ') ?? ''}
        placeholder="e.g. CA, TX, FL"
        hint="Based on the caller's area code. Empty = all states."
      />
      <Toggle label="Route active" checked={active} onChange={setActive} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : route ? 'Save route' : 'Add to campaign'}</Button>
      </div>
    </form>
  );
}

function RoutesCard({ c, onChanged }: { c: Campaign; onChanged: () => void }) {
  const { data: buyers } = useApi<Buyer[]>('/buyers');
  const { data: targets } = useApi<TargetOption[]>('/targets');
  const [editing, setEditing] = useState<Route | 'new' | null>(null);
  const act = useAction();

  const remove = (r: Route) =>
    confirm(`Remove ${routeName(r)} from this campaign?`) && act.run(() => api(`/routes/${r.id}`, { method: 'DELETE' })).then(onChanged);

  return (
    <Card flush>
      <CardHeader
        icon={RouteIcon}
        title="Buyers, targets & routing"
        subtitle="Calls try priority 1 first; equal priorities share by weight. No answer → the next one."
        className="px-5 pt-5"
      >
        <Button icon={Plus} onClick={() => setEditing('new')}>Add buyer or target</Button>
      </CardHeader>
      {act.error && <div className="px-5 pt-4"><Alert>{act.error}</Alert></div>}
      <div className="mt-4 overflow-x-auto">
        {c.routes.length === 0 ? (
          <Empty icon={RouteIcon} title="Nowhere to send calls yet" text="Add a buyer or a target so calls have somewhere to go." />
        ) : (
          <table className={`${table.wrap} min-w-[860px]`}>
            <thead className={table.head}>
              <tr>
                <th>Priority</th>
                <th>Buyer / target</th>
                <th className="text-right">Weight</th>
                <th>Caps</th>
                <th>Hours</th>
                <th>States</th>
                <th className="text-right">Revenue</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {c.routes.map((r) => (
                <tr key={r.id} className={`${table.row} ${routeLive(r) ? '' : 'opacity-55'}`}>
                  <td>
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-subtle font-mono text-xs font-semibold">{r.priority}</span>
                  </td>
                  <td><RouteWho r={r} /></td>
                  <td className="text-right font-mono tabular">{r.weight}</td>
                  <td className="text-xs"><span className="inline-flex items-center gap-1.5 text-muted"><Gauge size={13} aria-hidden />{describeCaps(r)}</span></td>
                  <td className="text-xs"><span className="inline-flex items-center gap-1.5 text-muted"><Clock size={13} aria-hidden />{describeHours(r.schedule)}</span></td>
                  <td className="text-xs"><span className="inline-flex items-center gap-1.5 text-muted"><MapPin size={13} aria-hidden />{r.geoRules?.allowStates?.join(', ') || 'All states'}</span></td>
                  <td className="text-right font-mono tabular">{r.revenueOverride ? money(r.revenueOverride) : <span className="text-muted">{money(c.revenue)}</span>}</td>
                  <td className="whitespace-nowrap text-right">
                    <IconButton icon={Pencil} aria-label={`Edit routing for ${routeName(r)}`} onClick={() => setEditing(r)} className="h-8 w-8" />
                    <IconButton icon={Trash2} aria-label={`Remove ${routeName(r)}`} onClick={() => remove(r)} className="h-8 w-8 hover:text-danger" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <Modal wide title={editing === 'new' ? 'Add a buyer or target' : `Routing for ${routeName(editing)}`} onClose={() => setEditing(null)}>
          <RouteForm
            campaignId={c.id}
            route={editing === 'new' ? undefined : editing}
            buyers={buyers ?? []}
            targets={targets ?? []}
            taken={c.routes.map(routeKey)}
            onDone={() => {
              setEditing(null);
              onChanged();
            }}
          />
        </Modal>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function NumbersCard({ c, onChanged }: { c: Campaign; onChanged: () => void }) {
  const { data: allNumbers, reload } = useApi<NumberRow[]>('/numbers');
  const { data: publishers } = useApi<{ id: string; name: string }[]>('/publishers');
  const [assigning, setAssigning] = useState(false);
  const act = useAction();
  const free = allNumbers?.filter((n) => !n.campaignId) ?? [];

  const patch = (n: NumberRow, json: object) =>
    act.run(() => api(`/numbers/${n.id}`, { method: 'PATCH', json })).then(() => {
      onChanged();
      reload();
    });

  async function assign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const id = String(f.get('numberId'));
    const pub = String(f.get('publisherId') || '');
    await act.run(() => api(`/numbers/${id}`, { method: 'PATCH', json: { campaignId: c.id, publisherId: pub || null } }));
    setAssigning(false);
    onChanged();
    reload();
  }

  return (
    <Card flush>
      <CardHeader
        icon={Hash}
        title="Tracking numbers"
        subtitle="Calls to these numbers use this campaign. Set a publisher to know who sent each call."
        className="px-5 pt-5"
      >
        <Button icon={Plus} variant="secondary" onClick={() => setAssigning(true)}>Assign number</Button>
      </CardHeader>
      {act.error && <div className="px-5 pt-4"><Alert>{act.error}</Alert></div>}
      <div className="mt-4">
        {c.phoneNumbers.length === 0 ? (
          <Empty icon={Hash} title="No numbers assigned" text="Assign a tracking number so callers can reach this campaign." />
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {c.phoneNumbers.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-40 flex-1">
                  <div className="font-mono font-medium">{formatPhone(n.e164)}</div>
                  <div className="text-xs text-muted">{n.label ?? 'No label'}</div>
                </div>
                <div className="w-52">
                  <Select aria-label="Publisher" value={n.publisherId ?? ''} onChange={(e) => patch(n, { publisherId: e.target.value || null })}>
                    <option value="">No publisher</option>
                    {publishers?.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </div>
                <IconButton icon={Unlink} aria-label={`Unassign ${formatPhone(n.e164)}`} title="Unassign from campaign" onClick={() => patch(n, { campaignId: null, publisherId: null })} className="hover:text-danger" />
              </li>
            ))}
          </ul>
        )}
      </div>
      {assigning && (
        <Modal title="Assign a tracking number" onClose={() => setAssigning(false)}>
          {free.length === 0 ? (
            <Empty icon={Hash} title="No free numbers" text="All your numbers are on campaigns." action={<Link href="/numbers" className="text-sm font-medium text-accent">Buy a number →</Link>} />
          ) : (
            <form onSubmit={assign} className="space-y-4">
              <Select label="Number" name="numberId" required>
                {free.map((n) => (
                  <option key={n.id} value={n.id}>{formatPhone(n.e164)}{n.label ? ` — ${n.label}` : ''}</option>
                ))}
              </Select>
              <Select label="Publisher (optional)" name="publisherId" defaultValue="">
                <option value="">No publisher</option>
                {publishers?.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setAssigning(false)}>Cancel</Button>
                <Button type="submit" disabled={act.busy}>Assign</Button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface CallView {
  id: string;
  status: string;
  attempts: number;
  buyer: { name: string } | null;
  durationSec: number;
  connectedSec: number;
  converted: boolean;
  duplicate: boolean;
  rejectReason: string | null;
  revenue?: string;
  payout?: string;
  cost?: string;
  endedAt: string | null;
}

const SCENARIOS: Record<string, { label: string; outcomes: string[] }> = {
  answer: { label: 'First buyer answers', outcomes: [] },
  failover: { label: "First buyer doesn't answer → next", outcomes: ['no_answer'] },
  busy: { label: 'First two buyers busy → next', outcomes: ['busy', 'busy'] },
  nobody: { label: 'Nobody answers', outcomes: ['no_answer', 'no_answer', 'no_answer', 'no_answer', 'no_answer'] },
};

const REASONS: Record<string, string> = {
  no_buyer_available: 'No buyer could take the call',
  sent_to_fallback: 'Sent to fallback number',
  blocked_caller: 'Caller is blocked',
  no_balance: 'Wallet is empty',
  campaign_paused: 'Campaign is paused',
  number_not_assigned: 'Number has no campaign',
  account_suspended: 'Account suspended',
  account_limit: 'Account call limit reached',
  carrier_disabled: 'Carrier turned off',
  spam_global_block: 'Spam: known spammer',
  spam_anonymous: 'Spam: hidden caller ID',
  spam_prefix: 'Spam: blocked prefix',
  spam_rate_limit: 'Spam: called too often',
  spam_attestation: 'Spam: caller ID not verified',
  spam_reputation: 'Spam: high spam score',
};

function TestCallCard({ c }: { c: Campaign }) {
  const { data: sim } = useApi<{ enabled: boolean }>('/simulator');
  const [callId, setCallId] = useState<string | null>(null);
  const [call, setCall] = useState<CallView | null>(null);
  const act = useAction();

  useEffect(() => {
    if (!callId) return;
    let stop = false;
    const tick = async () => {
      const v = await api<CallView>(`/calls/${callId}`).catch(() => null);
      if (stop) return;
      if (v) setCall(v);
      if (!v?.endedAt || (v.status !== 'COMPLETED' && v.status !== 'NO_ANSWER' && v.status !== 'REJECTED')) setTimeout(tick, 400);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [callId]);

  if (!sim?.enabled || c.phoneNumbers.length === 0) return null;

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setCall(null);
    const res = await act.run(() =>
      api<{ callId: string }>('/simulator/calls', {
        method: 'POST',
        json: {
          to: f.get('to'),
          from: f.get('from'),
          outcomes: SCENARIOS[String(f.get('scenario'))].outcomes,
          talkSec: Number(f.get('talkSec')),
          stepMs: 500,
          digits: String(f.get('digits') ?? '').split(/[,\s]+/).filter(Boolean),
        },
      }),
    );
    if (res) setCallId(res.callId);
  }

  const done = call?.endedAt && ['COMPLETED', 'NO_ANSWER', 'REJECTED'].includes(call.status);

  return (
    <Card>
      <h2 className="flex items-center gap-2 text-[15px] font-semibold"><FlaskConical size={17} strokeWidth={1.75} className="text-faint" aria-hidden />Test call</h2>
      <p className="text-xs text-muted">Simulates a caller dialing your number and runs it through your real routing rules. Nobody&apos;s phone rings.</p>
      <form onSubmit={start} className={`mt-4 grid gap-3 sm:grid-cols-2 lg:items-end ${c.ivr?.enabled ? 'lg:grid-cols-6' : 'lg:grid-cols-5'}`}>
        <Select label="Tracking number" name="to">
          {c.phoneNumbers.map((n) => (
            <option key={n.id} value={n.e164}>{formatPhone(n.e164)}</option>
          ))}
        </Select>
        <Field label="Caller" name="from" defaultValue="+13055550123" pattern="\+[1-9][0-9]{7,14}" required />
        <Select label="What happens" name="scenario" defaultValue="answer">
          {Object.entries(SCENARIOS).map(([k, s]) => (
            <option key={k} value={k}>{s.label}</option>
          ))}
        </Select>
        <Field label="Talk time (sec)" name="talkSec" type="number" min={0} max={3600} defaultValue={120} />
        {c.ivr?.enabled && <Field label="Keys to press" name="digits" placeholder="e.g. 1, 33101" hint="One entry per menu, in order." pattern="[0-9*#, ]*" />}
        <Button type="submit" icon={PhoneOutgoing} disabled={act.busy || (!!callId && !done)}>Place test call</Button>
      </form>
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
      {call && (
        <div className="mt-4 rounded-lg border border-border p-4 text-sm" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <b>{done ? 'Call finished' : call.status === 'IN_PROGRESS' ? 'Connected — talking…' : `Ringing buyer ${call.attempts || ''}…`}</b>
            {call.buyer && <span className="text-muted">→ {call.buyer.name}</span>}
            {!done && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
          </div>
          {done && (
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-muted">
              <span>Status: <b className="text-foreground">{call.status}</b></span>
              {call.rejectReason && <span>{REASONS[call.rejectReason] ?? call.rejectReason}</span>}
              <span>Buyers tried: {call.attempts}</span>
              <span>Talk time: {duration(call.connectedSec)}</span>
              <span>Converted: {call.converted ? 'yes' : call.duplicate ? 'no (repeat caller)' : 'no'}</span>
              {call.revenue !== undefined && <span>Revenue {money(call.revenue)} · Payout {money(call.payout ?? 0)} · Usage {money(call.cost ?? 0)}</span>}
              <Link href="/calls" className="font-medium text-accent">See in call logs →</Link>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function CampaignContent() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: c, error, reload } = useApi<Campaign>(`/campaigns/${id}`);
  const act = useAction();

  if (error) return <Alert>{error}</Alert>;
  if (!c) return <Spinner />;

  const remove = async () => {
    if (!confirm(`Delete "${c.name}"? Its numbers are unassigned; call history is kept.`)) return;
    if (await act.run(() => api(`/campaigns/${c.id}`, { method: 'DELETE' }))) router.push('/campaigns');
  };

  return (
    <div className="w-full space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/campaigns" className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"><ArrowLeft size={13} aria-hidden />Campaigns</Link>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Target size={22} strokeWidth={1.75} className="text-faint" aria-hidden /> {c.name} {c.active ? <Badge tone="green" dot>Active</Badge> : <Badge dot>Paused</Badge>}
          </h1>
        </div>
        <Button variant="secondary" icon={Trash2} onClick={remove}>Delete campaign</Button>
      </div>
      {act.error && <Alert>{act.error}</Alert>}
      <TestCallCard c={c} />
      <RoutesCard c={c} onChanged={reload} />
      <IvrBuilder campaignId={c.id} initial={c.ivr} whisper={c.whisperText} routes={c.routes} onSaved={reload} />
      <NumbersCard c={c} onChanged={reload} />
      <SpamCard c={c} onSaved={reload} />
      <SettingsCard key={JSON.stringify([c.name, c.active, c.recordCalls, c.playRecordingNotice])} c={c} onSaved={reload} />
    </div>
  );
}

export default function CampaignPage() {
  return (
    <AppShell allow={['TENANT_ADMIN', 'MANAGER']}>
      <CampaignContent />
    </AppShell>
  );
}
