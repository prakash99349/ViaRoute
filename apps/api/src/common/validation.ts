import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ValidateBy } from 'class-validator';
import { Transform } from 'class-transformer';

export const E164 = /^\+[1-9]\d{7,14}$/;
export const SIP_URI = /^sips?:([^@\s:;]+@)?([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:]+\])(:\d{1,5})?(;[^\s]*)?$/i;

/** Trims strings; turns "" into null so optional fields can be cleared. */
export const TrimOrNull = () =>
  Transform(({ value }) => (typeof value === 'string' ? (value.trim() === '' ? null : value.trim()) : value));

export const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export function assertValid(error: string | null) {
  if (error) throw new BadRequestException(error);
}

export function orNotFound<T>(row: T | null, what: string): T {
  if (!row) throw new NotFoundException(`${what} not found`);
  return row;
}

/** Any IANA timezone the runtime can use, old and new names alike (Asia/Calcutta and Asia/Kolkata). */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const IsTimeZone = () =>
  ValidateBy({
    name: 'isTimeZone',
    validator: { validate: (v) => isTimeZone(v), defaultMessage: () => 'Unknown timezone' },
  });
