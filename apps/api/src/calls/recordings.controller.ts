import { Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Role, tenantDb, type Tenant } from '@viaroute/db';
import { CurrentTenant, CurrentUser, Roles } from '../common/decorators';
import { StorageService } from '../common/storage.service';
import type { AuthUser } from '../common/types';
import { RecordingsService } from '../routing/recordings.service';
import { CallFilterDto, filterWhere } from './calls.controller';

class RecordingListDto extends CallFilterDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize = 25;
}

const LINK_TTL = 60 * 60;

/** A file name like "call-2026-09-25-1403-+13055550100.mp3". */
function fileName(startedAt: Date, caller: string, key: string) {
  const ext = key.endsWith('.wav') ? 'wav' : 'mp3';
  const stamp = startedAt.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  return `call-${stamp}-${caller.replace(/[^\d+]/g, '') || 'unknown'}.${ext}`;
}

/** Recordings library. Staff see every recording; buyers and agents only their own calls'. */
@Roles(Role.TENANT_ADMIN, Role.MANAGER, Role.BUYER, Role.AGENT)
@Controller('recordings')
export class RecordingsController {
  constructor(private storage: StorageService, private recordings: RecordingsService) {}

  @Get()
  async list(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthUser, @Query() q: RecordingListDto) {
    const db = tenantDb(tenant.id);
    const where = { ...filterWhere({ ...q, recorded: 'true' }, user) };
    const [rows, total, size] = await Promise.all([
      db.call.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true, startedAt: true, callerNumber: true, callerState: true, connectedSec: true, durationSec: true, converted: true, recordingUrl: true, recordingSize: true, ivrPath: true,
          campaign: { select: { name: true } },
          buyer: { select: { name: true } },
          target: { select: { name: true } },
        },
      }),
      db.call.count({ where }),
      db.call.aggregate({ where: { recordingUrl: { not: null } }, _sum: { recordingSize: true }, _count: { _all: true } }),
    ]);
    const staff = user.role === Role.TENANT_ADMIN || user.role === Role.MANAGER;
    return {
      items: rows.map(({ recordingUrl, ...c }) => ({
        ...c,
        buyer: user.role === Role.AGENT ? null : c.buyer,
        playUrl: this.storage.signedPath(recordingUrl!, LINK_TTL),
        downloadUrl: this.storage.signedPath(recordingUrl!, LINK_TTL, fileName(c.startedAt, c.callerNumber, recordingUrl!)),
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
      // Account-wide storage is for staff only.
      ...(staff ? { storage: { recordings: size._count._all, bytes: size._sum.recordingSize ?? 0, retentionDays: tenant.recordingRetentionDays } } : {}),
    };
  }

  /** Deletes a recording for good (e.g. a privacy request). Admins only; logged. */
  @Roles(Role.TENANT_ADMIN)
  @Delete(':callId')
  async remove(@CurrentTenant() tenant: Tenant, @CurrentUser() me: AuthUser, @Param('callId', ParseUUIDPipe) callId: string) {
    const db = tenantDb(tenant.id);
    const call = await db.call.findUnique({ where: { id: callId }, select: { id: true, callerNumber: true, recordingUrl: true } });
    if (!call?.recordingUrl) throw new NotFoundException('No recording for this call');
    await this.recordings.remove(callId);
    await db.auditLog.create({ data: { tenantId: tenant.id, userId: me.sub, action: 'recording.delete', entity: 'Call', entityId: callId, meta: { caller: call.callerNumber } } });
    return { ok: true };
  }
}
