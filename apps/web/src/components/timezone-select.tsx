'use client';

import { useMemo, type ComponentProps } from 'react';
import { Select } from './ui';

export const COMMON_TZ = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
  'Pacific/Honolulu', 'Europe/London', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Calcutta', 'Asia/Singapore', 'Australia/Sydney', 'UTC',
];

/** Every timezone the browser knows, common ones first. */
export function allTimeZones(extra: (string | null | undefined)[] = []) {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch {
    list = [];
  }
  return [...new Set([...extra.filter((z): z is string => !!z), ...COMMON_TZ, ...list])];
}

function offsetLabel(tz: string) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part?.value.replace('GMT', 'UTC') ?? '';
  } catch {
    return '';
  }
}

/** Timezone dropdown with UTC offsets. `emptyLabel` adds a "use default" choice with value "". */
export function TimeZoneSelect({ emptyLabel, defaultValue, value, ...props }: ComponentProps<typeof Select> & { emptyLabel?: string }) {
  const current = String(value ?? defaultValue ?? '');
  const zones = useMemo(() => allTimeZones([current]), [current]);
  return (
    <Select defaultValue={defaultValue} value={value} {...props}>
      {emptyLabel && <option value="">{emptyLabel}</option>}
      {zones.map((z) => (
        <option key={z} value={z}>
          {z.replace(/_/g, ' ')} {offsetLabel(z) && `(${offsetLabel(z)})`}
        </option>
      ))}
    </Select>
  );
}
