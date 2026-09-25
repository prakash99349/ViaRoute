import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { prisma, Role } from '@viaroute/db';
import { brandOf } from '../auth/auth.service';
import { REDIS } from '../common/redis.module';
import { portalOrigin } from '../config';
import { MailService } from '../mail/mail.service';

export interface NotifyInput {
  type: string;
  title: string;
  body?: string;
  /** Portal path, e.g. /billing */
  link?: string;
  /** Also email the tenant's admins. */
  email?: boolean;
  /** Skip if the same key was already sent within dedupeSec. */
  dedupeKey?: string;
  dedupeSec?: number;
}

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(private mail: MailService, @Inject(REDIS) private redis: Redis) {}

  async notify(tenantId: string, n: NotifyInput) {
    if (n.dedupeKey) {
      const fresh = await this.redis.set(`notif:${tenantId}:${n.dedupeKey}`, '1', 'EX', n.dedupeSec ?? 86400, 'NX');
      if (!fresh) return;
    }
    await prisma.notification.create({
      data: { tenantId, type: n.type, title: n.title, body: n.body, link: n.link },
    });
    if (n.email) await this.emailAdmins(tenantId, n).catch((e) => this.log.error(`Notification email failed: ${e.message}`));
  }

  /** Sends the low-balance alert once each time the wallet drops under the tenant's threshold. */
  async checkLowBalance(tenantId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t || t.lowBalanceNotifiedAt || t.walletBalance.gte(t.lowBalanceThreshold)) return;
    const claimed = await prisma.tenant.updateMany({
      where: { id: tenantId, lowBalanceNotifiedAt: null },
      data: { lowBalanceNotifiedAt: new Date() },
    });
    if (!claimed.count) return;

    const empty = t.walletBalance.lte(0);
    await this.notify(tenantId, {
      type: 'low_balance',
      title: empty ? 'Your wallet is empty — calls are paused' : 'Your wallet balance is low',
      body: empty
        ? 'New calls are being rejected until you add funds.'
        : `Your balance is $${t.walletBalance.toFixed(2)}. Add funds to keep your calls running.`,
      link: '/billing',
      email: true,
    });
  }

  private async emailAdmins(tenantId: string, n: NotifyInput) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const admins = await prisma.user.findMany({
      where: { tenantId, role: Role.TENANT_ADMIN, passwordHash: { not: null } },
      select: { email: true },
    });
    const brand = brandOf(tenant);
    for (const a of admins) {
      await this.mail.sendAction({
        to: a.email,
        subject: `${brand.name}: ${n.title}`,
        brand,
        heading: n.title,
        body: n.body ?? '',
        buttonText: 'Open portal',
        url: `${portalOrigin(tenant)}${n.link ?? '/dashboard'}`,
      });
    }
  }
}
