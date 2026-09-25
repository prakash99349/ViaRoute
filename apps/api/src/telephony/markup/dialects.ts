import { createPrivateKey, randomUUID, sign } from 'crypto';
import { NumberType } from '@viaroute/db';
import { ProviderError, type AvailableNumber, type PurchaseResult } from '../telephony.types';
import { digits, e164, xml, type Hook, type Kv, type MarkupDialect, type MarkupEvent, type MarkupKind, type MarkupUrls, type Verb } from './markup.types';

const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled', 'cancelled', 'timeout', 'rejected', 'unanswered']);

type Body = Record<string, string>;

/** JSON / form HTTP with carrier-friendly errors. */
async function http<T>(url: string, init: { method?: string; headers?: Record<string, string>; json?: unknown; form?: Record<string, string | undefined> } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(Object.entries(init.form).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  }
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ProviderError(`Could not reach the carrier: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const msg = (json.message ?? json.error ?? json.detail ?? json.title ?? (json['error-code-label'] as string)) as string | undefined;
    throw new ProviderError(msg ? String(msg) : `Carrier error (${res.status})`);
  }
  return json as T;
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const missing = (what: string) => new ProviderError(`This carrier is missing its ${what}. Add it under Admin → Carriers.`);

// ===========================================================================
// Twilio & SignalWire (TwiML / LaML)
// ===========================================================================

export class TwimlDialect implements MarkupDialect {
  readonly hasNumbersApi = true;
  private readonly base: string;
  private readonly auth: string;

  constructor(
    readonly kind: Extract<MarkupKind, 'twilio' | 'signalwire'>,
    private creds: { accountSid: string; token: string; space?: string },
    private urls: MarkupUrls,
  ) {
    if (!creds.accountSid || !creds.token) throw missing(kind === 'twilio' ? 'Account SID or Auth Token' : 'Project ID or API token');
    const host = kind === 'twilio' ? 'https://api.twilio.com' : `https://${(creds.space ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')}/api/laml`;
    this.base = `${host}/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}`;
    this.auth = basic(creds.accountSid, creds.token);
  }

  render(verbs: Verb[]) {
    const out = verbs.map((v) => {
      switch (v.t) {
        case 'say': return `<Say voice="woman" language="en-US">${xml(v.text)}</Say>`;
        case 'speakEnded': return `<Redirect method="POST">${xml(this.urls.flow(v.callId))}</Redirect>`;
        case 'join':
          return `<Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false" waitUrl="">${xml(v.room)}</Conference></Dial><Hangup/>`;
        case 'hangup': return '<Hangup/>';
        case 'reject': return '<Reject/>';
      }
    });
    return { body: `<?xml version="1.0" encoding="UTF-8"?><Response>${out.join('')}</Response>`, contentType: 'text/xml' };
  }

  async parse(hook: Hook, b: Body, q: Body): Promise<MarkupEvent> {
    switch (hook) {
      case 'answer': return { callId: b.CallSid, from: e164(b.From), to: e164(b.To) };
      case 'flow': return { callId: q.call };
      case 'join': return { callId: b.CallSid };
      case 'status': return { callId: b.CallSid, ended: TERMINAL.has(b.CallStatus), cause: b.CallStatus };
      case 'recording': return { callId: q.call ?? b.CallSid, recordingUrl: b.RecordingStatus === 'completed' && b.RecordingUrl ? `${b.RecordingUrl}.mp3` : undefined };
      case 'markup': return { markupKey: q.k };
    }
  }

  private rest<T>(path: string, form?: Record<string, string | undefined>, method?: string) {
    return http<T>(`${this.base}${path}`, { method, headers: { Authorization: this.auth }, form });
  }

  async createCall(r: { to: string; from: string; timeoutSec: number; answerUrl: string; statusUrl: string }) {
    const res = await this.rest<{ sid: string }>('/Calls.json', {
      To: r.to,
      From: r.from,
      Url: r.answerUrl,
      Method: 'POST',
      Timeout: String(r.timeoutSec),
      StatusCallback: r.statusUrl,
      StatusCallbackMethod: 'POST',
      StatusCallbackEvent: 'completed',
    });
    return res.sid;
  }

  async updateCall(id: string, verbs: Verb[]) {
    await this.rest(`/Calls/${encodeURIComponent(id)}.json`, { Twiml: this.render(verbs).body });
  }

  async hangupCall(id: string) {
    await this.rest(`/Calls/${encodeURIComponent(id)}.json`, { Status: 'completed' });
  }

  async startRecording(id: string) {
    await this.rest(`/Calls/${encodeURIComponent(id)}/Recordings.json`, {
      RecordingStatusCallback: this.urls.recording(id),
      RecordingStatusCallbackMethod: 'POST',
      RecordingChannels: 'dual',
    });
  }

  async recordingHeaders() {
    return { Authorization: this.auth };
  }

  async testConnection() {
    const a = await this.rest<{ friendly_name?: string; status?: string }>('.json');
    return `Connected · ${a.friendly_name ?? 'account'} (${a.status ?? 'active'})`;
  }

  async searchNumbers(type: NumberType, areaCode: string | undefined, limit: number): Promise<AvailableNumber[]> {
    const params = new URLSearchParams({ PageSize: String(limit), VoiceEnabled: 'true' });
    if (areaCode && type === NumberType.LOCAL) params.set('AreaCode', areaCode);
    const res = await this.rest<{ available_phone_numbers?: { phone_number: string; locality?: string; region?: string }[] }>(
      `/AvailablePhoneNumbers/US/${type === NumberType.TOLL_FREE ? 'TollFree' : 'Local'}.json?${params}`,
    );
    return (res.available_phone_numbers ?? []).map((n) => ({ e164: n.phone_number, type, monthlyCost: 0, upfrontCost: 0, locality: n.locality || undefined, region: n.region || undefined }));
  }

  async purchaseNumber(number: string): Promise<PurchaseResult> {
    const res = await this.rest<{ sid: string }>('/IncomingPhoneNumbers.json', {
      PhoneNumber: number,
      VoiceUrl: this.urls.answer(),
      VoiceMethod: 'POST',
      StatusCallback: this.urls.status(),
      StatusCallbackMethod: 'POST',
    });
    return { status: 'ACTIVE', providerOrderId: res.sid, providerNumberId: res.sid };
  }

  async releaseNumber(number: string, sid?: string | null) {
    let id = sid;
    if (!id) {
      const found = await this.rest<{ incoming_phone_numbers?: { sid: string }[] }>(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`);
      id = found.incoming_phone_numbers?.[0]?.sid;
    }
    if (id) await this.rest(`/IncomingPhoneNumbers/${encodeURIComponent(id)}.json`, undefined, 'DELETE');
  }
}

// ===========================================================================
// Plivo (Plivo XML)
// ===========================================================================

export class PlivoDialect implements MarkupDialect {
  readonly kind = 'plivo' as const;
  readonly hasNumbersApi = true;
  private readonly base: string;
  private readonly auth: string;

  constructor(private creds: { authId: string; authToken: string; appId?: string }, private urls: MarkupUrls, private kv: Kv) {
    if (!creds.authId || !creds.authToken) throw missing('Auth ID or Auth Token');
    this.base = `https://api.plivo.com/v1/Account/${encodeURIComponent(creds.authId)}`;
    this.auth = basic(creds.authId, creds.authToken);
  }

  render(verbs: Verb[]) {
    const out = verbs.map((v) => {
      switch (v.t) {
        case 'say': return `<Speak voice="WOMAN" language="en-US">${xml(v.text)}</Speak>`;
        case 'speakEnded': return `<Redirect method="POST">${xml(this.urls.flow(v.callId))}</Redirect>`;
        case 'join': return `<Conference enterSound="" exitSound="" waitSound="" startConferenceOnEnter="true" endConferenceOnExit="false">${xml(v.room)}</Conference>`;
        case 'hangup': return '<Hangup/>';
        case 'reject': return '<Hangup reason="rejected"/>';
      }
    });
    return { body: `<?xml version="1.0" encoding="UTF-8"?><Response>${out.join('')}</Response>`, contentType: 'text/xml' };
  }

  /** Outbound legs are known by the request_uuid we got when dialing; live-call REST needs the call_uuid. */
  private legId(b: Body) {
    return b.Direction === 'outbound' && b.RequestUUID ? b.RequestUUID : b.CallUUID;
  }

  async parse(hook: Hook, b: Body, q: Body): Promise<MarkupEvent> {
    if (b.Direction === 'outbound' && b.RequestUUID && b.CallUUID) await this.kv.set(`plivo:uuid:${b.RequestUUID}`, b.CallUUID, 6 * 3600);
    switch (hook) {
      case 'answer': return { callId: b.CallUUID, from: e164(b.From), to: e164(b.To) };
      case 'flow': return { callId: q.call };
      case 'join': return { callId: this.legId(b) };
      case 'status': return { callId: this.legId(b), ended: true, cause: b.HangupCause ?? b.CallStatus };
      case 'recording': return { callId: q.call, recordingUrl: b.RecordUrl };
      case 'markup': return { markupKey: q.k };
    }
  }

  private async callUuid(id: string) {
    return (await this.kv.get(`plivo:uuid:${id}`)) ?? id;
  }

  private rest<T>(path: string, json?: unknown, method?: string) {
    return http<T>(`${this.base}${path}`, { method, headers: { Authorization: this.auth }, json });
  }

  async createCall(r: { to: string; from: string; timeoutSec: number; answerUrl: string; statusUrl: string }) {
    const res = await this.rest<{ request_uuid: string | string[] }>('/Call/', {
      from: digits(r.from),
      to: r.to.startsWith('sip:') ? r.to : digits(r.to),
      answer_url: r.answerUrl,
      answer_method: 'POST',
      hangup_url: r.statusUrl,
      hangup_method: 'POST',
      ring_timeout: r.timeoutSec,
    });
    const id = Array.isArray(res.request_uuid) ? res.request_uuid[0] : res.request_uuid;
    await this.kv.set(`plivo:req:${id}`, '1', 6 * 3600);
    return id;
  }

  async updateCall(id: string, verbs: Verb[]) {
    const key = randomUUID();
    await this.kv.set(`markup:${key}`, JSON.stringify(verbs), 600);
    await this.rest(`/Call/${encodeURIComponent(await this.callUuid(id))}/`, { legs: 'aleg', aleg_url: this.urls.markup(key), aleg_method: 'POST' });
  }

  async hangupCall(id: string) {
    const isRequest = await this.kv.get(`plivo:req:${id}`);
    const uuid = await this.kv.get(`plivo:uuid:${id}`);
    if (isRequest && !uuid) await this.rest(`/Request/${encodeURIComponent(id)}/`, undefined, 'DELETE'); // still ringing
    else await this.rest(`/Call/${encodeURIComponent(uuid ?? id)}/`, undefined, 'DELETE');
  }

  async startRecording(id: string) {
    await this.rest(`/Call/${encodeURIComponent(await this.callUuid(id))}/Record/`, { callback_url: this.urls.recording(id), callback_method: 'POST', file_format: 'mp3' });
  }

  async recordingHeaders() {
    return {};
  }

  async testConnection() {
    const a = await this.rest<{ cash_credits?: string; account_type?: string }>('/');
    return a.cash_credits !== undefined ? `Connected · credit USD ${Number(a.cash_credits).toFixed(2)}` : 'Connected';
  }

  async searchNumbers(type: NumberType, areaCode: string | undefined, limit: number): Promise<AvailableNumber[]> {
    const params = new URLSearchParams({ country_iso: 'US', type: type === NumberType.TOLL_FREE ? 'tollfree' : 'local', limit: String(limit), services: 'voice' });
    if (areaCode && type === NumberType.LOCAL) params.set('pattern', `1${areaCode}`);
    const res = await this.rest<{ objects?: { number: string; monthly_rental_rate?: string; city?: string; region?: string }[] }>(`/PhoneNumber/?${params}`);
    return (res.objects ?? []).map((n) => ({ e164: e164(n.number)!, type, monthlyCost: Number(n.monthly_rental_rate ?? 0), upfrontCost: 0, locality: n.city || undefined, region: n.region || undefined }));
  }

  async purchaseNumber(number: string): Promise<PurchaseResult> {
    const res = await this.rest<{ status?: string; numbers?: { number: string; status: string }[] }>(`/PhoneNumber/${digits(number)}/`, this.creds.appId ? { app_id: this.creds.appId } : {});
    const st = res.numbers?.[0]?.status ?? res.status;
    return { status: st === 'Success' || st === 'fulfilled' ? 'ACTIVE' : st === 'pending' ? 'PENDING' : 'ACTIVE', providerOrderId: digits(number), providerNumberId: digits(number) };
  }

  async releaseNumber(number: string) {
    await this.rest(`/Number/${digits(number)}/`, undefined, 'DELETE');
  }
}

// ===========================================================================
// Bandwidth (BXML)
// ===========================================================================

export class BandwidthDialect implements MarkupDialect {
  readonly kind = 'bandwidth' as const;
  /** Bandwidth numbers are ordered in its dashboard; the admin adds them here. */
  readonly hasNumbersApi = false;
  private readonly base: string;
  private readonly auth: string;

  constructor(private creds: { accountId: string; username: string; password: string; applicationId: string }, private urls: MarkupUrls, private kv: Kv) {
    if (!creds.accountId || !creds.username || !creds.password) throw missing('account ID, username or password');
    this.base = `https://voice.bandwidth.com/api/v2/accounts/${encodeURIComponent(creds.accountId)}`;
    this.auth = basic(creds.username, creds.password);
  }

  render(verbs: Verb[]) {
    const out = verbs.map((v) => {
      switch (v.t) {
        case 'say': return `<SpeakSentence voice="julie">${xml(v.text)}</SpeakSentence>`;
        case 'speakEnded': return `<Redirect redirectUrl="${xml(this.urls.flow(v.callId))}" redirectMethod="POST"/>`;
        case 'join':
          return `${v.record ? `<StartRecording recordingAvailableUrl="${xml(this.urls.recording(v.record.callId))}" recordingAvailableMethod="POST"/>` : ''}<Conference>${xml(v.room)}</Conference>`;
        case 'hangup':
        case 'reject':
          return '<Hangup/>';
      }
    });
    return { body: `<?xml version="1.0" encoding="UTF-8"?><Response>${out.join('')}</Response>`, contentType: 'application/xml' };
  }

  async parse(hook: Hook, b: Body, q: Body): Promise<MarkupEvent> {
    switch (hook) {
      case 'answer': return { callId: b.callId, from: e164(b.from), to: e164(b.to) };
      case 'flow': return { callId: q.call };
      case 'join': return { callId: b.callId };
      case 'status': return { callId: b.callId, ended: b.eventType === 'disconnect', cause: b.cause };
      case 'recording': return { callId: q.call, recordingUrl: b.mediaUrl };
      case 'markup': return { markupKey: q.k };
    }
  }

  private rest<T>(path: string, json?: unknown, method?: string) {
    return http<T>(`${this.base}${path}`, { method, headers: { Authorization: this.auth }, json });
  }

  async createCall(r: { to: string; from: string; timeoutSec: number; answerUrl: string; statusUrl: string }) {
    if (!this.creds.applicationId) throw missing('Voice application ID');
    const res = await this.rest<{ callId: string }>('/calls', {
      from: r.from,
      to: r.to,
      applicationId: this.creds.applicationId,
      answerUrl: r.answerUrl,
      answerMethod: 'POST',
      disconnectUrl: r.statusUrl,
      disconnectMethod: 'POST',
      callTimeout: r.timeoutSec,
    });
    return res.callId;
  }

  async updateCall(id: string, verbs: Verb[]) {
    const key = randomUUID();
    await this.kv.set(`markup:${key}`, JSON.stringify(verbs), 600);
    await this.rest(`/calls/${encodeURIComponent(id)}`, { redirectUrl: this.urls.markup(key), redirectMethod: 'POST' });
  }

  async hangupCall(id: string) {
    await this.rest(`/calls/${encodeURIComponent(id)}`, { state: 'completed' });
  }

  /** Recording is started in BXML: the caller re-joins their room with <StartRecording>. */
  async startRecording(id: string, room: string) {
    await this.updateCall(id, [{ t: 'join', room, record: { callId: id } }]);
  }

  async recordingHeaders() {
    return { Authorization: this.auth };
  }

  async testConnection() {
    await this.rest('/calls?pageSize=1');
    return 'Connected';
  }

  async searchNumbers(): Promise<AvailableNumber[]> {
    return [];
  }

  async purchaseNumber(): Promise<PurchaseResult> {
    return { status: 'FAILED', failureReason: 'Order Bandwidth numbers in the Bandwidth dashboard' };
  }

  async releaseNumber() {}
}

// ===========================================================================
// Vonage (NCCO)
// ===========================================================================

export class VonageDialect implements MarkupDialect {
  readonly kind = 'vonage' as const;
  readonly hasNumbersApi: boolean;

  constructor(private creds: { applicationId: string; privateKey: string; apiKey?: string; apiSecret?: string }, private urls: MarkupUrls) {
    if (!creds.applicationId || !creds.privateKey) throw missing('application ID or private key');
    this.hasNumbersApi = !!(creds.apiKey && creds.apiSecret);
  }

  private ncco(verbs: Verb[]): object[] {
    const out: object[] = [];
    for (const v of verbs) {
      switch (v.t) {
        case 'say':
          out.push({ action: 'talk', text: v.text, language: 'en-US' });
          break;
        case 'speakEnded':
          out.push({ action: 'notify', payload: { call: v.callId }, eventUrl: [this.urls.flow(v.callId)], eventMethod: 'POST' });
          break;
        case 'join':
          out.push({
            action: 'conversation',
            name: v.room,
            startOnEnter: true,
            endOnExit: false,
            ...(v.record ? { record: true, eventUrl: [this.urls.recording(v.record.callId)], eventMethod: 'POST' } : {}),
          });
          break;
        case 'hangup':
        case 'reject':
          // An NCCO that ends ends the call.
          return out;
      }
    }
    return out;
  }

  render(verbs: Verb[]) {
    return { body: JSON.stringify(this.ncco(verbs)), contentType: 'application/json' };
  }

  async parse(hook: Hook, b: Body, q: Body): Promise<MarkupEvent> {
    switch (hook) {
      case 'answer': return { callId: b.uuid, from: e164(b.from), to: e164(b.to) };
      case 'flow': return { callId: q.call };
      case 'join': return { callId: b.uuid };
      case 'status': return { callId: b.uuid, ended: TERMINAL.has(b.status), cause: b.status };
      case 'recording': return { callId: q.call, recordingUrl: b.recording_url };
      case 'markup': return { markupKey: q.k };
    }
  }

  /** Vonage Voice API auth: a short-lived RS256 JWT signed with the application's private key. */
  private jwt() {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ application_id: this.creds.applicationId, iat: now, exp: now + 300, jti: randomUUID() })}`;
    let key;
    try {
      key = createPrivateKey(this.creds.privateKey.replace(/\\n/g, '\n'));
    } catch {
      throw new ProviderError('The Vonage private key is not a valid PEM key');
    }
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
  }

  private voice<T>(path: string, json?: unknown, method?: string) {
    return http<T>(`https://api.nexmo.com/v1/calls${path}`, { method, headers: { Authorization: `Bearer ${this.jwt()}` }, json });
  }

  private endpoint(to: string) {
    return to.startsWith('sip:') ? { type: 'sip', uri: to } : { type: 'phone', number: digits(to) };
  }

  async createCall(r: { to: string; from: string; timeoutSec: number; answerUrl: string; statusUrl: string }) {
    const res = await this.voice<{ uuid: string }>('', {
      to: [this.endpoint(r.to)],
      from: { type: 'phone', number: digits(r.from) },
      answer_url: [r.answerUrl],
      answer_method: 'POST',
      event_url: [r.statusUrl],
      event_method: 'POST',
      ringing_timer: r.timeoutSec,
    });
    return res.uuid;
  }

  async updateCall(id: string, verbs: Verb[]) {
    await this.voice(`/${encodeURIComponent(id)}`, { action: 'transfer', destination: { type: 'ncco', ncco: this.ncco(verbs) } }, 'PUT');
  }

  async hangupCall(id: string) {
    await this.voice(`/${encodeURIComponent(id)}`, { action: 'hangup' }, 'PUT');
  }

  /** The caller re-joins their room with recording on. */
  async startRecording(id: string, room: string) {
    await this.updateCall(id, [{ t: 'join', room, record: { callId: id } }]);
  }

  async recordingHeaders() {
    return { Authorization: `Bearer ${this.jwt()}` };
  }

  private account() {
    if (!this.creds.apiKey || !this.creds.apiSecret) throw missing('API key and secret');
    return { api_key: this.creds.apiKey, api_secret: this.creds.apiSecret };
  }

  async testConnection() {
    this.jwt(); // checks the private key
    if (!this.hasNumbersApi) return 'Private key OK · add the API key and secret to check the account';
    const res = await http<{ value?: number }>(`https://rest.nexmo.com/account/get-balance?${new URLSearchParams(this.account())}`);
    return res.value !== undefined ? `Connected · balance EUR ${Number(res.value).toFixed(2)}` : 'Connected';
  }

  async searchNumbers(type: NumberType, areaCode: string | undefined, limit: number): Promise<AvailableNumber[]> {
    const params = new URLSearchParams({ ...this.account(), country: 'US', features: 'VOICE', size: String(limit), type: type === NumberType.TOLL_FREE ? 'landline-toll-free' : 'landline' });
    if (areaCode && type === NumberType.LOCAL) {
      params.set('pattern', `1${areaCode}`);
      params.set('search_pattern', '0');
    }
    const res = await http<{ numbers?: { msisdn: string; cost?: string }[] }>(`https://rest.nexmo.com/number/search?${params}`);
    return (res.numbers ?? []).map((n) => ({ e164: `+${n.msisdn}`, type, monthlyCost: Number(n.cost ?? 0), upfrontCost: 0 }));
  }

  async purchaseNumber(number: string): Promise<PurchaseResult> {
    const msisdn = digits(number);
    await http('https://rest.nexmo.com/number/buy', { form: { ...this.account(), country: 'US', msisdn } });
    // Send the number's calls to this application (answer + event URLs live on the application).
    await http('https://rest.nexmo.com/number/update', { form: { ...this.account(), country: 'US', msisdn, app_id: this.creds.applicationId } });
    return { status: 'ACTIVE', providerOrderId: msisdn, providerNumberId: msisdn };
  }

  async releaseNumber(number: string) {
    await http('https://rest.nexmo.com/number/cancel', { form: { ...this.account(), country: 'US', msisdn: digits(number) } });
  }
}
