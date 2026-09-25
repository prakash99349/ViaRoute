'use client';

import { useState } from 'react';
import { Field, Select, Toggle } from './ui';

export type DestinationType = 'PHONE' | 'SIP';

export interface Caps {
  concurrencyCap: number | null;
  hourlyCap: number | null;
  dailyCap: number | null;
  monthlyCap: number | null;
}

export interface CapUsage {
  live: number;
  hour: number;
  day: number;
  month: number;
}

const CAP_FIELDS = [
  { key: 'concurrencyCap', label: 'Concurrent calls', unit: 'at once', max: 1000 },
  { key: 'hourlyCap', label: 'Hourly cap', unit: 'per hour', max: 100_000 },
  { key: 'dailyCap', label: 'Daily cap', unit: 'per day', max: 1_000_000 },
  { key: 'monthlyCap', label: 'Monthly cap', unit: 'per month', max: 10_000_000 },
] as const;

/** Number or IP (SIP) destination. Submits `destinationType` and `destination`. */
export function DestinationFields({ type: initialType = 'PHONE', value, typeLabel = 'Type' }: { type?: DestinationType; value?: string; typeLabel?: string }) {
  const [type, setType] = useState<DestinationType>(initialType);
  return (
    <div className="grid gap-4 sm:grid-cols-[150px_1fr]">
      <Select label={typeLabel} name="destinationType" value={type} onChange={(e) => setType(e.target.value as DestinationType)}>
        <option value="PHONE">Number</option>
        <option value="SIP">IP (SIP)</option>
      </Select>
      <Field
        key={type}
        label={type === 'PHONE' ? 'Phone number' : 'IP address or SIP URI'}
        name="destination"
        defaultValue={type === initialType ? value : ''}
        required
        placeholder={type === 'PHONE' ? '+14155550123' : '203.0.113.10:5060'}
        hint={type === 'PHONE' ? 'International format with + and country code.' : 'An IP (optionally with :port), or sip:agent@203.0.113.10.'}
      />
    </div>
  );
}

/**
 * Concurrent / hourly / daily / monthly caps, each with an on/off switch.
 * Submits a number for each cap that is on; read them back with `capsFrom`.
 */
export function CapsFields({ initial, hint, lines = true }: { initial?: Partial<Caps>; hint?: string; lines?: boolean }) {
  const fields = lines ? CAP_FIELDS : CAP_FIELDS.filter((f) => f.key !== 'concurrencyCap');
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(CAP_FIELDS.map((f) => [f.key, initial?.[f.key] != null])));

  return (
    <fieldset className="space-y-2">
      <legend className="text-[13px] font-medium">Caps</legend>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className={`rounded-lg border p-3 transition ${on[f.key] ? 'border-border-strong bg-card' : 'border-border bg-subtle/40'}`}>
            <Toggle label={f.label} checked={on[f.key]} onChange={(v) => setOn((cur) => ({ ...cur, [f.key]: v }))} hint={on[f.key] ? undefined : 'Off — no limit'} />
            {on[f.key] && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  name={f.key}
                  aria-label={`${f.label} limit`}
                  min={1}
                  max={f.max}
                  required
                  defaultValue={initial?.[f.key] ?? ''}
                  placeholder="e.g. 50"
                  className="h-9 w-28 rounded-lg border border-border-strong bg-card px-3 text-sm outline-none focus:border-foreground/40"
                />
                <span className="text-xs text-muted">calls {f.unit}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/** The caps from a form using CapsFields: switched-off caps are null. */
export function capsFrom(f: FormData, lines = true): Caps {
  const num = (k: string) => {
    const v = String(f.get(k) ?? '').trim();
    return v === '' ? null : Number(v);
  };
  return { concurrencyCap: lines ? num('concurrencyCap') : null, hourlyCap: num('hourlyCap'), dailyCap: num('dailyCap'), monthlyCap: num('monthlyCap') };
}

/** Short text like "5 at once · 50/day", or "No caps". With usage: "2/5 at once · 31/50 today". */
export function describeCaps(c: Partial<Caps>, u?: CapUsage) {
  const parts = [
    c.concurrencyCap != null && (u ? `${u.live}/${c.concurrencyCap} at once` : `${c.concurrencyCap} at once`),
    c.hourlyCap != null && (u ? `${u.hour}/${c.hourlyCap} this hour` : `${c.hourlyCap}/hr`),
    c.dailyCap != null && (u ? `${u.day}/${c.dailyCap} today` : `${c.dailyCap}/day`),
    c.monthlyCap != null && (u ? `${u.month}/${c.monthlyCap} this month` : `${c.monthlyCap}/mo`),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No caps';
}

/** How full the tightest cap is, 0–1 (0 when there are no caps). */
export function capFill(c: Partial<Caps>, u?: CapUsage) {
  if (!u) return 0;
  const pairs: [number | null | undefined, number][] = [
    [c.concurrencyCap, u.live],
    [c.hourlyCap, u.hour],
    [c.dailyCap, u.day],
    [c.monthlyCap, u.month],
  ];
  return Math.max(0, ...pairs.filter(([cap]) => cap).map(([cap, used]) => used / cap!));
}
