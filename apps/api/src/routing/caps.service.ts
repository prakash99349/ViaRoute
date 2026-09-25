import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../common/redis.module';

export interface CapLimits {
  concurrencyCap: number | null;
  hourlyCap: number | null;
  dailyCap: number | null;
  monthlyCap: number | null;
}

export type CapName = 'concurrency' | 'hourly' | 'daily' | 'monthly';
const CAP_NAMES: CapName[] = ['concurrency', 'hourly', 'daily', 'monthly'];

/**
 * Checks every limit and, only if all pass, counts the call in all of them, as one atomic step.
 * KEYS: concurrency, hour, day, month. ARGV: 4 limits (0 = none), then 3 TTLs.
 * Returns 0 on success, or the 1-based index of the first cap that is full.
 */
const RESERVE = `
for i = 1, 4 do
  local limit = tonumber(ARGV[i])
  if limit > 0 and tonumber(redis.call('GET', KEYS[i]) or '0') >= limit then return i end
end
for i = 1, 4 do redis.call('INCR', KEYS[i]) end
redis.call('EXPIRE', KEYS[1], 21600)
for i = 2, 4 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[i + 3])) end
return 0`;

/** Undo a reservation (buyer didn't answer). Never goes below zero. */
const RELEASE = `
for i = 1, #KEYS do
  if tonumber(redis.call('GET', KEYS[i]) or '0') > 0 then redis.call('DECR', KEYS[i]) end
end
return 0`;

@Injectable()
export class CapsService {
  constructor(@Inject(REDIS) private redis: Redis) {}

  /**
   * Returns null when reserved, or the name of the cap that is full.
   * `scope` is a route id, or "t:<targetId>" / "b:<buyerId>" for caps shared across campaigns.
   */
  async reserve(scope: string, limits: CapLimits, timeZone: string, at = new Date()): Promise<CapName | null> {
    const k = keys(scope, timeZone, at);
    const res = (await this.redis.eval(
      RESERVE, 4, k.concurrency, k.hour, k.day, k.month,
      limits.concurrencyCap ?? 0, limits.hourlyCap ?? 0, limits.dailyCap ?? 0, limits.monthlyCap ?? 0,
      2 * 3600, 2 * 86400, 32 * 86400,
    )) as number;
    return res === 0 ? null : CAP_NAMES[res - 1];
  }

  /** The buyer never answered: give back every counter. */
  async releaseAll(scope: string, timeZone: string, reservedAt: Date) {
    const k = keys(scope, timeZone, reservedAt);
    await this.redis.eval(RELEASE, 4, k.concurrency, k.hour, k.day, k.month);
  }

  /** The call ended: the buyer's line is free again (period counts stay). */
  async releaseConcurrency(scope: string) {
    await this.redis.eval(RELEASE, 1, `cap:${scope}:live`);
  }

  /** Current counts for many scopes at once (targets "t:<id>", buyers "b:<id>", or route ids). */
  async usageMany(scopes: string[], timeZone: string, at = new Date()) {
    const out = new Map<string, { live: number; hour: number; day: number; month: number }>();
    if (!scopes.length) return out;
    const all = scopes.map((sc) => keys(sc, timeZone, at));
    const vals = await this.redis.mget(...all.flatMap((k) => [k.concurrency, k.hour, k.day, k.month]));
    scopes.forEach((sc, i) => {
      const [live, hour, day, month] = vals.slice(i * 4, i * 4 + 4).map((v) => Number(v ?? 0));
      out.set(sc, { live, hour, day, month });
    });
    return out;
  }

  /** Current counts, for the campaign screen. */
  async usage(scope: string, timeZone: string, at = new Date()) {
    const k = keys(scope, timeZone, at);
    const [live, hour, day, month] = await this.redis.mget(k.concurrency, k.hour, k.day, k.month);
    return { live: Number(live ?? 0), hour: Number(hour ?? 0), day: Number(day ?? 0), month: Number(month ?? 0) };
  }
}

/** Period keys follow the tenant's clock, so "daily cap" resets at their midnight. */
function keys(scope: string, timeZone: string, at: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const month = `${p.year}${p.month}`;
  const day = `${month}${p.day}`;
  return {
    concurrency: `cap:${scope}:live`,
    hour: `cap:${scope}:h:${day}${p.hour}`,
    day: `cap:${scope}:d:${day}`,
    month: `cap:${scope}:m:${month}`,
  };
}
