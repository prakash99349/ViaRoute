import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, prisma, TransactionType } from '@viaroute/db';

type Tx = Prisma.TransactionClient;

export class InsufficientFundsError extends HttpException {
  constructor(needed: Prisma.Decimal, balance: Prisma.Decimal) {
    super(
      `Not enough funds: this costs $${needed.toFixed(2)} but your wallet has $${balance.toFixed(2)}. Please add funds.`,
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/**
 * Prepaid wallet. Every change writes a Transaction row with the balance after it,
 * so the ledger always explains the balance.
 */
@Injectable()
export class WalletService {
  /** Takes money out. Atomic: the balance can never go below zero, even with parallel requests. */
  async debit(tenantId: string, amount: Prisma.Decimal.Value, type: TransactionType, description: string, tx?: Tx) {
    const value = new Prisma.Decimal(amount);
    if (value.lte(0)) return this.balance(tenantId, tx);

    const run = async (t: Tx) => {
      const { count } = await t.tenant.updateMany({
        where: { id: tenantId, walletBalance: { gte: value } },
        data: { walletBalance: { decrement: value } },
      });
      const tenant = await t.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { walletBalance: true } });
      if (count !== 1) throw new InsufficientFundsError(value, tenant.walletBalance);
      await t.transaction.create({
        data: { tenantId, type, amount: value.neg(), balanceAfter: tenant.walletBalance, description },
      });
      return tenant.walletBalance;
    };
    return tx ? run(tx) : prisma.$transaction(run);
  }

  /**
   * Charges usage that already happened (a finished call). Unlike debit() this may take the
   * balance below zero; routing stops new calls once the balance is not positive.
   */
  async charge(tenantId: string, amount: Prisma.Decimal.Value, type: TransactionType, description: string, callId?: string, tx?: Tx) {
    const value = new Prisma.Decimal(amount);
    if (value.lte(0)) return this.balance(tenantId, tx);
    const run = async (t: Tx) => {
      const tenant = await t.tenant.update({
        where: { id: tenantId },
        data: { walletBalance: { decrement: value } },
        select: { walletBalance: true },
      });
      await t.transaction.create({
        data: { tenantId, type, amount: value.neg(), balanceAfter: tenant.walletBalance, description, callId },
      });
      return tenant.walletBalance;
    };
    return tx ? run(tx) : prisma.$transaction(run);
  }

  /** Adds money (top-ups, refunds, admin adjustments). */
  async credit(tenantId: string, amount: Prisma.Decimal.Value, type: TransactionType, description: string, stripeRef?: string, tx?: Tx, refundOfId?: string) {
    const value = new Prisma.Decimal(amount);
    const run = async (t: Tx) => {
      const tenant = await t.tenant.update({
        where: { id: tenantId },
        data: { walletBalance: { increment: value } },
        select: { walletBalance: true, lowBalanceThreshold: true },
      });
      if (tenant.walletBalance.gte(tenant.lowBalanceThreshold)) {
        // Back above the alert level: allow the next low-balance alert.
        await t.tenant.update({ where: { id: tenantId }, data: { lowBalanceNotifiedAt: null } });
      }
      await t.transaction.create({
        data: { tenantId, type, amount: value, balanceAfter: tenant.walletBalance, description, stripeRef, refundOfId },
      });
      return tenant.walletBalance;
    };
    return tx ? run(tx) : prisma.$transaction(run);
  }

  async balance(tenantId: string, tx?: Tx) {
    const t = await (tx ?? prisma).tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { walletBalance: true } });
    return t.walletBalance;
  }
}
