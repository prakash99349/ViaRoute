import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { Prisma, prisma, Role } from '@viaroute/db';
import { CurrentUser, Roles } from '../common/decorators';
import { SettingsService } from '../common/settings.service';
import type { AuthUser } from '../common/types';
import { Trim, TrimOrNull } from '../common/validation';
import { IPQS_KEY, normalizeCaller, SPAM_REASONS, SpamService } from '../routing/spam.service';

class ReputationDto {
  /** IPQualityScore API key; null removes it. */
  @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  apiKey: string | null;
}

class LookupDto {
  @Trim() @IsString() @MaxLength(30)
  number: string;
}

class BlockDto {
  /** "+13055550100", or a prefix ending in * like "+1900*". */
  @Trim() @Matches(/^\+?[\d\s()-]{2,20}\*?$/, { message: 'Use a number like +13055550100, or a prefix ending in * like +1900*' })
  pattern: string;

  @IsOptional() @TrimOrNull() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200)
  reason?: string | null;
}

/** Platform admin: spam protection for every customer. */
@Roles(Role.SUPER_ADMIN)
@Controller('admin/spam')
export class AdminSpamController {
  constructor(private spam: SpamService, private settings: SettingsService) {}

  @Get()
  async overview() {
    const since = new Date(Date.now() - 30 * 86400_000);
    const where = { startedAt: { gte: since }, rejectReason: { in: [...SPAM_REASONS] } };
    const [key, blocks, byReason, topCallers, total] = await Promise.all([
      this.settings.getSecret(IPQS_KEY),
      prisma.globalBlock.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.call.groupBy({ by: ['rejectReason'], where, _count: { _all: true } }),
      prisma.call.groupBy({ by: ['callerNumber'], where, _count: { _all: true }, orderBy: { _count: { callerNumber: 'desc' } }, take: 15 }),
      prisma.call.count({ where: { startedAt: { gte: since } } }),
    ]);
    const envKey = process.env.IPQS_API_KEY;
    // Which customers the top offenders called (a caller hitting many customers is a strong spam signal).
    const spread = await prisma.call.groupBy({
      by: ['callerNumber', 'tenantId'],
      where: { ...where, callerNumber: { in: topCallers.map((t) => t.callerNumber) } },
    });
    const globalSet = new Set(blocks.map((b) => b.pattern));
    return {
      reputation: {
        provider: 'IPQualityScore',
        configured: !!(key ?? envKey),
        source: key ? 'admin' : envKey ? 'env' : null,
        keyHint: key ? `${key.slice(0, 3)}…${key.slice(-4)}` : null,
      },
      totalCalls30d: total,
      byReason: Object.fromEntries(byReason.map((r) => [r.rejectReason, r._count._all])),
      topCallers: topCallers.map((t) => ({
        callerNumber: t.callerNumber,
        calls: t._count._all,
        customers: spread.filter((s) => s.callerNumber === t.callerNumber).length,
        globallyBlocked: globalSet.has(t.callerNumber),
      })),
      blocks,
    };
  }

  @Put('reputation')
  async setReputation(@Body() dto: ReputationDto, @CurrentUser() me: AuthUser) {
    await this.settings.set(IPQS_KEY, dto.apiKey?.trim() || null, true);
    await prisma.auditLog.create({ data: { userId: me.sub, action: 'spam.reputation_key', meta: { set: !!dto.apiKey } } });
    return { configured: !!dto.apiKey };
  }

  /** Looks a number up now (not from cache) — to check the key works. */
  @HttpCode(200)
  @Post('lookup')
  async lookup(@Body() dto: LookupDto) {
    const caller = normalizeCaller(dto.number);
    if (!caller) throw new BadRequestException('Enter a valid phone number, like +13055550100');
    try {
      const rep = await this.spam.lookup(caller, true);
      if (!rep) throw new BadRequestException('Add an IPQualityScore API key first');
      return { number: caller, ...rep };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`Lookup failed: ${(e as Error).message}`);
    }
  }

  @Post('blocks')
  async addBlock(@Body() dto: BlockDto, @CurrentUser() me: AuthUser) {
    const prefix = dto.pattern.endsWith('*');
    const digits = dto.pattern.replace(/[^\d]/g, '');
    if (!prefix && !normalizeCaller(dto.pattern)) throw new BadRequestException('That is not a valid phone number; add * at the end to block a prefix');
    if (prefix && digits.length < 1) throw new BadRequestException('A prefix needs at least one digit');
    const pattern = `+${digits}${prefix ? '*' : ''}`;
    try {
      const b = await prisma.globalBlock.create({ data: { pattern, reason: dto.reason ?? null, createdBy: me.sub } });
      this.spam.invalidateGlobal();
      await prisma.auditLog.create({ data: { userId: me.sub, action: 'spam.global_block', meta: { pattern } } });
      return b;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Already blocked');
      throw e;
    }
  }

  @Delete('blocks/:id')
  async removeBlock(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser) {
    const b = await prisma.globalBlock.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Not found');
    await prisma.globalBlock.delete({ where: { id } });
    this.spam.invalidateGlobal();
    await prisma.auditLog.create({ data: { userId: me.sub, action: 'spam.global_unblock', meta: { pattern: b.pattern } } });
    return { ok: true };
  }
}
