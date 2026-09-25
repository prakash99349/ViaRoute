'use client';

import { useState } from 'react';
import { ArrowDown, Hash, ListTree, MessageSquare, Mic, Phone, Plus, Trash2 } from 'lucide-react';
import { Success } from './auth-card';
import { Alert, Badge, Button, Card, CardHeader, Field, IconButton, Select, Toggle } from './ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-api';

// Mirrors apps/api/src/routing/ivr.ts
type Action =
  | { type: 'goto'; node: string }
  | { type: 'route'; buyerIds?: string[]; targetIds?: string[] }
  | { type: 'hangup'; message?: string };

interface Option {
  digit: string;
  label: string;
  action: Action;
}

type Node =
  | { id: string; name: string; type: 'menu'; prompt: string; options: Option[]; timeoutSec?: number; retries?: number; invalidPrompt?: string; fallback: Action }
  | { id: string; name: string; type: 'collect'; prompt: string; variable: string; minDigits: number; maxDigits: number; timeoutSec?: number; retries?: number; invalidPrompt?: string; next: Action; fallback: Action }
  | { id: string; name: string; type: 'say'; text: string; next: Action };

export interface IvrFlow {
  enabled: boolean;
  start: string;
  nodes: Node[];
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];
const newId = () => `step_${Math.random().toString(36).slice(2, 8)}`;
const ALL: Action = { type: 'route' };

function starter(): IvrFlow {
  return {
    enabled: true,
    start: 'main',
    nodes: [
      {
        id: 'main',
        type: 'menu',
        name: 'Main menu',
        prompt: 'Thanks for calling. For a new quote, press 1. For an existing policy, press 2.',
        options: [
          { digit: '1', label: 'New quote', action: ALL },
          { digit: '2', label: 'Existing policy', action: ALL },
        ],
        retries: 2,
        invalidPrompt: "Sorry, I didn't get that.",
        fallback: ALL,
      },
    ],
  };
}

const TYPE_META = {
  menu: { label: 'Menu', icon: ListTree, hint: '“Press 1 for…”' },
  collect: { label: 'Collect digits', icon: Hash, hint: 'e.g. a ZIP code' },
  say: { label: 'Message', icon: MessageSquare, hint: 'Plays, then continues' },
} as const;

/** A campaign route: a buyer's main line or a target. */
export interface RouteRef {
  buyer: { id: string; name: string } | null;
  target: { id: string; name: string } | null;
}

interface Choice {
  id: string;
  name: string;
}

/** Editor for one action: go to a step, send to buyers (all or some), or hang up. */
function ActionEditor({ value, onChange, nodes, self, buyers, targets, label }: { value: Action; onChange: (a: Action) => void; nodes: Node[]; self: string; buyers: Choice[]; targets: Choice[]; label: string }) {
  const kind = value.type === 'route' ? ((value.buyerIds?.length || value.targetIds?.length) ? 'some' : 'all') : value.type;
  const picked = new Set([...(value.type === 'route' ? value.buyerIds ?? [] : []), ...(value.type === 'route' ? value.targetIds ?? [] : [])]);
  const toggle = (id: string, isTarget: boolean) => {
    if (value.type !== 'route') return;
    const key = isTarget ? 'targetIds' : 'buyerIds';
    const list = new Set(value[key] ?? []);
    if (list.has(id)) list.delete(id);
    else list.add(id);
    onChange({ ...value, [key]: [...list] });
  };

  return (
    <div className="space-y-2">
      <Select
        label={label}
        value={kind}
        onChange={(e) => {
          const k = e.target.value;
          if (k === 'all') onChange({ type: 'route' });
          else if (k === 'some') onChange({ type: 'route', buyerIds: buyers[0] ? [buyers[0].id] : [], targetIds: [] });
          else if (k === 'goto') onChange({ type: 'goto', node: nodes.find((n) => n.id !== self)?.id ?? self });
          else onChange({ type: 'hangup', message: 'Thanks for calling. Goodbye.' });
        }}
      >
        <option value="all">Send to buyers (all on this campaign)</option>
        <option value="some">Send to chosen buyers / targets only</option>
        <option value="goto">Go to another step</option>
        <option value="hangup">Hang up</option>
      </Select>
      {value.type === 'goto' && (
        <Select aria-label="Step" value={value.node} onChange={(e) => onChange({ type: 'goto', node: e.target.value })}>
          {nodes.map((n) => <option key={n.id} value={n.id}>{n.name || n.id}{n.id === self ? ' (this step again)' : ''}</option>)}
        </Select>
      )}
      {kind === 'some' && (
        <div className="flex flex-wrap gap-1.5">
          {[...buyers.map((b) => ({ ...b, t: false })), ...targets.map((t) => ({ ...t, t: true }))].map((c) => (
            <button
              type="button"
              key={c.id}
              aria-pressed={picked.has(c.id)}
              onClick={() => toggle(c.id, c.t)}
              className={`rounded-full border px-2.5 py-1 text-xs ${picked.has(c.id) ? 'border-foreground bg-subtle font-medium' : 'border-border text-muted hover:border-border-strong'}`}
            >
              {c.t ? '◎ ' : ''}{c.name}
            </button>
          ))}
          {!buyers.length && !targets.length && <span className="text-xs text-muted">Add buyers to the campaign first.</span>}
        </div>
      )}
      {value.type === 'hangup' && (
        <Field label="Goodbye message (optional)" value={value.message ?? ''} onChange={(e) => onChange({ type: 'hangup', message: e.target.value || undefined })} maxLength={500} />
      )}
    </div>
  );
}

function NodeCard({ node, flow, update, remove, buyers, targets }: { node: Node; flow: IvrFlow; update: (n: Node) => void; remove: () => void; buyers: Choice[]; targets: Choice[] }) {
  const meta = TYPE_META[node.type];
  const Icon = meta.icon;
  const start = flow.start === node.id;
  const actionProps = { nodes: flow.nodes, self: node.id, buyers, targets };
  const n = (v: string, fallback: number) => (v === '' ? fallback : Math.max(0, Math.round(Number(v))));

  return (
    <div className={`rounded-xl border p-4 ${start ? 'border-foreground/40' : 'border-border'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-subtle"><Icon size={15} aria-hidden /></span>
        <input
          aria-label="Step name"
          value={node.name}
          onChange={(e) => update({ ...node, name: e.target.value })}
          maxLength={60}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-semibold outline-none hover:border-border focus:border-border-strong"
        />
        <Badge>{meta.label}</Badge>
        {start && <Badge tone="blue">First step</Badge>}
        <IconButton icon={Trash2} aria-label={`Delete ${node.name}`} onClick={remove} disabled={flow.nodes.length === 1} className="h-8 w-8 hover:text-danger" />
      </div>

      <div className="mt-3 space-y-3">
        {node.type === 'say' ? (
          <>
            <Field label="Message" value={node.text} onChange={(e) => update({ ...node, text: e.target.value })} maxLength={500} />
            <ActionEditor label="Then" value={node.next} onChange={(a) => update({ ...node, next: a })} {...actionProps} />
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <label className="block text-[13px] font-medium" htmlFor={`p-${node.id}`}>What the caller hears</label>
              <textarea
                id={`p-${node.id}`}
                rows={2}
                value={node.prompt}
                maxLength={500}
                onChange={(e) => update({ ...node, prompt: e.target.value })}
                className="w-full rounded-lg border border-border-strong bg-card px-3 py-2 text-sm outline-none focus:border-foreground/40"
              />
            </div>

            {node.type === 'menu' ? (
              <div className="space-y-2">
                <div className="text-[13px] font-medium">Keys</div>
                {node.options.map((o, i) => (
                  <div key={i} className="grid gap-2 rounded-lg bg-subtle/50 p-3 sm:grid-cols-[80px_1fr_2fr_auto]">
                    <Select
                      aria-label="Key"
                      value={o.digit}
                      onChange={(e) => update({ ...node, options: node.options.map((x, j) => (j === i ? { ...x, digit: e.target.value } : x)) })}
                    >
                      {KEYS.map((k) => <option key={k} value={k} disabled={k !== o.digit && node.options.some((x) => x.digit === k)}>Press {k}</option>)}
                    </Select>
                    <input
                      aria-label="Label"
                      value={o.label}
                      maxLength={60}
                      placeholder="Label, e.g. Sales"
                      onChange={(e) => update({ ...node, options: node.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                      className="h-9 rounded-lg border border-border-strong bg-card px-3 text-sm outline-none focus:border-foreground/40"
                    />
                    <ActionEditor label="" value={o.action} onChange={(a) => update({ ...node, options: node.options.map((x, j) => (j === i ? { ...x, action: a } : x)) })} {...actionProps} />
                    <IconButton icon={Trash2} aria-label={`Remove key ${o.digit}`} disabled={node.options.length === 1} onClick={() => update({ ...node, options: node.options.filter((_, j) => j !== i) })} className="h-9 w-9 hover:text-danger" />
                  </div>
                ))}
                {node.options.length < 12 && (
                  <Button
                    type="button"
                    variant="subtle"
                    size="sm"
                    icon={Plus}
                    onClick={() => {
                      const digit = KEYS.find((k) => !node.options.some((o) => o.digit === k))!;
                      update({ ...node, options: [...node.options, { digit, label: '', action: ALL }] });
                    }}
                  >
                    Add key
                  </Button>
                )}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Save as field" value={node.variable} onChange={(e) => update({ ...node, variable: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} maxLength={24} hint={`Use {ivr_${node.variable || 'field'}} in whispers and postbacks.`} />
                <Field label="Min digits" type="number" min={1} max={20} value={node.minDigits} onChange={(e) => update({ ...node, minDigits: n(e.target.value, 1) })} />
                <Field label="Max digits" type="number" min={1} max={20} value={node.maxDigits} onChange={(e) => update({ ...node, maxDigits: n(e.target.value, 1) })} />
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Wait for keys (sec)" type="number" min={1} max={30} value={node.timeoutSec ?? ''} placeholder={node.type === 'menu' ? '6' : '10'} onChange={(e) => update({ ...node, timeoutSec: e.target.value ? n(e.target.value, 6) : undefined })} />
              <Field label="Ask again (times)" type="number" min={0} max={5} value={node.retries ?? ''} placeholder="2" onChange={(e) => update({ ...node, retries: e.target.value === '' ? undefined : n(e.target.value, 2) })} />
              <Field label="“Didn't catch that” message" value={node.invalidPrompt ?? ''} maxLength={500} placeholder="Sorry, I didn't get that." onChange={(e) => update({ ...node, invalidPrompt: e.target.value || undefined })} />
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              {node.type === 'collect' && <ActionEditor label="After a valid entry" value={node.next} onChange={(a) => update({ ...node, next: a })} {...actionProps} />}
              <ActionEditor label={node.type === 'menu' ? 'If no valid key' : 'If nothing valid is entered'} value={node.fallback} onChange={(a) => update({ ...node, fallback: a })} {...actionProps} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Phone menu builder for a campaign. */
export function IvrBuilder({ campaignId, initial, whisper, routes, onSaved }: { campaignId: string; initial: IvrFlow | null; whisper: string | null; routes: RouteRef[]; onSaved: () => void }) {
  const [flow, setFlow] = useState<IvrFlow>(initial ?? { ...starter(), enabled: false });
  const [whisperText, setWhisperText] = useState(whisper ?? '');
  const { busy, error, notice, run } = useAction();

  const buyers: Choice[] = [];
  const targets: Choice[] = [];
  for (const r of routes) {
    if (r.target) targets.push({ id: r.target.id, name: r.target.name });
    else if (r.buyer && !buyers.some((b) => b.id === r.buyer!.id)) buyers.push({ id: r.buyer.id, name: r.buyer.name });
  }

  const update = (n: Node) => setFlow((f) => ({ ...f, nodes: f.nodes.map((x) => (x.id === n.id ? n : x)) }));
  const remove = (id: string) =>
    setFlow((f) => {
      const nodes = f.nodes.filter((x) => x.id !== id);
      // Anything pointing at the removed step now sends to buyers.
      const fix = (a: Action): Action => (a.type === 'goto' && a.node === id ? ALL : a);
      return {
        ...f,
        start: f.start === id ? nodes[0].id : f.start,
        nodes: nodes.map((n) =>
          n.type === 'menu' ? { ...n, options: n.options.map((o) => ({ ...o, action: fix(o.action) })), fallback: fix(n.fallback) }
          : n.type === 'collect' ? { ...n, next: fix(n.next), fallback: fix(n.fallback) }
          : { ...n, next: fix(n.next) },
        ),
      };
    });
  const add = (type: Node['type']) => {
    const id = newId();
    const node: Node =
      type === 'menu' ? { id, type, name: 'New menu', prompt: 'Press 1 to continue.', options: [{ digit: '1', label: 'Continue', action: ALL }], fallback: ALL }
      : type === 'collect' ? { id, type, name: 'ZIP code', prompt: 'Please enter your 5 digit ZIP code.', variable: 'zip', minDigits: 5, maxDigits: 5, next: ALL, fallback: ALL }
      : { id, type, name: 'Message', text: 'Please hold while we connect you.', next: ALL };
    setFlow((f) => ({ ...f, nodes: [...f.nodes, node] }));
  };

  async function save() {
    const ok = await run(() => api(`/campaigns/${campaignId}`, { method: 'PATCH', json: { ivr: flow, whisperText: whisperText.trim() || null } }), 'Phone menu saved');
    if (ok) onSaved();
  }

  const ordered = [...flow.nodes].sort((a, b) => (a.id === flow.start ? -1 : b.id === flow.start ? 1 : 0));

  return (
    <Card>
      <CardHeader icon={Phone} title="IVR — phone menu" subtitle="Plays after the recording notice, before buyers are dialed. Callers choose with their keypad.">
        <Toggle label={flow.enabled ? 'On' : 'Off'} checked={flow.enabled} onChange={(v) => setFlow((f) => ({ ...f, enabled: v }))} />
      </CardHeader>
      <div className="mt-4 space-y-4">
        {error && <Alert>{error}</Alert>}
        {notice && <Success>{notice}</Success>}
        {!flow.enabled && <p className="text-sm text-muted">Off: calls go straight to buyers. Build the menu below and switch it on when ready.</p>}

        <div className="w-64">
          <Select label="First step" value={flow.start} onChange={(e) => setFlow((f) => ({ ...f, start: e.target.value }))}>
            {flow.nodes.map((n) => <option key={n.id} value={n.id}>{n.name || n.id}</option>)}
          </Select>
        </div>

        <div className="space-y-3">
          {ordered.map((n, i) => (
            <div key={n.id}>
              {i > 0 && <div className="flex justify-center py-1 text-faint"><ArrowDown size={14} aria-hidden /></div>}
              <NodeCard node={n} flow={flow} update={update} remove={() => remove(n.id)} buyers={buyers} targets={targets} />
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {(Object.keys(TYPE_META) as Node['type'][]).map((t) => (
            <Button key={t} type="button" variant="secondary" size="sm" icon={Plus} onClick={() => add(t)} disabled={flow.nodes.length >= 50}>
              {TYPE_META[t].label} <span className="text-xs font-normal text-muted">· {TYPE_META[t].hint}</span>
            </Button>
          ))}
        </div>

        <div className="rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 text-sm font-semibold"><Mic size={15} aria-hidden /> Buyer whisper</div>
          <p className="mt-1 text-xs text-muted">The buyer hears this before being connected (the caller doesn&apos;t). Works with or without the menu.</p>
          <div className="mt-3">
            <Field
              label="Whisper message (optional)"
              value={whisperText}
              maxLength={500}
              onChange={(e) => setWhisperText(e.target.value)}
              placeholder="e.g. Auto insurance call from {state}, {choice}"
              hint="Placeholders: {campaign} {state} {caller} {choice} and {ivr_<field>}, e.g. {ivr_zip}."
            />
          </div>
        </div>

        <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save phone menu'}</Button>
      </div>
    </Card>
  );
}
