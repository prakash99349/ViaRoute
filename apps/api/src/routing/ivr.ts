/**
 * IVR (phone menu) for a campaign: runs after the recording notice and before buyers are dialed.
 *
 *   menu    — "Press 1 for sales, 2 for support"; each key has an action
 *   collect — "Enter your 5-digit ZIP code"; the digits are saved as a variable (e.g. zip)
 *   say     — plays a message, then continues
 *
 * Actions: go to another step, send the call to buyers (all, or only some), or hang up.
 */

export type IvrAction =
  | { type: 'goto'; node: string }
  /** Empty lists = every buyer/target on the campaign. */
  | { type: 'route'; buyerIds?: string[]; targetIds?: string[] }
  | { type: 'hangup'; message?: string };

interface Base {
  id: string;
  /** Shown in reports ("Sales", "ZIP"). */
  name: string;
}

export interface MenuNode extends Base {
  type: 'menu';
  prompt: string;
  options: { digit: string; label: string; action: IvrAction }[];
  timeoutSec?: number;
  /** Times to ask again after no key or a wrong key. */
  retries?: number;
  invalidPrompt?: string;
  /** When the caller never picks a valid option. */
  fallback: IvrAction;
}

export interface CollectNode extends Base {
  type: 'collect';
  prompt: string;
  variable: string;
  minDigits: number;
  maxDigits: number;
  timeoutSec?: number;
  retries?: number;
  invalidPrompt?: string;
  next: IvrAction;
  fallback: IvrAction;
}

export interface SayNode extends Base {
  type: 'say';
  text: string;
  next: IvrAction;
}

export type IvrNode = MenuNode | CollectNode | SayNode;

export interface IvrFlow {
  enabled: boolean;
  start: string;
  nodes: IvrNode[];
}

export const IVR_LIMITS = { nodes: 50, options: 12, text: 500, retries: 5, timeoutSec: 30, digits: 20 };
/** Steps one call may take before it's ended (guards against message loops). */
export const IVR_MAX_STEPS = 60;

const DIGIT = /^[0-9*#]$/;
const VARIABLE = /^[a-z][a-z0-9_]{0,23}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns an error message, or null when the flow is valid. `buyers`/`targets` are the ids the tenant owns. */
export function validateIvr(flow: unknown, known: { buyers: Set<string>; targets: Set<string> }): string | null {
  if (flow === null || flow === undefined) return null;
  if (typeof flow !== 'object' || Array.isArray(flow)) return 'IVR must be an object';
  const f = flow as Partial<IvrFlow>;
  if (typeof f.enabled !== 'boolean') return 'IVR: "enabled" must be true or false';
  if (!Array.isArray(f.nodes) || f.nodes.length === 0) return 'IVR needs at least one step';
  if (f.nodes.length > IVR_LIMITS.nodes) return `IVR can have at most ${IVR_LIMITS.nodes} steps`;
  const ids = new Set<string>();
  for (const n of f.nodes) {
    if (!n || typeof n !== 'object' || !ID.test(String(n.id))) return 'Each IVR step needs an id (letters, numbers, - or _)';
    if (ids.has(n.id)) return `Two IVR steps have the id "${n.id}"`;
    ids.add(n.id);
  }
  if (!f.start || !ids.has(f.start)) return 'IVR: choose the first step';

  const text = (v: unknown, what: string) => (typeof v !== 'string' || !v.trim() ? `${what} is empty` : v.length > IVR_LIMITS.text ? `${what} is longer than ${IVR_LIMITS.text} characters` : null);
  const action = (a: unknown, where: string): string | null => {
    if (!a || typeof a !== 'object') return `${where}: choose what happens`;
    const x = a as IvrAction;
    if (x.type === 'goto') return ids.has(x.node) ? null : `${where}: goes to a step that doesn't exist`;
    if (x.type === 'hangup') return x.message === undefined || x.message === '' ? null : text(x.message, `${where}: goodbye message`);
    if (x.type === 'route') {
      for (const id of x.buyerIds ?? []) if (!UUID.test(id) || !known.buyers.has(id)) return `${where}: unknown buyer`;
      for (const id of x.targetIds ?? []) if (!UUID.test(id) || !known.targets.has(id)) return `${where}: unknown target`;
      return null;
    }
    return `${where}: unknown action`;
  };
  const common = (n: { timeoutSec?: number; retries?: number; invalidPrompt?: string }, where: string) => {
    if (n.timeoutSec !== undefined && (!Number.isInteger(n.timeoutSec) || n.timeoutSec < 1 || n.timeoutSec > IVR_LIMITS.timeoutSec)) return `${where}: wait time must be 1–${IVR_LIMITS.timeoutSec} seconds`;
    if (n.retries !== undefined && (!Number.isInteger(n.retries) || n.retries < 0 || n.retries > IVR_LIMITS.retries)) return `${where}: retries must be 0–${IVR_LIMITS.retries}`;
    if (n.invalidPrompt) return text(n.invalidPrompt, `${where}: "didn't catch that" message`);
    return null;
  };

  for (const n of f.nodes) {
    const where = `Step "${n.name || n.id}"`;
    if (typeof n.name !== 'string' || n.name.length > 60) return `${where}: name is too long`;
    if (n.type === 'menu') {
      const err = text(n.prompt, `${where}: prompt`) ?? common(n, where) ?? action(n.fallback, `${where} (no valid key)`);
      if (err) return err;
      if (!Array.isArray(n.options) || n.options.length === 0) return `${where}: add at least one key`;
      if (n.options.length > IVR_LIMITS.options) return `${where}: at most ${IVR_LIMITS.options} keys`;
      const digits = new Set<string>();
      for (const o of n.options) {
        if (!DIGIT.test(String(o?.digit))) return `${where}: keys are 0–9, * or #`;
        if (digits.has(o.digit)) return `${where}: key ${o.digit} is used twice`;
        digits.add(o.digit);
        if (typeof o.label !== 'string' || !o.label.trim() || o.label.length > 60) return `${where}: key ${o.digit} needs a short label`;
        const e = action(o.action, `${where}, key ${o.digit}`);
        if (e) return e;
      }
    } else if (n.type === 'collect') {
      const err = text(n.prompt, `${where}: prompt`) ?? common(n, where) ?? action(n.next, where) ?? action(n.fallback, `${where} (nothing entered)`);
      if (err) return err;
      if (!VARIABLE.test(String(n.variable))) return `${where}: field name must be lowercase letters, numbers or _ (e.g. zip)`;
      if (!Number.isInteger(n.minDigits) || !Number.isInteger(n.maxDigits) || n.minDigits < 1 || n.maxDigits < n.minDigits || n.maxDigits > IVR_LIMITS.digits) {
        return `${where}: digits must be between 1 and ${IVR_LIMITS.digits}, minimum ≤ maximum`;
      }
    } else if (n.type === 'say') {
      const err = text(n.text, `${where}: message`) ?? action(n.next, where);
      if (err) return err;
    } else {
      return `${where}: unknown step type`;
    }
  }
  return null;
}

/** Fills {campaign}, {caller}, {state}, {choice} and {ivr_<field>} in a whisper message. */
export function fillWhisper(text: string, v: { campaign?: string | null; caller: string; state?: string | null; choice?: string; data?: Record<string, string> }) {
  return text
    .replace(/\{(campaign|caller|state|choice|ivr_[a-z0-9_]+)\}/g, (_all, key: string) => {
      if (key === 'campaign') return v.campaign ?? '';
      if (key === 'caller') return v.caller.replace(/^\+1/, '').split('').join(' ');
      if (key === 'state') return v.state ?? 'unknown state';
      if (key === 'choice') return v.choice ?? '';
      // Digits are read one by one ("3 3 1 0 1"), not as a number.
      return (v.data?.[key.slice(4)] ?? '').split('').join(' ');
    })
    .trim()
    .slice(0, 500);
}
