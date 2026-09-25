'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth';

/**
 * A date range as the user picked it: calendar dates + times in a timezone.
 * Presets ("Today", "Last 7 days"…) are recomputed on load, so "Today" always means today.
 */
export type PresetKey = 'today' | 'yesterday' | '3d' | '7d' | '14d' | '30d' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'lastYear' | 'all';

export interface DateRange {
  preset: PresetKey | 'custom';
  startDate: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endDate: string;
  endTime: string;
  tz: string;
}

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '3d', label: 'Last 3 days' },
  { key: '7d', label: 'Last 7 days' },
  { key: '14d', label: 'Last 14 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'thisYear', label: 'This year' },
  { key: 'lastYear', label: 'Last year' },
  { key: 'all', label: 'All time' },
];

export const ALL_TIME_START = '2000-01-01';

// ---------------------------------------------------------------------------
// Calendar-date helpers (pure strings, no timezone surprises)

export const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export function parseYmd(s: string) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

export function addDays(s: string, n: number) {
  const { y, m, d } = parseYmd(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function daysInMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Today's date in a timezone. */
export function todayIn(tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ---------------------------------------------------------------------------
// Timezone conversion

/** Offset of `tz` from UTC at instant `ts`, in ms. */
function offsetMs(ts: number, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ts))
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Wall-clock date + time in `tz` → the real instant. */
export function zonedToUtc(date: string, time: string, tz: string, endOfMinute = false) {
  const { y, m, d } = parseYmd(date);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, endOfMinute ? 59 : 0, endOfMinute ? 999 : 0);
  let ts = guess - offsetMs(guess, tz);
  const again = guess - offsetMs(ts, tz); // correct across DST changes
  if (again !== ts) ts = again;
  return new Date(ts);
}

// ---------------------------------------------------------------------------
// Presets & queries

export function presetDates(key: PresetKey, tz: string) {
  const t = todayIn(tz);
  const { y, m } = parseYmd(t);
  const span = (days: number) => [addDays(t, -(days - 1)), t];
  const [startDate, endDate] = (() => {
    switch (key) {
      case 'today': return [t, t];
      case 'yesterday': return [addDays(t, -1), addDays(t, -1)];
      case '3d': return span(3);
      case '7d': return span(7);
      case '14d': return span(14);
      case '30d': return span(30);
      case 'thisMonth': return [ymd(y, m, 1), t];
      case 'lastMonth': {
        const py = m === 1 ? y - 1 : y;
        const pm = m === 1 ? 12 : m - 1;
        return [ymd(py, pm, 1), ymd(py, pm, daysInMonth(py, pm))];
      }
      case 'thisYear': return [ymd(y, 1, 1), t];
      case 'lastYear': return [ymd(y - 1, 1, 1), ymd(y - 1, 12, 31)];
      case 'all': return [ALL_TIME_START, t];
    }
  })();
  return { startDate, endDate, startTime: '00:00', endTime: '23:59' };
}

export function makeRange(key: PresetKey, tz: string): DateRange {
  return { preset: key, tz, ...presetDates(key, tz) };
}

/** The instants to send to the API. The end minute is inclusive (23:59 → 23:59:59.999). */
export function rangeBounds(r: DateRange) {
  return { from: zonedToUtc(r.startDate, r.startTime, r.tz), to: zonedToUtc(r.endDate, r.endTime, r.tz, true) };
}

/** `from=…&to=…&tz=…` for API calls. */
export function rangeQuery(r: DateRange) {
  const { from, to } = rangeBounds(r);
  return `from=${from.toISOString()}&to=${to.toISOString()}&tz=${encodeURIComponent(r.tz)}`;
}

/** The same-length period just before (for "vs previous" comparisons). */
export function previousQuery(r: DateRange) {
  const { from, to } = rangeBounds(r);
  const len = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - len);
  return `from=${prevFrom.toISOString()}&to=${prevTo.toISOString()}&tz=${encodeURIComponent(r.tz)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(s: string, withYear = false) {
  const { y, m, d } = parseYmd(s);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

export function rangeLabel(r: DateRange) {
  const preset = PRESETS.find((p) => p.key === r.preset);
  if (preset) return preset.label;
  const sameYear = r.startDate.slice(0, 4) === r.endDate.slice(0, 4);
  const fullDay = r.startTime === '00:00' && r.endTime === '23:59';
  if (r.startDate === r.endDate) return fullDay ? shortDate(r.startDate, true) : `${shortDate(r.startDate)}, ${r.startTime}–${r.endTime}`;
  const a = `${shortDate(r.startDate, !sameYear)}${fullDay ? '' : ` ${r.startTime}`}`;
  const b = `${shortDate(r.endDate, true)}${fullDay ? '' : ` ${r.endTime}`}`;
  return `${a} – ${b}`;
}

/** How the comparison period reads ("yesterday", "previous 7 days"…). */
export function comparisonLabel(r: DateRange) {
  const map: Partial<Record<DateRange['preset'], string>> = {
    today: 'yesterday', yesterday: 'the day before', '3d': 'previous 3 days', '7d': 'previous 7 days', '14d': 'previous 14 days',
    '30d': 'previous 30 days', thisMonth: 'previous period', lastMonth: 'the month before', thisYear: 'previous period', lastYear: 'the year before',
  };
  return map[r.preset] ?? 'previous period';
}

export const isSingleDay = (r: DateRange) => r.startDate === r.endDate;

// ---------------------------------------------------------------------------
// Shared, remembered selection

const STORE_KEY = 'vr_range';

/**
 * The date range used across the app. The last choice is remembered for this browser tab,
 * so moving between Dashboard, Call logs and Reports keeps the same period.
 */
export function useDateRange(fallback: PresetKey = 'today') {
  const { portal, user } = useAuth();
  const defaultTz = user?.timezone ?? portal?.timezone ?? browserTimeZone();
  const [range, setRangeState] = useState<DateRange>(() => makeRange(fallback, defaultTz));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let next = makeRange(fallback, defaultTz);
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? 'null') as DateRange | null;
      if (saved?.tz) next = saved.preset === 'custom' ? saved : makeRange(saved.preset, saved.tz);
    } catch {
      /* no saved range */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the remembered range once the portal timezone is known
    setRangeState(next);
    setReady(true);
  }, [fallback, defaultTz]);

  const setRange = useCallback((r: DateRange) => {
    setRangeState(r);
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(r));
    } catch {
      /* private mode */
    }
  }, []);

  return { range, setRange, ready };
}
