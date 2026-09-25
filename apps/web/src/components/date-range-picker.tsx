'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Globe } from 'lucide-react';
import {
  addDays, browserTimeZone, makeRange, pad, parseYmd, PRESETS, rangeLabel, todayIn, ymd,
  type DateRange, type PresetKey,
} from '@/lib/date-range';
import { Button } from './ui';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TIMES = [...Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`), '23:59'];
const COMMON_TZ = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'Europe/London',
  'Europe/Berlin', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Calcutta', 'Asia/Singapore', 'Australia/Sydney', 'UTC',
];

function allTimeZones(extra: string[]) {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch {
    list = COMMON_TZ;
  }
  return [...new Set([...extra, ...COMMON_TZ, ...list])];
}

/** One month grid. Days before/after the month are shown faded. */
function Month({ year, month, start, end, today, onPick }: { year: number; month: number; start: string; end: string; today: string; onPick: (d: string) => void }) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const cells = Array.from({ length: 42 }, (_, i) => addDays(ymd(year, month, 1), i - first));
  const lastRow = cells.slice(35).every((d) => parseYmd(d).m !== month);
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 text-center text-sm font-semibold">{MONTHS[month - 1]} {year}</div>
      <div className="grid grid-cols-7 text-center text-[11px] font-medium text-faint">
        {WEEKDAYS.map((w) => <div key={w} className="py-1.5">{w}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-[13px]" role="grid" aria-label={`${MONTHS[month - 1]} ${year}`}>
        {(lastRow ? cells.slice(0, 35) : cells).map((d) => {
          const inMonth = parseYmd(d).m === month;
          const inRange = d >= start && d <= end;
          const edge = d === start || d === end;
          const cls = edge
            ? 'bg-brand text-brand-contrast font-semibold rounded-md'
            : inRange
              ? 'bg-series-1/15 text-foreground'
              : inMonth
                ? 'hover:bg-subtle rounded-md'
                : 'text-faint/50 hover:bg-subtle rounded-md';
          return (
            <button
              type="button"
              key={d}
              onClick={() => onPick(d)}
              aria-pressed={edge}
              aria-label={d}
              className={`h-9 tabular ${cls} ${d === today && !edge ? 'font-semibold underline decoration-2 underline-offset-4' : ''}`}
            >
              {parseYmd(d).d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Date & time range picker with presets and timezone.
 * Changes are drafted inside the panel and only applied with "Apply".
 */
export function DateRangePicker({ value, onChange, align = 'right' }: { value: DateRange; onChange: (r: DateRange) => void; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [picking, setPicking] = useState(false); // waiting for the second click
  const [view, setView] = useState(() => parseYmd(value.endDate));
  const box = useRef<HTMLDivElement>(null);
  const today = todayIn(draft.tz);
  const zones = useMemo(() => allTimeZones([value.tz, browserTimeZone()]), [value.tz]);

  function openPanel() {
    setDraft(value);
    setPicking(false);
    // Show the month before the end date on the left, so both ends are usually visible.
    const e = parseYmd(value.endDate);
    const prev = e.m === 1 ? { y: e.y - 1, m: 12 } : { y: e.y, m: e.m - 1 };
    setView({ ...prev, d: 1 });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const shift = (months: number) =>
    setView((v) => {
      const t = new Date(Date.UTC(v.y, v.m - 1 + months, 1));
      return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: 1 };
    });

  function pick(d: string) {
    if (!picking) {
      setDraft((r) => ({ ...r, preset: 'custom', startDate: d, endDate: d }));
      setPicking(true);
    } else {
      setDraft((r) => (d < r.startDate ? { ...r, preset: 'custom', startDate: d } : { ...r, preset: 'custom', endDate: d }));
      setPicking(false);
    }
  }

  function preset(key: PresetKey) {
    const r = makeRange(key, draft.tz);
    setDraft(r);
    setPicking(false);
    const e = parseYmd(r.endDate);
    setView(e.m === 1 ? { y: e.y - 1, m: 12, d: 1 } : { y: e.y, m: e.m - 1, d: 1 });
  }

  function setTz(tz: string) {
    // Presets follow the new timezone's "today"; custom dates keep their wall-clock values.
    setDraft((r) => (r.preset === 'custom' ? { ...r, tz } : makeRange(r.preset, tz)));
  }

  const invalid = draft.startDate + draft.startTime > draft.endDate + draft.endTime;
  const next = view.m === 12 ? { y: view.y + 1, m: 1 } : { y: view.y, m: view.m + 1 };
  const inputCls = 'h-9 rounded-lg border border-border-strong bg-card px-2.5 text-[13px] outline-none focus:border-foreground/40';

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-9 max-w-full items-center gap-2 rounded-lg border border-border-strong bg-card px-3 text-[13px] font-medium hover:bg-subtle"
      >
        <CalendarDays size={16} strokeWidth={1.75} className="shrink-0 text-muted" aria-hidden />
        <span className="truncate">{rangeLabel(value)}</span>
        {value.tz !== browserTimeZone() && <span className="hidden text-xs font-normal text-faint md:inline">{value.tz.split('/').pop()?.replace('_', ' ')}</span>}
        <ChevronDown size={14} className="shrink-0 text-faint" aria-hidden />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose date range"
          className={`fixed inset-x-2 top-16 z-50 max-h-[calc(100vh-5rem)] overflow-y-auto rounded-2xl border border-border bg-card shadow-2xl sm:absolute sm:inset-x-auto sm:top-11 sm:w-[min(860px,calc(100vw-2rem))] ${
            align === 'right' ? 'sm:right-0' : 'sm:left-0'
          }`}
        >
          <div className="flex flex-col-reverse md:flex-row">
            {/* Calendar side */}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <span className="text-[13px] text-muted">Time</span>
                <input type="date" aria-label="Start date" value={draft.startDate} max="2100-12-31" onChange={(e) => e.target.value && setDraft({ ...draft, preset: 'custom', startDate: e.target.value })} className={inputCls} />
                <select aria-label="Start time" value={draft.startTime} onChange={(e) => setDraft({ ...draft, preset: 'custom', startTime: e.target.value })} className={inputCls}>
                  {TIMES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <span className="text-faint">–</span>
                <input type="date" aria-label="End date" value={draft.endDate} max="2100-12-31" onChange={(e) => e.target.value && setDraft({ ...draft, preset: 'custom', endDate: e.target.value })} className={inputCls} />
                <select aria-label="End time" value={draft.endTime} onChange={(e) => setDraft({ ...draft, preset: 'custom', endTime: e.target.value })} className={inputCls}>
                  {TIMES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div className="px-4 pb-4 pt-3">
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex gap-0.5">
                    <button type="button" aria-label="Previous year" onClick={() => shift(-12)} className="rounded-md p-1.5 text-muted hover:bg-subtle"><ChevronsLeft size={16} aria-hidden /></button>
                    <button type="button" aria-label="Previous month" onClick={() => shift(-1)} className="rounded-md p-1.5 text-muted hover:bg-subtle"><ChevronLeft size={16} aria-hidden /></button>
                  </div>
                  {picking && <span className="text-xs text-muted">Now pick the end date</span>}
                  <div className="flex gap-0.5">
                    <button type="button" aria-label="Next month" onClick={() => shift(1)} className="rounded-md p-1.5 text-muted hover:bg-subtle"><ChevronRight size={16} aria-hidden /></button>
                    <button type="button" aria-label="Next year" onClick={() => shift(12)} className="rounded-md p-1.5 text-muted hover:bg-subtle"><ChevronsRight size={16} aria-hidden /></button>
                  </div>
                </div>
                <div className="flex gap-6">
                  <Month year={view.y} month={view.m} start={draft.startDate} end={draft.endDate} today={today} onPick={pick} />
                  <div className="hidden flex-1 sm:block">
                    <Month year={next.y} month={next.m} start={draft.startDate} end={draft.endDate} today={today} onPick={pick} />
                  </div>
                </div>
              </div>
            </div>

            {/* Presets */}
            <div className="border-b border-border md:w-44 md:border-b-0 md:border-l">
              <div className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-visible">
                {PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.key}
                    onClick={() => preset(p.key)}
                    aria-pressed={draft.preset === p.key}
                    className={`shrink-0 rounded-lg px-3 py-2 text-left text-[13px] ${draft.preset === p.key ? 'bg-subtle font-semibold' : 'text-muted hover:bg-subtle/70 hover:text-foreground'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
            <label className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
              <Globe size={15} strokeWidth={1.75} aria-hidden />
              <span className="hidden sm:inline">Timezone</span>
              <select aria-label="Timezone" value={draft.tz} onChange={(e) => setTz(e.target.value)} className={`${inputCls} max-w-56 text-foreground`}>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </select>
            </label>
            {invalid && <span className="text-xs text-danger">Start must be before end</span>}
            <span className="flex-1" />
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={invalid}
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
