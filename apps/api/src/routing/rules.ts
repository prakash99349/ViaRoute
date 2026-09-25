/**
 * Routing rules shared by the campaign editor (validation) and the call router (evaluation).
 */

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Day = (typeof DAYS)[number];

/** Open hours per weekday in the tenant's timezone, e.g. { mon: [["09:00","17:00"]] }. Missing day = closed. */
export type Schedule = Partial<Record<Day, [string, string][]>>;

export interface GeoRules {
  /** Only accept callers from these US states (2-letter). */
  allowStates?: string[];
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns an error message, or null when valid. */
export function validateSchedule(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'object' || Array.isArray(s)) return 'Schedule must be an object';
  for (const [day, ranges] of Object.entries(s)) {
    if (!DAYS.includes(day as Day)) return `Unknown day "${day}"`;
    if (!Array.isArray(ranges)) return `Hours for ${day} must be a list`;
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2 || !TIME.test(r[0]) || !TIME.test(r[1])) {
        return `Hours for ${day} must look like ["09:00","17:00"]`;
      }
      if (r[0] === r[1]) return `Hours for ${day}: start and end can't be the same`;
    }
  }
  return null;
}

export function validateGeoRules(g: unknown): string | null {
  if (g === null || g === undefined) return null;
  if (typeof g !== 'object' || Array.isArray(g)) return 'Geo rules must be an object';
  const states = (g as GeoRules).allowStates;
  if (states === undefined) return null;
  if (!Array.isArray(states) || !states.every((x) => typeof x === 'string' && US_STATES.has(x))) {
    return 'allowStates must be a list of US state codes like "CA"';
  }
  return null;
}

/** Local weekday + "HH:MM" for a moment in a timezone. */
export function localTime(at: Date, timeZone: string): { day: Day; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: get('weekday').toLowerCase().slice(0, 3) as Day, hhmm: `${get('hour')}:${get('minute')}` };
}

/** Is the route open right now? Supports overnight ranges like ["22:00","06:00"]. */
export function isOpen(schedule: Schedule | null | undefined, at: Date, timeZone: string): boolean {
  if (!schedule || Object.keys(schedule).length === 0) return true; // 24/7
  const { day, hhmm } = localTime(at, timeZone);
  const prev = DAYS[(DAYS.indexOf(day) + 6) % 7];

  for (const [start, end] of schedule[day] ?? []) {
    if (start < end ? hhmm >= start && hhmm < end : hhmm >= start) return true;
  }
  // An overnight range that started yesterday still covers the early hours today.
  for (const [start, end] of schedule[prev] ?? []) {
    if (start > end && hhmm < end) return true;
  }
  return false;
}

export function geoAllows(rules: GeoRules | null | undefined, callerState: string | null): boolean {
  if (!rules?.allowStates?.length) return true;
  return !!callerState && rules.allowStates.includes(callerState);
}

/** Orders candidates: lower priority number first; inside a priority, weighted random. */
export function orderByPriorityAndWeight<T extends { priority: number; weight: number }>(items: T[], rand = Math.random): T[] {
  const groups = new Map<number, T[]>();
  for (const it of items) groups.set(it.priority, [...(groups.get(it.priority) ?? []), it]);

  const out: T[] = [];
  for (const p of [...groups.keys()].sort((a, b) => a - b)) {
    const pool = [...groups.get(p)!];
    while (pool.length) {
      const total = pool.reduce((s, x) => s + Math.max(x.weight, 0), 0);
      let pick = 0;
      if (total > 0) {
        let r = rand() * total;
        pick = pool.findIndex((x) => (r -= Math.max(x.weight, 0)) < 0);
        if (pick < 0) pick = pool.length - 1;
      }
      out.push(pool.splice(pick, 1)[0]);
    }
  }
  return out;
}

export const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR',
]);
