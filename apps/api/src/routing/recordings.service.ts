import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { prisma } from '@viaroute/db';
import { REDIS } from '../common/redis.module';
import { StorageService } from '../common/storage.service';

const PURGE_EVERY_MS = 60 * 60_000;
const BATCH = 500;

/** Call recordings: deleting on request, and deleting old ones by each account's retention setting. */
@Injectable()
export class RecordingsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RecordingsService.name);
  private timer?: NodeJS.Timeout;

  constructor(private storage: StorageService, @Inject(REDIS) private redis: Redis) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return; // tests call purgeExpired() directly
    this.timer = setInterval(() => void this.purgeExpired().catch((e) => this.log.error(e.message)), PURGE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Removes one call's recording (file and link). Returns false when there was none. */
  async remove(callId: string): Promise<boolean> {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { recordingUrl: true } });
    if (!call?.recordingUrl) return false;
    await this.storage.remove(call.recordingUrl);
    await prisma.call.update({ where: { id: callId }, data: { recordingUrl: null, recordingSize: null, recordingDeletedAt: new Date() } });
    return true;
  }

  /** Deletes recordings older than each account's retention. Safe to run from several servers. */
  async purgeExpired(now = new Date()): Promise<number> {
    const lock = await this.redis.set('lock:recordings:purge', '1', 'EX', 1800, 'NX');
    if (!lock) return 0;
    let removed = 0;
    try {
      const tenants = await prisma.tenant.findMany({ where: { recordingRetentionDays: { not: null } }, select: { id: true, recordingRetentionDays: true } });
      for (const t of tenants) {
        const before = new Date(now.getTime() - t.recordingRetentionDays! * 86400_000);
        for (;;) {
          const old = await prisma.call.findMany({
            where: { tenantId: t.id, recordingUrl: { not: null }, startedAt: { lt: before } },
            select: { id: true, recordingUrl: true },
            take: BATCH,
          });
          if (!old.length) break;
          for (const c of old) await this.storage.remove(c.recordingUrl!);
          await prisma.call.updateMany({ where: { id: { in: old.map((c) => c.id) } }, data: { recordingUrl: null, recordingSize: null, recordingDeletedAt: now } });
          removed += old.length;
          if (old.length < BATCH) break;
        }
      }
      if (removed) this.log.log(`Deleted ${removed} recording(s) past their retention`);
      return removed;
    } finally {
      await this.redis.del('lock:recordings:purge');
    }
  }
}
