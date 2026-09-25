import { Logger } from '@nestjs/common';
import { NumberType } from '@viaroute/db';
import type { CallControl, DialRequest, GatherRequest } from '../routing/call-control.types';
import { ProviderError, type AvailableNumber, type NumberSearch, type PurchaseResult, type TelephonyProvider } from './telephony.types';

/**
 * ViaRoute Carrier API v1 — lets any carrier, softswitch or SIP platform plug in.
 * The full spec for carrier developers is in docs/CARRIER_API.md.
 */
export interface CustomCarrierAuth {
  /** e.g. https://switch.example.com/viaroute/v1 (no trailing slash) */
  baseUrl: string;
  apiKey: string;
  /** Whether the carrier implements the optional /numbers endpoints. */
  numbersApi: boolean;
}

const TYPE_PARAM: Record<NumberType, string> = { LOCAL: 'local', TOLL_FREE: 'toll_free' };

class CustomClient {
  private readonly log = new Logger('CustomCarrier');

  constructor(protected auth: CustomCarrierAuth) {}

  protected async request<T>(method: string, path: string, body?: unknown, timeoutMs = 8_000): Promise<T> {
    if (!this.auth.baseUrl) throw new ProviderError('This carrier has no API base URL. Add it under Admin → Carriers.');
    let res: Response;
    try {
      res = await fetch(`${this.auth.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.auth.apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'ViaRoute-Carrier-API/1',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`Could not reach the carrier: ${(e as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) {
      this.log.warn(`${method} ${path.split('?')[0]} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
      throw new ProviderError(json.error ?? json.message ?? `Carrier error (${res.status})`);
    }
    return json as T;
  }
}

/** Call commands, sent as JSON to the carrier. */
export class CustomCallControl extends CustomClient implements CallControl {
  readonly name = 'custom' as const;

  answer(id: string) {
    return this.action(id, 'answer');
  }

  speak(id: string, text: string) {
    return this.action(id, 'speak', { text, voice: 'female', language: 'en-US' });
  }

  async dial(req: DialRequest): Promise<string> {
    const res = await this.request<{ callId?: string }>('POST', '/calls', { to: req.to, from: req.from, timeoutSec: req.timeoutSec, linkTo: req.linkTo });
    if (!res.callId) throw new ProviderError('The carrier did not return a callId for the new call');
    return res.callId;
  }

  bridge(a: string, b: string) {
    return this.action(a, 'bridge', { otherCallId: b });
  }

  recordStart(id: string) {
    return this.action(id, 'record');
  }

  async hangup(id: string) {
    await this.action(id, 'hangup').catch(() => {}); // the leg may already be gone
  }

  reject(id: string) {
    return this.action(id, 'reject');
  }

  /** Speak the prompt and collect keypad digits; the carrier sends call.gathered. */
  gather(id: string, g: GatherRequest) {
    return this.action(id, 'gather', { text: g.prompt, minDigits: g.minDigits, maxDigits: g.maxDigits, timeoutSec: g.timeoutSec, terminator: '#' });
  }

  private async action(id: string, name: string, body: Record<string, unknown> = {}) {
    await this.request('POST', `/calls/${encodeURIComponent(id)}/${name}`, body);
  }
}

/** Optional number endpoints; without them, numbers are added by the platform admin. */
export class CustomNumbersProvider extends CustomClient implements TelephonyProvider {
  readonly name = 'custom' as const;

  async testConnection(): Promise<string> {
    const res = await this.request<{ ok?: boolean; message?: string }>('GET', '/health');
    if (res.ok === false) throw new ProviderError(res.message ?? 'The carrier reports it is not healthy');
    return res.message ? `Connected · ${res.message}` : 'Connected';
  }

  async searchNumbers(q: NumberSearch): Promise<AvailableNumber[]> {
    this.requireNumbersApi();
    const params = new URLSearchParams({ country: q.country, type: TYPE_PARAM[q.type], limit: String(q.limit) });
    if (q.areaCode) params.set('areaCode', q.areaCode);
    const res = await this.request<{ numbers?: { e164: string; monthlyCost?: number; upfrontCost?: number; locality?: string; region?: string }[] }>(
      'GET',
      `/numbers/available?${params}`,
      undefined,
      15_000,
    );
    return (res.numbers ?? []).map((n) => ({
      e164: n.e164,
      type: q.type,
      monthlyCost: Number(n.monthlyCost ?? 0),
      upfrontCost: Number(n.upfrontCost ?? 0),
      locality: n.locality,
      region: n.region,
    }));
  }

  async purchaseNumber(e164: string, reference: string): Promise<PurchaseResult> {
    this.requireNumbersApi();
    const res = await this.request<{ status?: string; id?: string; error?: string }>('POST', '/numbers', { e164, reference }, 15_000);
    return this.result(res);
  }

  async checkOrder(providerOrderId: string, e164: string): Promise<PurchaseResult> {
    const res = await this.request<{ status?: string; id?: string }>('GET', `/numbers/${encodeURIComponent(e164)}`);
    return this.result({ ...res, id: res.id ?? providerOrderId });
  }

  async releaseNumber(e164: string): Promise<void> {
    // Carriers without the numbers API: the number is just taken out of use here.
    if (!this.auth.numbersApi) return;
    await this.request('DELETE', `/numbers/${encodeURIComponent(e164)}`);
  }

  private result(res: { status?: string; id?: string; error?: string }): PurchaseResult {
    const status = res.status === 'active' ? 'ACTIVE' : res.status === 'pending' ? 'PENDING' : 'FAILED';
    return { status, providerOrderId: res.id, providerNumberId: res.id, failureReason: status === 'FAILED' ? res.error ?? 'Carrier rejected the order' : undefined };
  }

  private requireNumbersApi() {
    if (!this.auth.numbersApi) throw new ProviderError('Numbers on this carrier are added by the platform team. Please contact support.');
  }
}
