import { Injectable } from '@nestjs/common';
import { prisma } from '@viaroute/db';
import { decrypt, encrypt } from './crypto';

const CACHE_MS = 30_000;

/** Platform settings edited in the admin panel (key/value; secrets encrypted at rest). */
@Injectable()
export class SettingsService {
  private cache = new Map<string, { at: number; value: string | null }>();

  async get(key: string): Promise<string | null> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    const value = row?.value ?? null;
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async getSecret(key: string): Promise<string | null> {
    const v = await this.get(key);
    if (!v) return null;
    try {
      return decrypt(v);
    } catch {
      return null;
    }
  }

  /** null removes the setting. */
  async set(key: string, value: string | null, secret = false) {
    if (value === null) await prisma.platformSetting.deleteMany({ where: { key } });
    else {
      const stored = secret ? encrypt(value) : value;
      await prisma.platformSetting.upsert({ where: { key }, create: { key, value: stored }, update: { value: stored } });
    }
    this.cache.delete(key);
  }
}
