import { NumberType, prisma } from '@viaroute/db';
import type { AvailableNumber, NumberSearch, PurchaseResult, TelephonyProvider } from './telephony.types';

const DEFAULT_AREA_CODES = ['212', '305', '415', '512', '702', '713'];
const TOLL_FREE_PREFIXES = ['833', '844', '855'];

/**
 * Simulated carrier for local development (used when TELNYX_API_KEY is empty).
 * Numbers use the 555-01XX range, which is reserved for fiction and never rings a real person.
 * Buying 555-0199 simulates a carrier rejection; 555-0198 simulates a slow (pending) order.
 */
export class MockTelephonyProvider implements TelephonyProvider {
  readonly name = 'mock' as const;

  async testConnection() {
    return 'Test carrier: simulated numbers and calls, nothing to connect';
  }

  async searchNumbers(q: NumberSearch): Promise<AvailableNumber[]> {
    const prefixes =
      q.type === NumberType.TOLL_FREE ? TOLL_FREE_PREFIXES : q.areaCode ? [q.areaCode] : DEFAULT_AREA_CODES;

    const taken = new Set(
      (await prisma.phoneNumber.findMany({ where: { status: { in: ['ACTIVE', 'PENDING'] } }, select: { e164: true } })).map(
        (n) => n.e164,
      ),
    );

    const results: AvailableNumber[] = [];
    for (let i = 0; i < 100 && results.length < q.limit; i++) {
      const prefix = prefixes[i % prefixes.length];
      const e164 = `+1${prefix}55501${String(i).padStart(2, '0')}`;
      if (taken.has(e164)) continue;
      results.push({
        e164,
        type: q.type,
        monthlyCost: q.type === NumberType.TOLL_FREE ? 1.5 : 1,
        upfrontCost: 0,
        locality: q.type === NumberType.TOLL_FREE ? undefined : 'Test City',
        region: q.type === NumberType.TOLL_FREE ? undefined : 'TS',
      });
    }
    return results;
  }

  async purchaseNumber(e164: string): Promise<PurchaseResult> {
    if (e164.endsWith('5550199')) return { status: 'FAILED', failureReason: 'Simulated carrier rejection' };
    if (e164.endsWith('5550198')) return { status: 'PENDING', providerOrderId: `mock_order_${e164}` };
    return { status: 'ACTIVE', providerOrderId: `mock_order_${e164}`, providerNumberId: `mock_${e164}` };
  }

  async checkOrder(_orderId: string, e164: string): Promise<PurchaseResult> {
    return { status: 'ACTIVE', providerNumberId: `mock_${e164}` };
  }

  async releaseNumber(): Promise<void> {}
}
