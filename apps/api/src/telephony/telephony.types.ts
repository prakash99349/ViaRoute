import type { NumberType } from '@viaroute/db';

export interface NumberSearch {
  country: string; // ISO code, e.g. "US"
  type: NumberType;
  areaCode?: string;
  limit: number;
}

export interface AvailableNumber {
  e164: string;
  type: NumberType;
  /** Carrier's monthly cost to us (USD). */
  monthlyCost: number;
  /** Carrier's one-time cost to us (USD). */
  upfrontCost: number;
  locality?: string;
  region?: string;
}

export interface PurchaseResult {
  status: 'ACTIVE' | 'PENDING' | 'FAILED';
  providerOrderId?: string;
  /** Carrier's id for the number, if already known. */
  providerNumberId?: string;
  failureReason?: string;
}

/** Anything that can sell us phone numbers (one instance per carrier account). */
export interface TelephonyProvider {
  readonly name: 'telnyx' | 'custom' | 'mock';
  searchNumbers(q: NumberSearch): Promise<AvailableNumber[]>;
  purchaseNumber(e164: string, reference: string): Promise<PurchaseResult>;
  /** Re-checks a PENDING order. */
  checkOrder(providerOrderId: string, e164: string): Promise<PurchaseResult>;
  releaseNumber(e164: string, providerNumberId?: string | null): Promise<void>;
  /** Checks the credentials work; returns a short summary (e.g. account balance). */
  testConnection(): Promise<string>;
}

/** API credentials for one carrier account. */
export interface CarrierAuth {
  apiKey: string;
  connectionId?: string;
}

export class ProviderError extends Error {}
