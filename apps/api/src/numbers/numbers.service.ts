import {
  BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger,
  NotFoundException,
} from '@nestjs/common';
import Redis from 'ioredis';
import {
  NumberStatus, NumberType, Prisma, prisma, tenantDb, TransactionType, type PhoneNumber, type Tenant,
} from '@viaroute/db';
import { WalletService } from '../billing/wallet.service';
import { numberProviderName, ProvidersService } from '../telephony/providers.service';
import { REDIS } from '../common/redis.module';
import type { AuthUser } from '../common/types';
import { config } from '../config';
import {
  ProviderError, type AvailableNumber, type PurchaseResult,
} from '../telephony/telephony.types';

const SEARCH_TTL_SEC = 15 * 60;
const LIVE: NumberStatus[] = [NumberStatus.ACTIVE, NumberStatus.PENDING];

/** Monthly number prices for this customer: their custom deal, else the platform price. */
function pricesFor(tenant: Tenant): Record<NumberType, number> {
  return {
    LOCAL: tenant.numberPriceLocal !== null ? Number(tenant.numberPriceLocal) : config.numberPrice.LOCAL,
    TOLL_FREE: tenant.numberPriceTollFree !== null ? Number(tenant.numberPriceTollFree) : config.numberPrice.TOLL_FREE,
  };
}

export interface NumberOffer {
  e164: string;
  type: NumberType;
  locality?: string;
  region?: string;
  /** Monthly price for the customer. 0 when covered by their plan. */
  monthlyPrice: number;
  included: boolean;
}

@Injectable()
export class NumbersService {
  private readonly log = new Logger(NumbersService.name);

  constructor(
    private providers: ProvidersService,
    @Inject(REDIS) private redis: Redis,
    private wallet: WalletService,
  ) {}

  /** Prices, plan allowance and wallet, for the "Buy number" screen. */
  async overview(tenant: Tenant) {
    const carrier = await this.providers.forNewNumber(tenant);
    const [included, used, balance] = await Promise.all([
      this.includedAllowance(tenant),
      tenantDb(tenant.id).phoneNumber.count({ where: { status: { in: LIVE } } }),
      this.wallet.balance(tenant.id),
    ]);
    return {
      testMode: carrier.type === 'TEST',
      prices: pricesFor(tenant),
      maxNumbers: tenant.maxNumbers,
      includedNumbers: included,
      usedNumbers: used,
      walletBalance: balance,
    };
  }

  async search(tenant: Tenant, type: NumberType, areaCode?: string): Promise<NumberOffer[]> {
    const carrier = await this.providers.forNewNumber(tenant);
    let found: AvailableNumber[];
    try {
      found = await this.providers.numbersApi(carrier).searchNumbers({ country: 'US', type, areaCode, limit: 20 });
    } catch (e) {
      await this.providers.markError(carrier, `Number search: ${(e as Error).message}`);
      throw this.carrierError(e);
    }

    const price = pricesFor(tenant)[type];
    // Never sell a number that costs us more than we charge.
    const sellable = found.filter((n) => n.monthlyCost <= price && n.upfrontCost <= price);
    const included = await this.hasIncludedSlot(tenant);

    // Remember what we showed this customer, so a purchase can only be for a number (and cost) we quoted.
    if (sellable.length) {
      const pipe = this.redis.pipeline();
      for (const n of sellable) pipe.set(quoteKey(tenant.id, n.e164), JSON.stringify({ ...n, providerId: carrier.id }), 'EX', SEARCH_TTL_SEC);
      await pipe.exec();
    }

    return sellable.map((n) => ({
      e164: n.e164,
      type: n.type,
      locality: n.locality,
      region: n.region,
      monthlyPrice: included ? 0 : price,
      included,
    }));
  }

  async purchase(tenant: Tenant, user: AuthUser, e164: string, label?: string) {
    const me = await prisma.user.findUniqueOrThrow({ where: { id: user.sub }, select: { emailVerified: true } });
    if (!me.emailVerified) throw new ForbiddenException('Please confirm your email address before buying numbers');

    const quoted = await this.redis.get(quoteKey(tenant.id, e164));
    if (!quoted) throw new BadRequestException('This number is no longer reserved for you. Please search again.');
    const offer = JSON.parse(quoted) as AvailableNumber & { providerId?: string };
    const carrier = (await this.providers.byId(offer.providerId)) ?? (await this.providers.forNewNumber(tenant));

    if (tenant.maxNumbers !== null) {
      const owned = await tenantDb(tenant.id).phoneNumber.count({ where: { status: { in: LIVE } } });
      if (owned >= tenant.maxNumbers) throw new BadRequestException(`Your account can have up to ${tenant.maxNumbers} numbers. Contact support to raise the limit.`);
    }
    const included = await this.hasIncludedSlot(tenant);
    const listPrice = pricesFor(tenant)[offer.type];
    const price = new Prisma.Decimal(included ? 0 : listPrice);

    // 1) Claim the number and charge the first month together. The partial unique index on
    //    live numbers makes a second buyer fail here, before any money or carrier call.
    let number: PhoneNumber;
    try {
      number = await prisma.$transaction(async (tx) => {
        await this.wallet.debit(tenant.id, price, TransactionType.NUMBER_RENTAL, `Number ${e164} — first month`, tx);
        return tx.phoneNumber.create({
          data: {
            tenantId: tenant.id,
            e164,
            type: offer.type,
            label: label || null,
            status: NumberStatus.PENDING,
            provider: numberProviderName(carrier),
            providerId: carrier.id,
            monthlyPrice: included ? 0 : listPrice,
            carrierCost: offer.monthlyCost || this.providers.numberCost(carrier, offer.type),
          },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Sorry, this number was just taken. Please pick another.');
      }
      throw e;
    }
    await this.redis.del(quoteKey(tenant.id, e164));

    // 2) Order it from the carrier. On any failure, give the money back.
    let result: PurchaseResult;
    try {
      result = await this.providers.numbersApi(carrier).purchaseNumber(e164, `tenant:${tenant.id}`);
    } catch (e) {
      this.log.error(`Purchase of ${e164} for tenant ${tenant.id} failed: ${(e as Error).message}`);
      await this.providers.markError(carrier, `Number order ${e164}: ${(e as Error).message}`);
      result = { status: 'FAILED', failureReason: (e as Error).message };
    }

    const updated = await this.applyResult(number, result, price);
    await tenantDb(tenant.id).auditLog.create({
      data: { tenantId: tenant.id, userId: user.sub, action: 'number.purchase', entity: 'PhoneNumber', entityId: number.id, meta: { e164, status: updated.status } },
    });

    if (updated.status === NumberStatus.FAILED) {
      throw new BadGatewayException(`The carrier could not activate ${e164}. You have not been charged. Please try another number.`);
    }
    return toDto(updated);
  }

  async list(tenant: Tenant) {
    const db = tenantDb(tenant.id);
    let numbers = await db.phoneNumber.findMany({
      where: { status: { in: LIVE } },
      orderBy: { purchasedAt: 'desc' },
      include: { campaign: { select: { id: true, name: true } }, publisher: { select: { id: true, name: true } } },
    });

    // Lazily finish orders the carrier was still activating.
    const pending = numbers.filter((n) => n.status === NumberStatus.PENDING && n.providerOrderId);
    if (pending.length) {
      await Promise.all(pending.map((n) => this.refreshPending(n)));
      numbers = await db.phoneNumber.findMany({
        where: { status: { in: LIVE } },
        orderBy: { purchasedAt: 'desc' },
        include: { campaign: { select: { id: true, name: true } }, publisher: { select: { id: true, name: true } } },
      });
    }
    return numbers.map((n) => ({ ...toDto(n), campaign: n.campaign, publisher: n.publisher }));
  }

  async update(tenant: Tenant, id: string, data: { label?: string | null; campaignId?: string | null; publisherId?: string | null }) {
    const db = tenantDb(tenant.id);
    const number = await this.findLive(tenant, id);
    // Only allow linking to this tenant's own campaign/publisher.
    if (data.campaignId && !(await db.campaign.findUnique({ where: { id: data.campaignId } }))) {
      throw new BadRequestException('Campaign not found');
    }
    if (data.publisherId && !(await db.publisher.findUnique({ where: { id: data.publisherId } }))) {
      throw new BadRequestException('Publisher not found');
    }
    const updated = await db.phoneNumber.update({ where: { id: number.id }, data });
    return toDto(updated);
  }

  async release(tenant: Tenant, user: AuthUser, id: string) {
    const number = await this.findLive(tenant, id);
    if (number.status !== NumberStatus.ACTIVE) throw new BadRequestException('This number is still being activated. Try again in a few minutes.');

    try {
      await this.providers.numbersApi(await this.providers.byId(number.providerId)).releaseNumber(number.e164, number.providerNumberId);
    } catch (e) {
      throw this.carrierError(e);
    }
    const db = tenantDb(tenant.id);
    await db.phoneNumber.update({
      where: { id: number.id },
      data: { status: NumberStatus.RELEASED, releasedAt: new Date(), campaignId: null, publisherId: null },
    });
    await db.auditLog.create({
      data: { tenantId: tenant.id, userId: user.sub, action: 'number.release', entity: 'PhoneNumber', entityId: number.id, meta: { e164: number.e164 } },
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------

  private async refreshPending(n: PhoneNumber) {
    try {
      const result = await this.providers.numbersApi(await this.providers.byId(n.providerId)).checkOrder(n.providerOrderId!, n.e164);
      if (result.status !== 'PENDING') await this.applyResult(n, result, n.monthlyPrice);
    } catch (e) {
      this.log.warn(`Could not refresh order ${n.providerOrderId}: ${(e as Error).message}`);
    }
  }

  /** Saves the carrier's answer; refunds the first month if the order failed. */
  private async applyResult(number: PhoneNumber, result: PurchaseResult, charged: Prisma.Decimal.Value) {
    if (result.status === 'FAILED') {
      return prisma.$transaction(async (tx) => {
        await this.wallet.credit(number.tenantId, charged, TransactionType.REFUND, `Refund: ${number.e164} could not be activated`, undefined, tx);
        return tx.phoneNumber.update({
          where: { id: number.id },
          data: { status: NumberStatus.FAILED, providerOrderId: result.providerOrderId ?? number.providerOrderId },
        });
      });
    }
    return prisma.phoneNumber.update({
      where: { id: number.id },
      data: {
        status: result.status === 'ACTIVE' ? NumberStatus.ACTIVE : NumberStatus.PENDING,
        providerOrderId: result.providerOrderId ?? number.providerOrderId,
        providerNumberId: result.providerNumberId ?? number.providerNumberId,
      },
    });
  }

  private async findLive(tenant: Tenant, id: string) {
    const n = await tenantDb(tenant.id).phoneNumber.findUnique({ where: { id } });
    if (!n || !LIVE.includes(n.status)) throw new NotFoundException('Number not found');
    return n;
  }

  private async includedAllowance(tenant: Tenant) {
    if (tenant.includedNumbers !== null) return tenant.includedNumbers;
    if (!tenant.planId) return 0;
    const plan = await prisma.plan.findUnique({ where: { id: tenant.planId }, select: { includedNumbers: true } });
    return plan?.includedNumbers ?? 0;
  }

  private async hasIncludedSlot(tenant: Tenant) {
    const [allowance, used] = await Promise.all([
      this.includedAllowance(tenant),
      tenantDb(tenant.id).phoneNumber.count({ where: { status: { in: LIVE } } }),
    ]);
    return used < allowance;
  }

  private carrierError(e: unknown) {
    if (e instanceof ProviderError) return new BadGatewayException(`Phone carrier error: ${e.message}`);
    return e;
  }
}

const quoteKey = (tenantId: string, e164: string) => `quote:${tenantId}:${e164}`;

function toDto(n: PhoneNumber) {
  return {
    id: n.id,
    e164: n.e164,
    label: n.label,
    type: n.type,
    status: n.status,
    monthlyPrice: n.monthlyPrice,
    campaignId: n.campaignId,
    publisherId: n.publisherId,
    purchasedAt: n.purchasedAt,
  };
}
