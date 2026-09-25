import { BadRequestException, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { CallStatus, Prisma, Role, tenantDb, type Tenant } from '@viaroute/db';
import { SPAM_REASONS } from '../routing/spam.service';
import { CurrentTenant, CurrentUser, Roles } from '../common/decorators';
import { StorageService } from '../common/storage.service';
import type { AuthUser } from '../common/types';
import { IsTimeZone, orNotFound } from '../common/validation';
import { PostbackService } from '../routing/postback.service';

const ALL_ROLES = [Role.TENANT_ADMIN, Role.MANAGER, Role.PUBLISHER, Role.BUYER];
const STAFF: Role[] = [Role.TENANT_ADMIN, Role.MANAGER];
const CDR_LIMIT = 100_000;

export class CallFilterDto {
  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;

  @IsOptional() @IsUUID()
  campaignId?: string;

  @IsOptional() @IsUUID()
  publisherId?: string;

  @IsOptional() @IsUUID()
  buyerId?: string;

  @IsOptional() @IsUUID()
  targetId?: string;

  @IsOptional() @IsIn(Object.values(CallStatus))
  status?: CallStatus;

  @IsOptional() @IsIn(['true', 'false'])
  converted?: 'true' | 'false';

  @IsOptional() @IsIn(['true', 'false'])
  duplicate?: 'true' | 'false';

  /** "true": only calls stopped by spam protection or the blocklist. */
  @IsOptional() @IsIn(['true', 'false'])
  spam?: 'true' | 'false';

  @IsOptional() @IsIn(['true', 'false'])
  recorded?: 'true' | 'false';

  /** Caller's state, e.g. "CA". */
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value)) @Matches(/^[A-Z]{2}$/)
  state?: string;

  /** Tracking number (digits, partial match). */
  @IsOptional() @IsString() @MaxLength(20)
  number?: string;

  /** Minimum talk time with the buyer, seconds. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(86_400)
  minTalk?: number;

  /** Search by caller number. */
  @IsOptional() @IsString() @MaxLength(20)
  q?: string;

  /** Timezone used for times in exports and day/hour buckets in reports. */
  @IsOptional() @IsTimeZone()
  tz?: string;
}

class CallListDto extends CallFilterDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize?: number;

  @IsOptional() @IsIn(['newest', 'oldest', 'longest', 'revenue'])
  sort?: 'newest' | 'oldest' | 'longest' | 'revenue';
}

class ExportDto extends CallFilterDto {
  /** Comma-separated CDR column keys (see GET /calls/columns). */
  @IsOptional() @IsString() @MaxLength(2000)
  columns?: string;
}

/** Publishers only ever see their calls; buyers only calls sent to them. */
function scope(user: AuthUser): Prisma.CallWhereInput {
  if (user.role === Role.PUBLISHER) return { publisherId: user.publisherId ?? '00000000-0000-0000-0000-000000000000' };
  if (user.role === Role.BUYER) return { buyerId: user.buyerId ?? '00000000-0000-0000-0000-000000000000' };
  return {};
}

export function filterWhere(f: CallFilterDto, user: AuthUser): Prisma.CallWhereInput {
  const to = f.to ? new Date(f.to) : new Date();
  const from = f.from ? new Date(f.from) : new Date(to.getTime() - 7 * 86400_000);
  if (from > to) throw new BadRequestException('"from" must be before "to"');
  const digits = (s: string) => s.replace(/[^\d+]/g, '');
  return {
    ...scope(user),
    startedAt: { gte: from, lte: to },
    ...(f.campaignId ? { campaignId: f.campaignId } : {}),
    ...(f.publisherId && user.role !== Role.PUBLISHER ? { publisherId: f.publisherId } : {}),
    ...(f.buyerId && user.role !== Role.BUYER ? { buyerId: f.buyerId } : {}),
    ...(f.targetId && user.role !== Role.PUBLISHER ? { targetId: f.targetId } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.converted ? { converted: f.converted === 'true' } : {}),
    ...(f.duplicate ? { duplicate: f.duplicate === 'true' } : {}),
    ...(f.spam === 'true' ? { rejectReason: { in: [...SPAM_REASONS] } } : f.spam === 'false' ? { OR: [{ rejectReason: null }, { rejectReason: { notIn: [...SPAM_REASONS] } }] } : {}),
    ...(f.recorded ? { recordingUrl: f.recorded === 'true' ? { not: null } : null } : {}),
    ...(f.state ? { callerState: f.state } : {}),
    ...(f.number ? { dialedNumber: { contains: digits(f.number) } } : {}),
    ...(f.minTalk ? { connectedSec: { gte: f.minTalk } } : {}),
    ...(f.q ? { callerNumber: { contains: digits(f.q) } } : {}),
  };
}

const CALL_INCLUDE = {
  campaign: { select: { id: true, name: true, convertAfterSeconds: true } },
  publisher: { select: { id: true, name: true } },
  buyer: { select: { id: true, name: true } },
  target: { select: { id: true, name: true } },
  phoneNumber: { select: { label: true } },
} satisfies Prisma.CallInclude;

type CallRow = Prisma.CallGetPayload<{ include: typeof CALL_INCLUDE }>;

/** Hides the side of the money a partner shouldn't see. */
function present(c: CallRow, user: AuthUser) {
  const base = {
    id: c.id,
    startedAt: c.startedAt,
    answeredAt: c.answeredAt,
    endedAt: c.endedAt,
    callerNumber: c.callerNumber,
    callerState: c.callerState,
    dialedNumber: c.dialedNumber,
    numberLabel: c.phoneNumber?.label ?? null,
    attestation: c.attestation,
    spamScore: c.spamScore,
    lineType: c.lineType,
    status: c.status,
    rejectReason: c.rejectReason,
    duplicate: c.duplicate,
    attempts: c.attempts,
    durationSec: c.durationSec,
    connectedSec: c.connectedSec,
    converted: c.converted,
    hasRecording: !!c.recordingUrl,
    provider: c.provider,
    campaign: c.campaign,
    publisher: c.publisher,
    buyer: c.buyer,
    target: c.target,
  };
  if (user.role === Role.PUBLISHER) return { ...base, payout: c.payout, buyer: null, target: null };
  if (user.role === Role.BUYER) return { ...base, revenue: c.revenue, publisher: null };
  return { ...base, revenue: c.revenue, payout: c.payout, cost: c.cost, profit: c.revenue.sub(c.payout).sub(c.cost) };
}

// ---------------------------------------------------------------------------
// CDR columns

const REASONS: Record<string, string> = {
  no_buyer_available: 'No buyer available',
  sent_to_fallback: 'Sent to fallback',
  blocked_caller: 'Blocked caller',
  no_balance: 'Wallet empty',
  campaign_paused: 'Campaign paused',
  number_not_assigned: 'Number not on a campaign',
  account_suspended: 'Account suspended',
  account_limit: 'Account call limit',
  carrier_disabled: 'Carrier turned off',
  spam_global_block: 'Spam: platform blocklist',
  spam_anonymous: 'Spam: hidden caller ID',
  spam_prefix: 'Spam: blocked prefix',
  spam_rate_limit: 'Spam: too many calls',
  spam_attestation: 'Spam: caller ID not verified',
  spam_reputation: 'Spam: high spam score',
};

type Cell = string | number;
interface Column {
  key: string;
  label: string;
  /** Included when no columns are chosen. */
  default: boolean;
  /** Who may export it (default: everyone). */
  roles?: Role[];
  value: (c: CallRow, fmt: (d: Date | null) => string) => Cell;
}

const NOT_PUBLISHER: Role[] = [Role.TENANT_ADMIN, Role.MANAGER, Role.BUYER];
const NOT_BUYER: Role[] = [Role.TENANT_ADMIN, Role.MANAGER, Role.PUBLISHER];

export const CDR_COLUMNS: Column[] = [
  { key: 'call_id', label: 'Call ID', default: true, value: (c) => c.id },
  { key: 'started', label: 'Started', default: true, value: (c, f) => f(c.startedAt) },
  { key: 'answered', label: 'Answered by buyer', default: false, value: (c, f) => f(c.answeredAt) },
  { key: 'ended', label: 'Ended', default: false, value: (c, f) => f(c.endedAt) },
  { key: 'caller', label: 'Caller', default: true, value: (c) => c.callerNumber },
  { key: 'caller_state', label: 'Caller state', default: true, value: (c) => c.callerState ?? '' },
  { key: 'tracking_number', label: 'Tracking number', default: true, value: (c) => c.dialedNumber ?? '' },
  { key: 'number_label', label: 'Number label', default: false, value: (c) => c.phoneNumber?.label ?? '' },
  { key: 'campaign', label: 'Campaign', default: true, value: (c) => c.campaign?.name ?? '' },
  { key: 'publisher', label: 'Publisher', default: true, roles: NOT_BUYER, value: (c) => c.publisher?.name ?? '' },
  { key: 'buyer', label: 'Buyer', default: true, roles: NOT_PUBLISHER, value: (c) => c.buyer?.name ?? '' },
  { key: 'target', label: 'Target', default: true, roles: NOT_PUBLISHER, value: (c) => c.target?.name ?? '' },
  { key: 'status', label: 'Status', default: true, value: (c) => c.status },
  { key: 'outcome', label: 'Outcome', default: true, value: (c) => (c.rejectReason ? REASONS[c.rejectReason] ?? c.rejectReason : c.converted ? 'Converted' : '') },
  { key: 'hangup_cause', label: 'Hangup cause', default: false, value: (c) => c.hangupCause ?? '' },
  { key: 'buyers_tried', label: 'Buyers tried', default: false, value: (c) => c.attempts },
  { key: 'duration_sec', label: 'Call length (s)', default: true, value: (c) => c.durationSec },
  { key: 'talk_sec', label: 'Talk time (s)', default: true, value: (c) => c.connectedSec },
  { key: 'converted', label: 'Converted', default: true, value: (c) => (c.converted ? 'yes' : 'no') },
  { key: 'duplicate', label: 'Repeat caller', default: true, value: (c) => (c.duplicate ? 'yes' : 'no') },
  { key: 'recorded', label: 'Recorded', default: false, value: (c) => (c.recordingUrl ? 'yes' : 'no') },
  { key: 'revenue', label: 'Revenue', default: true, roles: NOT_PUBLISHER, value: (c) => c.revenue.toFixed(2) },
  { key: 'payout', label: 'Payout', default: true, roles: NOT_BUYER, value: (c) => c.payout.toFixed(2) },
  { key: 'cost', label: 'Usage cost', default: true, roles: STAFF, value: (c) => c.cost.toFixed(4) },
  { key: 'profit', label: 'Profit', default: true, roles: STAFF, value: (c) => c.revenue.sub(c.payout).sub(c.cost).toFixed(2) },
  { key: 'test_call', label: 'Test call', default: false, roles: STAFF, value: (c) => (c.provider === 'simulator' ? 'yes' : 'no') },
];

const columnsFor = (role: Role) => CDR_COLUMNS.filter((c) => !c.roles || c.roles.includes(role));

function dateFormatter(tz: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return (d: Date | null) => {
    if (!d) return '';
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  };
}

const ORDER: Record<NonNullable<CallListDto['sort']>, Prisma.CallOrderByWithRelationInput> = {
  newest: { startedAt: 'desc' },
  oldest: { startedAt: 'asc' },
  longest: { connectedSec: 'desc' },
  revenue: { revenue: 'desc' },
};

@Roles(...ALL_ROLES)
@Controller('calls')
export class CallsController {
  constructor(private storage: StorageService, private postbacks: PostbackService) {}

  @Get()
  async list(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthUser, @Query() f: CallListDto) {
    const db = tenantDb(tenant.id);
    const where = filterWhere(f, user);
    const pageSize = f.pageSize ?? 50;
    const page = f.page ?? 1;
    const [rows, total] = await Promise.all([
      db.call.findMany({ where, include: CALL_INCLUDE, orderBy: [ORDER[f.sort ?? 'newest'], { startedAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
      db.call.count({ where }),
    ]);
    return { items: rows.map((c) => present(c, user)), total, page, pageSize };
  }

  /** Every call happening right now. */
  @Get('live')
  async live(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthUser) {
    const rows = await tenantDb(tenant.id).call.findMany({
      where: { ...scope(user), status: { in: [CallStatus.RINGING, CallStatus.IN_PROGRESS] }, startedAt: { gte: new Date(Date.now() - 6 * 3600_000) } },
      include: CALL_INCLUDE,
      orderBy: { startedAt: 'desc' },
      take: 2000,
    });
    return rows.map((c) => present(c, user));
  }

  /** CDR columns this user may export. */
  @Get('columns')
  columns(@CurrentUser() user: AuthUser) {
    return columnsFor(user.role).map(({ key, label, default: d }) => ({ key, label, default: d }));
  }

  /** Call detail records (CDR) as CSV. */
  @Get('export.csv')
  async exportCsv(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthUser, @Query() f: ExportDto, @Res() res: Response) {
    const allowed = columnsFor(user.role);
    const wanted = f.columns?.split(',').map((s) => s.trim()).filter(Boolean);
    const cols = wanted?.length ? wanted.map((k) => allowed.find((c) => c.key === k)).filter((c): c is Column => !!c) : allowed.filter((c) => c.default);
    if (!cols.length) throw new BadRequestException('Choose at least one column');

    const where = filterWhere(f, user);
    const rows = await tenantDb(tenant.id).call.findMany({ where, include: CALL_INCLUDE, orderBy: { startedAt: 'desc' }, take: CDR_LIMIT });
    const tz = f.tz ?? user.timezone ?? tenant.timezone;
    const fmt = dateFormatter(tz);
    const header = cols.map((c) => (c.key === 'started' || c.key === 'answered' || c.key === 'ended' ? `${c.label} (${tz})` : c.label));
    const lines = rows.map((r) => cols.map((c) => c.value(r, fmt)));
    const csv = [header, ...lines].map((r) => r.map(csvCell).join(',')).join('\r\n');

    const range = where.startedAt as { gte: Date; lte: Date };
    const day = (d: Date) => fmt(d).slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cdr-${day(range.gte)}_to_${day(range.lte)}.csv"`);
    res.setHeader('X-Row-Count', String(rows.length));
    res.send('﻿' + csv); // BOM so Excel reads UTF-8
  }

  @Get(':id')
  async get(@CurrentTenant() tenant: Tenant, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const c = orNotFound(
      await tenantDb(tenant.id).call.findFirst({
        where: { id, ...scope(user) },
        include: { ...CALL_INCLUDE, postbacks: { orderBy: { createdAt: 'asc' } } },
      }),
      'Call',
    );
    return {
      ...present(c, user),
      hangupCause: c.hangupCause,
      recordingLink: c.recordingUrl ? this.storage.signedPath(c.recordingUrl) : null,
      postbacks: STAFF.includes(user.role) || user.role === Role.PUBLISHER ? c.postbacks : [],
    };
  }

  @Roles(...STAFF)
  @HttpCode(200)
  @Post(':id/block-caller')
  async blockCaller(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const db = tenantDb(tenant.id);
    const c = orNotFound(await db.call.findUnique({ where: { id } }), 'Call');
    await db.blockedNumber.upsert({
      where: { tenantId_e164: { tenantId: tenant.id, e164: c.callerNumber } },
      update: {},
      create: { tenantId: tenant.id, e164: c.callerNumber, reason: `Blocked from call ${c.id.slice(0, 8)}` },
    });
    return { ok: true };
  }

  @Roles(...STAFF)
  @HttpCode(200)
  @Post('postbacks/:postbackId/retry')
  async retryPostback(@CurrentTenant() tenant: Tenant, @Param('postbackId', ParseUUIDPipe) postbackId: string) {
    orNotFound(await tenantDb(tenant.id).postback.findUnique({ where: { id: postbackId } }), 'Postback');
    await this.postbacks.retry(postbackId);
    return { ok: true };
  }
}

export function csvCell(v: unknown) {
  const s = String(v ?? '');
  // Neutralise spreadsheet formulas (CSV injection) and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
