import { Controller, Get, Global, HttpCode, Module, Post } from '@nestjs/common';
import { Role, tenantDb, type Tenant } from '@viaroute/db';
import { CurrentTenant, Roles } from '../common/decorators';
import { NotificationsService } from './notifications.service';

@Roles(Role.TENANT_ADMIN, Role.MANAGER)
@Controller('notifications')
class NotificationsController {
  @Get()
  async list(@CurrentTenant() tenant: Tenant) {
    const db = tenantDb(tenant.id);
    const [items, unread] = await Promise.all([
      db.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
      db.notification.count({ where: { readAt: null } }),
    ]);
    return { items, unread };
  }

  @HttpCode(200)
  @Post('read-all')
  async readAll(@CurrentTenant() tenant: Tenant) {
    await tenantDb(tenant.id).notification.updateMany({ where: { readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  }
}

@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
