import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { prisma } from '@viaroute/db';

const QUEUE = 'postbacks';

interface PostbackJob {
  postbackId: string;
}

/** Values a publisher can put in their postback URL, e.g. https://track.net/cb?id={call_id}&amount={payout} */
export const POSTBACK_MACROS = [
  'call_id', 'caller', 'duration', 'connected', 'payout', 'revenue', 'converted',
  'campaign', 'campaign_id', 'publisher', 'publisher_id', 'tracking_number',
] as const;

export function fillMacros(template: string, values: Partial<Record<(typeof POSTBACK_MACROS)[number], string | number>>) {
  return template.replace(/\{([a-z_]+)\}/g, (all, name: string) =>
    name in values ? encodeURIComponent(String(values[name as keyof typeof values])) : all,
  );
}

/**
 * Tells publishers about converted calls. Queued in Redis (BullMQ) so a slow or broken
 * publisher endpoint never delays call handling; retried 6 times over ~30 minutes.
 */
@Injectable()
export class PostbackService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PostbackService.name);
  private queue!: Queue<PostbackJob>;
  private worker!: Worker<PostbackJob>;

  onModuleInit() {
    const connection = { url: process.env.REDIS_URL ?? 'redis://localhost:6379' };
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(QUEUE, (job) => this.deliver(job), { connection, concurrency: 10 });
    this.worker.on('error', (e) => this.log.error(e.message));
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }

  async send(tenantId: string, callId: string, url: string) {
    const pb = await prisma.postback.create({ data: { tenantId, callId, url } });
    await this.queue.add('send', { postbackId: pb.id }, {
      attempts: 6,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  /** Re-sends one postback now (from the call details screen). */
  async retry(postbackId: string) {
    await this.queue.add('send', { postbackId }, { attempts: 1, removeOnComplete: true, removeOnFail: true });
  }

  private async deliver(job: Job<PostbackJob>) {
    const pb = await prisma.postback.findUnique({ where: { id: job.data.postbackId } });
    if (!pb || pb.succeededAt) return;

    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(pb.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      status = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).message;
    }

    await prisma.postback.update({
      where: { id: pb.id },
      data: {
        attempts: { increment: 1 },
        statusCode: status,
        lastError: error,
        succeededAt: error ? null : new Date(),
      },
    });
    if (error) throw new Error(error); // let BullMQ retry
  }
}
