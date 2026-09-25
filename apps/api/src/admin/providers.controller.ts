import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { NumberStatus, Prisma, prisma, ProviderStatus, ProviderType, Role, type Provider } from '@viaroute/db';
import { CurrentUser, Roles } from '../common/decorators';
import type { AuthUser } from '../common/types';
import { Trim } from '../common/validation';
import { randomBytes } from 'crypto';
import { config } from '../config';
import { MARKUP_TYPES, ProvidersService, type Credentials } from '../telephony/providers.service';

class CredentialsDto {
  @IsOptional() @IsString() @MaxLength(500)
  apiKey?: string;

  @IsOptional() @IsString() @MaxLength(500)
  publicKey?: string;

  @IsOptional() @IsString() @MaxLength(200)
  connectionId?: string;

  /** Telnyx: Credential Connection for agent softphones / SIP phones. */
  @IsOptional() @IsString() @MaxLength(200)
  sipConnectionId?: string;

  /** Twilio: API key for browser softphone tokens. */
  @IsOptional() @IsString() @MaxLength(100) apiKeySid?: string;
  @IsOptional() @IsString() @MaxLength(200) apiKeySecret?: string;

  /** Custom carriers */
  @IsOptional() @IsString() @MaxLength(300)
  baseUrl?: string;

  @IsOptional() @IsBoolean()
  numbersApi?: boolean;

  // Twilio / SignalWire / Plivo / Bandwidth / Vonage
  @IsOptional() @IsString() @MaxLength(100) accountSid?: string;
  @IsOptional() @IsString() @MaxLength(200) authToken?: string;
  @IsOptional() @IsString() @MaxLength(200) spaceUrl?: string;
  @IsOptional() @IsString() @MaxLength(100) projectId?: string;
  @IsOptional() @IsString() @MaxLength(200) apiToken?: string;
  @IsOptional() @IsString() @MaxLength(100) authId?: string;
  @IsOptional() @IsString() @MaxLength(100) appId?: string;
  @IsOptional() @IsString() @MaxLength(100) accountId?: string;
  @IsOptional() @IsString() @MaxLength(100) username?: string;
  @IsOptional() @IsString() @MaxLength(200) password?: string;
  @IsOptional() @IsString() @MaxLength(100) applicationId?: string;
  @IsOptional() @IsString() @MaxLength(200) apiSecret?: string;
  @IsOptional() @IsString() @MaxLength(8000) privateKey?: string;
}

/** What each carrier needs before it can be saved. */
const REQUIRED: Partial<Record<ProviderType, [keyof CredentialsDto, string][]>> = {
  TWILIO: [['accountSid', 'Account SID'], ['authToken', 'Auth Token']],
  SIGNALWIRE: [['spaceUrl', 'Space URL'], ['projectId', 'Project ID'], ['apiToken', 'API token']],
  PLIVO: [['authId', 'Auth ID'], ['authToken', 'Auth Token']],
  BANDWIDTH: [['accountId', 'Account ID'], ['username', 'API username'], ['password', 'API password'], ['applicationId', 'Voice application ID']],
  VONAGE: [['applicationId', 'Application ID'], ['privateKey', 'Private key']],
};
/** Settings safe to show again; everything else in credentials is secret. */
const PUBLIC_FIELDS = ['connectionId', 'sipConnectionId', 'apiKeySid', 'baseUrl', 'accountSid', 'spaceUrl', 'projectId', 'authId', 'appId', 'accountId', 'username', 'applicationId'] as const;

class ProviderDto {
  @Trim() @IsString() @MinLength(2) @MaxLength(60)
  name: string;

  @IsEnum(ProviderType)
  type: ProviderType;

  @IsOptional() @IsEnum(ProviderStatus)
  status?: ProviderStatus;

  /** Only the fields given are changed; empty strings are ignored (keep the stored value). */
  @IsOptional() @ValidateNested() @Type(() => CredentialsDto)
  credentials?: CredentialsDto;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(10)
  inboundPerMinute?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(10)
  outboundPerMinute?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1000)
  numberLocalMonthly?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1000)
  numberTollFreeMonthly?: number;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000)
  notes?: string | null;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;
}
class UpdateProviderDto extends PartialType(ProviderDto) {}

const LIVE: NumberStatus[] = [NumberStatus.ACTIVE, NumberStatus.PENDING];

/** Platform admin: carrier accounts, their costs, health and margin. */
@Roles(Role.SUPER_ADMIN)
@Controller('admin/providers')
export class ProvidersController {
  constructor(private providers: ProvidersService) {}

  @Get()
  async list() {
    const rows = await this.providers.all();
    const since = new Date(Date.now() - 30 * 86400_000);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const [numbers, customers, calls30, callsToday] = await Promise.all([
      prisma.phoneNumber.groupBy({ by: ['providerId'], where: { status: { in: LIVE } }, _count: { _all: true }, _sum: { monthlyPrice: true, carrierCost: true } }),
      prisma.tenant.groupBy({ by: ['providerId'], where: { providerId: { not: null } }, _count: { _all: true } }),
      prisma.call.groupBy({
        by: ['providerId'],
        where: { startedAt: { gte: since } },
        _count: { _all: true },
        _sum: { cost: true, carrierCost: true, durationSec: true, connectedSec: true },
      }),
      prisma.call.groupBy({ by: ['providerId'], where: { startedAt: { gte: today } }, _count: { _all: true } }),
    ]);
    const by = <T extends { providerId: string | null }>(list: T[], id: string) => list.find((x) => x.providerId === id);
    return rows.map((p) => {
      const n = by(numbers, p.id);
      const c = by(calls30, p.id);
      const usageIncome = Number(c?._sum.cost ?? 0);
      const usageCost = Number(c?._sum.carrierCost ?? 0);
      return {
        ...this.present(p),
        stats: {
          numbers: n?._count._all ?? 0,
          numbersIncome: Number(n?._sum.monthlyPrice ?? 0),
          numbersCost: Number(n?._sum.carrierCost ?? 0),
          customers: by(customers, p.id)?._count._all ?? 0,
          callsToday: by(callsToday, p.id)?._count._all ?? 0,
          calls30d: c?._count._all ?? 0,
          minutes30d: Math.round(((c?._sum.durationSec ?? 0) + (c?._sum.connectedSec ?? 0)) / 60),
          usageIncome30d: round(usageIncome),
          usageCost30d: round(usageCost),
          usageMargin30d: round(usageIncome - usageCost),
        },
      };
    });
  }

  @Post()
  async create(@Body() dto: ProviderDto, @CurrentUser() me: AuthUser) {
    if (dto.type === ProviderType.TELNYX && !dto.credentials?.apiKey?.trim()) throw new BadRequestException('A Telnyx carrier needs its API key');
    if (dto.type === ProviderType.CUSTOM) checkBaseUrl(dto.credentials?.baseUrl);
    for (const [field, label] of REQUIRED[dto.type] ?? []) {
      const v = dto.credentials?.[field];
      if (typeof v !== 'string' || !v.trim()) throw new BadRequestException(`${label} is required`);
    }
    const { credentials, isDefault, ...rest } = dto;
    // Custom carriers sign their webhooks with a secret we generate (shown once).
    const webhookSecret = dto.type === ProviderType.CUSTOM ? newSecret() : undefined;
    // Markup carriers are authenticated by a secret token in our webhook URLs.
    const webhookToken = MARKUP_TYPES.has(dto.type) ? newSecret().replace('whsec_', '') : undefined;
    const sealed = ProvidersService.seal({ ...credentials, ...(webhookSecret ? { webhookSecret } : {}), ...(webhookToken ? { webhookToken } : {}) } as Credentials);
    const p = await prisma.provider.create({ data: { ...rest, ...sealed } });
    if (isDefault) await this.makeDefault(p);
    await this.audit(me, 'provider.create', p, { name: p.name, type: p.type });
    this.providers.invalidate();
    return { ...this.present(p), ...(webhookSecret ? { webhookSecret } : {}) };
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProviderDto, @CurrentUser() me: AuthUser) {
    const p = await this.find(id);
    if (dto.type && dto.type !== p.type) throw new BadRequestException("A carrier's type can't be changed; add a new carrier instead");
    if (p.isDefault && dto.status && dto.status !== ProviderStatus.ACTIVE) throw new BadRequestException('Make another carrier the default before turning this one off');
    const { credentials, isDefault, type: _type, ...rest } = dto;
    let sealed = {};
    if (credentials && Object.values(credentials).some((v) => typeof v === 'boolean' || v?.trim())) {
      if (credentials.baseUrl?.trim()) checkBaseUrl(credentials.baseUrl);
      const merged: Record<string, unknown> = { ...this.providers.credentials(p) };
      for (const [k, v] of Object.entries(credentials)) {
        if (typeof v === 'boolean') merged[k] = v;
        else if (v?.trim()) merged[k] = v.trim();
      }
      sealed = ProvidersService.seal(merged as Credentials);
    }
    const updated = await prisma.provider.update({ where: { id }, data: { ...rest, ...sealed } });
    if (isDefault) await this.makeDefault(updated);
    await this.audit(me, 'provider.update', updated, { ...rest, credentialsChanged: Object.keys(sealed).length > 0 });
    this.providers.invalidate();
    return this.present(await this.find(id));
  }

  /** Checks the stored credentials against the carrier. */
  @HttpCode(200)
  @Post(':id/test')
  async test(@Param('id', ParseUUIDPipe) id: string) {
    const p = await this.find(id);
    try {
      const message = await this.providers.numbersApi(p).testConnection();
      await prisma.provider.update({ where: { id }, data: { lastError: null, lastErrorAt: null } });
      this.providers.invalidate();
      return { ok: true, message };
    } catch (e) {
      const message = (e as Error).message;
      await this.providers.markError(p, `Connection test: ${message}`);
      return { ok: false, message };
    }
  }

  /** New webhook signing secret for a Custom carrier (shown once; the old one stops working). */
  @HttpCode(200)
  @Post(':id/rotate-secret')
  async rotateSecret(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser) {
    const p = await this.find(id);
    if (MARKUP_TYPES.has(p.type)) {
      // New secret token in our webhook URLs: the carrier must be updated with the new URLs.
      const updated = await prisma.provider.update({ where: { id }, data: ProvidersService.seal({ ...this.providers.credentials(p), webhookToken: newSecret().replace('whsec_', '') }) });
      await this.audit(me, 'provider.rotate_secret', p, {});
      this.providers.invalidate();
      const urls = this.providers.markupUrls(updated);
      return { answerUrl: urls.answer(), statusUrl: urls.status() };
    }
    if (p.type !== ProviderType.CUSTOM) throw new BadRequestException('This carrier has no webhook secret to rotate');
    const webhookSecret = newSecret();
    await prisma.provider.update({ where: { id }, data: ProvidersService.seal({ ...this.providers.credentials(p), webhookSecret }) });
    await this.audit(me, 'provider.rotate_secret', p, {});
    this.providers.invalidate();
    return { webhookSecret };
  }

  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser) {
    const p = await this.find(id);
    if (p.isDefault) throw new BadRequestException("The default carrier can't be deleted");
    const numbers = await prisma.phoneNumber.count({ where: { providerId: id, status: { in: LIVE } } });
    if (numbers) throw new BadRequestException(`${numbers} number(s) still live on this carrier. Release or port them first, or set it to Draining.`);
    await prisma.provider.delete({ where: { id } });
    await this.audit(me, 'provider.delete', p, { name: p.name });
    this.providers.invalidate();
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------

  private async makeDefault(p: Provider) {
    if (p.status !== ProviderStatus.ACTIVE) throw new BadRequestException('Only an active carrier can be the default');
    await prisma.$transaction([
      prisma.provider.updateMany({ where: { id: { not: p.id } }, data: { isDefault: false } }),
      prisma.provider.update({ where: { id: p.id }, data: { isDefault: true } }),
    ]);
  }

  private async find(id: string) {
    const p = await prisma.provider.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Carrier not found');
    return p;
  }

  /** Never returns the secrets themselves. */
  private present(p: Provider) {
    const { credentials: _secret, ...rest } = p;
    const creds = this.providers.credentials(p);
    return {
      ...rest,
      hasApiKey: !!creds.apiKey,
      hasPublicKey: !!creds.publicKey,
      connectionId: creds.connectionId ?? null,
      baseUrl: creds.baseUrl ?? null,
      numbersApi: !!creds.numbersApi,
      hasWebhookSecret: !!creds.webhookSecret,
      webhookUrl:
        p.type === ProviderType.TELNYX ? `${config.apiOrigin}/webhooks/telnyx/${p.id}`
        : p.type === ProviderType.CUSTOM ? `${config.apiOrigin}/webhooks/carrier/${p.id}`
        : MARKUP_TYPES.has(p.type) ? this.providers.markupUrls(p).answer()
        : null,
      statusUrl: MARKUP_TYPES.has(p.type) ? this.providers.markupUrls(p).status() : null,
      settings: Object.fromEntries(PUBLIC_FIELDS.filter((k) => creds[k]).map((k) => [k, creds[k]])),
      secretsSet: Object.keys(creds).filter((k) => !(PUBLIC_FIELDS as readonly string[]).includes(k) && creds[k as keyof Credentials] && typeof creds[k as keyof Credentials] === 'string'),
    };
  }

  private audit(me: AuthUser, action: string, p: Provider, meta: Record<string, unknown>) {
    return prisma.auditLog.create({ data: { userId: me.sub, action, entity: 'Provider', entityId: p.id, meta: meta as Prisma.InputJsonObject } });
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

function checkBaseUrl(url?: string) {
  let u: URL;
  try {
    u = new URL(url ?? '');
  } catch {
    throw new BadRequestException('A Custom API carrier needs its API base URL, like https://switch.example.com/viaroute/v1');
  }
  if (u.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new BadRequestException('The carrier API must use https://');
}
