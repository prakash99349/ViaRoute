'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Ban, Bell, BellOff, CreditCard, Gauge, Wallet, type LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { IconTile } from './ui';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

const KIND: Record<string, { icon: LucideIcon; tone: 'yellow' | 'red' | 'green' | 'gray' }> = {
  low_balance: { icon: Wallet, tone: 'yellow' },
  cap_reached: { icon: Gauge, tone: 'yellow' },
  payment: { icon: CreditCard, tone: 'green' },
  suspended: { icon: Ban, tone: 'red' },
};

function ago(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Bell with unread dot; polls every 30 seconds. */
export function NotificationBell() {
  const [data, setData] = useState<{ items: Notification[]; unread: number }>({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<{ items: Notification[]; unread: number }>('/notifications').then(setData).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && data.unread) {
      await api('/notifications/read-all', { method: 'POST' }).catch(() => {});
      setData((d) => ({ ...d, unread: 0 }));
    }
  }

  return (
    <div ref={box} className="relative">
      <button
        onClick={toggle}
        aria-expanded={open}
        aria-label={`Notifications${data.unread ? ` (${data.unread} unread)` : ''}`}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-foreground"
      >
        <Bell size={18} strokeWidth={1.75} aria-hidden />
        {data.unread > 0 && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-danger ring-2 ring-card" aria-hidden />}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-96 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border bg-card shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold">Notifications</span>
            <span className="text-xs text-faint">Last 30</span>
          </div>
          <div className="max-h-[26rem] overflow-y-auto">
            {data.items.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted">
                <BellOff size={22} strokeWidth={1.75} className="text-faint" aria-hidden />
                You&apos;re all caught up.
              </div>
            )}
            {data.items.map((n) => {
              const kind = KIND[n.type] ?? { icon: Bell, tone: 'gray' as const };
              const inner = (
                <div className="flex gap-3 px-4 py-3 text-sm">
                  <IconTile icon={kind.icon} tone={kind.tone} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <span className="flex-1 font-medium">{n.title}</span>
                      {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-series-1" aria-label="Unread" />}
                    </div>
                    {n.body && <div className="mt-0.5 text-xs text-muted">{n.body}</div>}
                    <div className="mt-1 text-[11px] text-faint">{ago(n.createdAt)}</div>
                  </div>
                </div>
              );
              return n.link ? (
                <Link key={n.id} href={n.link} onClick={() => setOpen(false)} className="block border-b border-border last:border-0 hover:bg-subtle/60">
                  {inner}
                </Link>
              ) : (
                <div key={n.id} className="border-b border-border last:border-0">{inner}</div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
