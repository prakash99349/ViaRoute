import { Logger } from '@nestjs/common';
import { NumberType } from '@viaroute/db';
import {
  ProviderError, type AvailableNumber, type CarrierAuth, type NumberSearch, type PurchaseResult, type TelephonyProvider,
} from './telephony.types';

const BASE = 'https://api.telnyx.com/v2';
const TYPE_PARAM: Record<NumberType, string> = { LOCAL: 'local', TOLL_FREE: 'toll_free' };

interface TelnyxAvailable {
  phone_number: string;
  cost_information?: { monthly_cost?: string; upfront_cost?: string; currency?: string };
  region_information?: { region_type: string; region_name: string }[];
}

interface TelnyxOrder {
  id: string;
  status: 'pending' | 'success' | 'failure';
  phone_numbers?: { id: string; phone_number: string; status: string }[];
}

/**
 * Telnyx Numbers API.
 * Docs: https://developers.telnyx.com/api-reference/phone-number-orders/create-a-number-order
 */
export class TelnyxProvider implements TelephonyProvider {
  readonly name = 'telnyx' as const;
  private readonly log = new Logger(TelnyxProvider.name);

  constructor(private auth: CarrierAuth) {}

  async testConnection(): Promise<string> {
    const { data } = await this.request<{ data: { balance?: string; currency?: string } }>('GET', '/balance');
    return data.balance !== undefined ? `Connected · balance ${data.currency ?? 'USD'} ${Number(data.balance).toFixed(2)}` : 'Connected';
  }

  async searchNumbers(q: NumberSearch): Promise<AvailableNumber[]> {
    const params = new URLSearchParams({
      'filter[country_code]': q.country,
      'filter[phone_number_type]': TYPE_PARAM[q.type],
      'filter[limit]': String(q.limit),
    });
    if (q.areaCode && q.type === NumberType.LOCAL) params.set('filter[national_destination_code]', q.areaCode);

    const res = await this.request<{ data: TelnyxAvailable[] }>('GET', `/available_phone_numbers?${params}`);
    return res.data
      .filter((n) => (n.cost_information?.currency ?? 'USD') === 'USD')
      .map((n) => {
        const region = (t: string) => n.region_information?.find((r) => r.region_type === t)?.region_name;
        return {
          e164: n.phone_number,
          type: q.type,
          monthlyCost: Number(n.cost_information?.monthly_cost ?? 0),
          upfrontCost: Number(n.cost_information?.upfront_cost ?? 0),
          locality: region('location') ?? region('rate_center'),
          region: region('state'),
        };
      });
  }

  async purchaseNumber(e164: string, reference: string): Promise<PurchaseResult> {
    const body: Record<string, unknown> = { phone_numbers: [{ phone_number: e164 }], customer_reference: reference };
    if (this.auth.connectionId) body.connection_id = this.auth.connectionId;
    const { data } = await this.request<{ data: TelnyxOrder }>('POST', '/number_orders', body);
    return this.fromOrder(data, e164);
  }

  async checkOrder(providerOrderId: string, e164: string): Promise<PurchaseResult> {
    const { data } = await this.request<{ data: TelnyxOrder }>('GET', `/number_orders/${encodeURIComponent(providerOrderId)}`);
    return this.fromOrder(data, e164);
  }

  async releaseNumber(e164: string, providerNumberId?: string | null): Promise<void> {
    const id = providerNumberId ?? (await this.findNumberId(e164));
    if (!id) {
      this.log.warn(`Release: ${e164} not found on Telnyx account, treating as released`);
      return;
    }
    await this.request('DELETE', `/phone_numbers/${encodeURIComponent(id)}`);
  }

  private async fromOrder(order: TelnyxOrder, e164: string): Promise<PurchaseResult> {
    if (order.status === 'failure') return { status: 'FAILED', providerOrderId: order.id, failureReason: 'Carrier rejected the order' };
    if (order.status === 'pending') return { status: 'PENDING', providerOrderId: order.id };
    // The order's phone_numbers[].id is the order line, so look up the number's own id.
    return { status: 'ACTIVE', providerOrderId: order.id, providerNumberId: (await this.findNumberId(e164)) ?? undefined };
  }

  private async findNumberId(e164: string): Promise<string | null> {
    const params = new URLSearchParams({ 'filter[phone_number]': e164 });
    const res = await this.request<{ data: { id: string; phone_number: string }[] }>('GET', `/phone_numbers?${params}`);
    return res.data.find((n) => n.phone_number === e164)?.id ?? null;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.auth.apiKey) throw new ProviderError('This carrier has no API key. Add it under Admin → Carriers.');
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.auth.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (json as { errors?: { detail?: string; title?: string }[] }).errors?.[0];
      this.log.error(`Telnyx ${method} ${path.split('?')[0]} → ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      throw new ProviderError(detail?.detail ?? detail?.title ?? `Carrier error (${res.status})`);
    }
    return json as T;
  }
}
