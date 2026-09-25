import { Controller, Get } from '@nestjs/common';
import { prisma } from '@viaroute/db';
import { Public } from './common/decorators';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  async check() {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, time: new Date().toISOString() };
  }
}
