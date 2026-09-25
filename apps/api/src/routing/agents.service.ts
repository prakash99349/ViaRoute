import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';
import Redis from 'ioredis';
import { prisma, ProviderType, type Agent, type Provider, type Tenant } from '@viaroute/db';
import { decrypt, encrypt } from '../common/crypto';
import { REDIS } from '../common/redis.module';
import { ProvidersService } from '../telephony/providers.service';

/** How long "Available" lasts without a heartbeat from the softphone. */
const PRESENCE_TTL = 45;

export type SoftphoneMode = 'simulator' | 'telnyx' | 'twilio';

/** A call ringing or connected on an agent's softphone. */
export interface AgentLeg {
  legId: string;
  callId: string;
  caller: string;
  callerState: string | null;
  campaign: string | null;
  ivrPath: string | null;
  state: 'ringing' | 'active';
  since: string;
  /** Simulated calls are answered through ViaRoute; real ones through the carrier SDK. */
  simulated: boolean;
}

interface SipLogin {
  credentialId?: string;
  sipUsername?: string;
  sipPassword?: string;
}

/**
 * In-house agents: availability, where calls to them are sent on each carrier, and the tokens their
 * browser softphone logs in with.
 *   Test carrier → "agent:<target>" (answered from the softphone through ViaRoute, no audio)
 *   Telnyx       → sip:<credential>@sip.telnyx.com (Telnyx WebRTC SDK or any SIP phone)
 *   Twilio       → client:agent_<target> (Twilio Voice JS SDK)
 */
@Injectable()
export class AgentsService {
  private readonly log = new Logger(AgentsService.name);

  constructor(@Inject(REDIS) private redis: Redis, private providers: ProvidersService) {}

  // --- Presence ------------------------------------------------------------------

  async setAvailable(targetId: string, available: boolean) {
    if (available) await this.redis.set(presenceKey(targetId), '1', 'EX', PRESENCE_TTL);
    else await this.redis.del(presenceKey(targetId));
  }

  /** The softphone calls this every ~20s while it's open and Available. */
  async heartbeat(targetId: string) {
    await this.redis.expire(presenceKey(targetId), PRESENCE_TTL);
  }

  async isAvailable(targetId: string) {
    return (await this.redis.exists(presenceKey(targetId))) === 1;
  }

  async available(targetIds: string[]): Promise<Set<string>> {
    if (!targetIds.length) return new Set();
    const vals = await this.redis.mget(...targetIds.map(presenceKey));
    return new Set(targetIds.filter((_, i) => vals[i]));
  }

  // --- Where to send a call ---------------------------------------------------------

  /** The address that rings this agent on the call's carrier; null when that carrier can't reach agents. */
  async addressFor(agent: Pick<Agent, 'targetId' | 'sipCredentials'>, provider: string, carrier: Provider | null): Promise<string | null> {
    if (provider === 'simulator') return `agent:${agent.targetId}`;
    if (carrier?.type === ProviderType.TELNYX) {
      const login = this.login(agent);
      return login.sipUsername ? `sip:${login.sipUsername}@sip.telnyx.com` : null;
    }
    if (carrier?.type === ProviderType.TWILIO) return `client:${identity(agent.targetId)}`;
    return null;
  }

  // --- Live legs (what the softphone shows) -----------------------------------------------

  async trackLeg(targetId: string, leg: AgentLeg) {
    await this.redis.hset(legsKey(targetId), leg.legId, JSON.stringify(leg));
    await this.redis.expire(legsKey(targetId), 6 * 3600);
  }

  async markActive(targetId: string, legId: string) {
    const raw = await this.redis.hget(legsKey(targetId), legId);
    if (raw) await this.redis.hset(legsKey(targetId), legId, JSON.stringify({ ...(JSON.parse(raw) as AgentLeg), state: 'active', since: new Date().toISOString() }));
  }

  async dropLeg(targetId: string, legId: string) {
    await this.redis.hdel(legsKey(targetId), legId);
  }

  async legs(targetId: string): Promise<AgentLeg[]> {
    const all = await this.redis.hvals(legsKey(targetId));
    return all.map((v) => JSON.parse(v) as AgentLeg).sort((a, b) => a.since.localeCompare(b.since));
  }

  // --- Softphone login ----------------------------------------------------------------

  /** How this agent's softphone connects, with a short-lived token for the carrier SDK. */
  async softphone(agent: Agent, tenant: Tenant): Promise<{ mode: SoftphoneMode; token?: string; identity?: string; carrier?: string; sip?: { username: string; password: string; domain: string } }> {
    const carrier = await this.providers.forNewNumber(tenant);
    if (carrier.type === ProviderType.TEST) return { mode: 'simulator', carrier: carrier.name };

    if (carrier.type === ProviderType.TELNYX) {
      const login = await this.telnyxLogin(agent, carrier);
      const token = await this.telnyx<string>(carrier, 'POST', `/telephony_credentials/${encodeURIComponent(login.credentialId!)}/token`, undefined, true);
      return { mode: 'telnyx', token, carrier: carrier.name, sip: { username: login.sipUsername!, password: login.sipPassword!, domain: 'sip.telnyx.com' } };
    }

    if (carrier.type === ProviderType.TWILIO) {
      const c = this.providers.credentials(carrier);
      if (!c.accountSid || !c.apiKeySid || !c.apiKeySecret) throw new BadRequestException('The Twilio carrier needs an API key SID and secret for the browser softphone (Admin → Carriers).');
      return { mode: 'twilio', token: twilioToken(c.accountSid, c.apiKeySid, c.apiKeySecret, identity(agent.targetId)), identity: identity(agent.targetId), carrier: carrier.name };
    }
    throw new BadRequestException(`The browser softphone works with Telnyx, Twilio and the Test carrier. This account uses ${carrier.name}.`);
  }

  /** Telnyx SIP credential for the agent (made once, on the carrier's SIP credential connection). */
  private async telnyxLogin(agent: Agent, carrier: Provider): Promise<SipLogin> {
    const existing = this.login(agent);
    if (existing.credentialId && agent.providerId === carrier.id) return existing;
    const connection = this.providers.credentials(carrier).sipConnectionId;
    if (!connection) throw new BadRequestException('Add the Telnyx "SIP credential connection ID" to the carrier (Admin → Carriers) to use the softphone.');
    const res = await this.telnyx<{ data: { id: string; sip_username: string; sip_password: string } }>(carrier, 'POST', '/telephony_credentials', {
      connection_id: connection,
      name: `viaroute-agent-${agent.targetId}`,
    });
    const login: SipLogin = { credentialId: res.data.id, sipUsername: res.data.sip_username, sipPassword: res.data.sip_password };
    await prisma.agent.update({ where: { id: agent.id }, data: { sipCredentials: encrypt(JSON.stringify(login)), providerId: carrier.id } });
    agent.sipCredentials = encrypt(JSON.stringify(login));
    agent.providerId = carrier.id;
    return login;
  }

  login(agent: Pick<Agent, 'sipCredentials'>): SipLogin {
    if (!agent.sipCredentials) return {};
    try {
      return JSON.parse(decrypt(agent.sipCredentials)) as SipLogin;
    } catch {
      return {};
    }
  }

  private async telnyx<T>(carrier: Provider, method: string, path: string, body?: unknown, text = false): Promise<T> {
    const key = this.providers.credentials(carrier).apiKey;
    const res = await fetch(`https://api.telnyx.com/v2${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: text ? 'text/plain' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      this.log.warn(`Telnyx ${path} → ${res.status}: ${raw.slice(0, 300)}`);
      throw new BadRequestException(`Telnyx refused the softphone login (${res.status})`);
    }
    return (text ? raw.trim() : JSON.parse(raw)) as T;
  }
}

const presenceKey = (targetId: string) => `agent:online:${targetId}`;
const legsKey = (targetId: string) => `agent:legs:${targetId}`;
export const identity = (targetId: string) => `agent_${targetId.replace(/-/g, '')}`;

/** Twilio Access Token (JWT, HS256) with a Voice grant that lets this identity receive calls. */
export function twilioToken(accountSid: string, apiKeySid: string, apiKeySecret: string, id: string, ttlSec = 3600) {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = { jti: `${apiKeySid}-${now}-${randomUUID().slice(0, 8)}`, iss: apiKeySid, sub: accountSid, iat: now, exp: now + ttlSec, grants: { identity: id, voice: { incoming: { allow: true } } } };
  const unsigned = `${enc(header)}.${enc(payload)}`;
  return `${unsigned}.${createHmac('sha256', apiKeySecret).update(unsigned).digest('base64url')}`;
}
