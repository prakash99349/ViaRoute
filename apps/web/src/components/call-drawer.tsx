'use client';

import { Ban, Download, Mic, Webhook } from 'lucide-react';
import { api, API_BASE, duration, formatPhone, money } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useApi } from '@/lib/use-api';
import { Success } from './auth-card';
import { Alert, Badge, Button, Modal, Spinner } from './ui';

export interface CallRow {
  id: string;
  startedAt: string;
  callerNumber: string;
  callerState: string | null;
  dialedNumber: string | null;
  status: 'RINGING' | 'IN_PROGRESS' | 'COMPLETED' | 'NO_ANSWER' | 'REJECTED' | 'FAILED';
  rejectReason: string | null;
  duplicate: boolean;
  attempts: number;
  durationSec: number;
  connectedSec: number;
  converted: boolean;
  hasRecording: boolean;
  provider: string;
  campaign: { id: string; name: string; convertAfterSeconds?: number } | null;
  numberLabel?: string | null;
  answeredAt?: string | null;
  publisher: { id: string; name: string } | null;
  buyer: { id: string; name: string } | null;
  target?: { id: string; name: string } | null;
  attestation?: string | null;
  spamScore?: number | null;
  lineType?: string | null;
  ivrPath?: string | null;
  ivrData?: Record<string, string> | null;
  revenue?: string;
  payout?: string;
  cost?: string;
  profit?: string;
}

export interface CallDetail extends CallRow {
  hangupCause: string | null;
  recordingLink: string | null;
  recordingDownload?: string | null;
  recordingDeletedAt?: string | null;
  endedAt: string | null;
  postbacks: { id: string; url: string; statusCode: number | null; attempts: number; lastError: string | null; succeededAt: string | null }[];
}

export const STATUS: Record<CallRow['status'], { label: string; tone: 'green' | 'yellow' | 'red' | 'gray' }> = {
  RINGING: { label: 'Ringing', tone: 'yellow' },
  IN_PROGRESS: { label: 'Live', tone: 'green' },
  COMPLETED: { label: 'Completed', tone: 'gray' },
  NO_ANSWER: { label: 'Not connected', tone: 'red' },
  REJECTED: { label: 'Rejected', tone: 'red' },
  FAILED: { label: 'Failed', tone: 'red' },
};

export const REASONS: Record<string, string> = {
  no_buyer_available: 'No buyer available',
  sent_to_fallback: 'Sent to fallback',
  blocked_caller: 'Blocked caller',
  no_balance: 'Wallet empty',
  campaign_paused: 'Campaign paused',
  number_not_assigned: 'Number not on a campaign',
  account_suspended: 'Account suspended',
  account_limit: 'Account call limit reached',
  carrier_disabled: 'Carrier turned off',
  spam_global_block: 'Spam: known spammer',
  spam_anonymous: 'Spam: hidden caller ID',
  spam_prefix: 'Spam: blocked prefix',
  spam_rate_limit: 'Spam: called too often',
  spam_attestation: 'Spam: caller ID not verified',
  spam_reputation: 'Spam: high spam score',
};

/** Call details dialog: route, money, recording player, postbacks, block caller. */
export function CallDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const { data: c, reload } = useApi<CallDetail>(`/calls/${id}`);
  const act = useAction();
  const staff = user?.role === 'TENANT_ADMIN' || user?.role === 'MANAGER';

  return (
    <Modal wide title="Call details" onClose={onClose}>
      {!c ? (
        <Spinner />
      ) : (
        <div className="space-y-5 text-sm">
          {act.error && <Alert>{act.error}</Alert>}
          {act.notice && <Success>{act.notice}</Success>}
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg font-semibold">{formatPhone(c.callerNumber)}</span>
            {c.callerState && <Badge>{c.callerState}</Badge>}
            <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
            {c.converted && <Badge tone="green">Converted</Badge>}
            {c.duplicate && <Badge tone="yellow">Repeat caller</Badge>}
            {c.provider === 'simulator' && <Badge>Test call</Badge>}
          </div>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {[
              ['Started', new Date(c.startedAt).toLocaleString()],
              ['Tracking number', c.dialedNumber ? formatPhone(c.dialedNumber) : '—'],
              ['Campaign', c.campaign?.name ?? '—'],
              ['Publisher', c.publisher?.name ?? '—'],
              ['Buyer', c.buyer?.name ?? (c.target ? 'Direct (no buyer)' : '—')],
              ...(c.target ? [['Target', c.target.name] as [string, string]] : []),
              ...(c.ivrPath ? [['IVR choices', c.ivrPath] as [string, string]] : []),
              ...(c.ivrData && Object.keys(c.ivrData).length ? [['IVR entries', Object.entries(c.ivrData).map(([k, v]) => `${k}: ${v}`).join(', ')] as [string, string]] : []),
              ...(c.attestation ? [['Caller ID check', `STIR/SHAKEN grade ${c.attestation}`] as [string, string]] : []),
              ...(c.spamScore !== null && c.spamScore !== undefined ? [['Spam score', `${c.spamScore} / 100${c.lineType ? ` · ${c.lineType.replace(/_/g, ' ')}` : ''}`] as [string, string]] : []),
              ['Buyers tried', c.attempts],
              ['Call length', duration(c.durationSec)],
              ['Talk time with buyer', duration(c.connectedSec)],
              ['Outcome', c.rejectReason ? REASONS[c.rejectReason] ?? c.rejectReason : c.hangupCause ?? '—'],
              ...(c.revenue !== undefined ? [['Revenue', money(c.revenue)]] : []),
              ...(c.payout !== undefined ? [['Payout', money(c.payout)]] : []),
              ...(c.cost !== undefined ? [['Usage cost', money(c.cost)]] : []),
              ...(c.profit !== undefined ? [['Profit', money(c.profit)]] : []),
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between gap-3 border-b border-border py-1.5">
                <dt className="text-muted">{k}</dt>
                <dd className="text-right font-medium">{v}</dd>
              </div>
            ))}
          </dl>

          <div>
            <h3 className="mb-2 flex items-center gap-2 font-semibold"><Mic size={16} strokeWidth={1.75} className="text-faint" aria-hidden />Recording</h3>
            {c.recordingLink ? (
              <div className="space-y-2">
                <audio controls preload="none" className="w-full" src={`${API_BASE}${c.recordingLink}`} />
                {c.recordingDownload && (
                  <a href={`${API_BASE}${c.recordingDownload}`} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent">
                    <Download size={14} aria-hidden /> Download recording
                  </a>
                )}
              </div>
            ) : (
              <p className="text-muted">{c.recordingDeletedAt ? `Recording deleted on ${new Date(c.recordingDeletedAt).toLocaleDateString()}.` : 'No recording for this call.'}</p>
            )}
          </div>

          {c.postbacks.length > 0 && (
            <div>
              <h3 className="mb-2 flex items-center gap-2 font-semibold"><Webhook size={16} strokeWidth={1.75} className="text-faint" aria-hidden />Postbacks</h3>
              <ul className="space-y-2">
                {c.postbacks.map((p) => (
                  <li key={p.id} className="rounded-lg border border-border p-3">
                    <div className="break-all font-mono text-xs">{p.url}</div>
                    <div className="mt-1 flex items-center gap-3 text-xs">
                      {p.succeededAt ? <Badge tone="green">Delivered ({p.statusCode})</Badge> : <Badge tone="red">{p.lastError ?? 'Pending'}</Badge>}
                      <span className="text-muted">{p.attempts} attempt{p.attempts === 1 ? '' : 's'}</span>
                      {!p.succeededAt && staff && (
                        <button className="font-medium text-accent" onClick={() => act.run(() => api(`/calls/postbacks/${p.id}/retry`, { method: 'POST' }), 'Retry queued').then(() => setTimeout(reload, 1500))}>
                          Retry now
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {staff && (
            <div className="flex justify-end">
              <Button
                variant="secondary"
                icon={Ban}
                onClick={() =>
                  confirm(`Block ${formatPhone(c.callerNumber)}? Their future calls will be rejected.`) &&
                  act.run(() => api(`/calls/${c.id}/block-caller`, { method: 'POST' }), 'Caller blocked').then(onChanged)
                }
              >
                Block this caller
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
