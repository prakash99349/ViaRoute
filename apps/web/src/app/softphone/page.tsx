'use client';

import Link from 'next/link';
import { Headphones, PhoneIncoming, Timer } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { Card, CardHeader, Empty, PageHeader, Stat, StatStrip, table } from '@/components/ui';
import { duration, formatPhone, shortDateTime } from '@/lib/api';
import { useApi } from '@/lib/use-api';

interface CallRow {
  id: string;
  startedAt: string;
  callerNumber: string;
  callerState: string | null;
  status: string;
  connectedSec: number;
  campaign: { name: string } | null;
  ivrPath?: string | null;
}

/** An agent's home: the softphone (bottom right) and today's calls. */
function SoftphoneContent() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const { data } = useApi<{ items: CallRow[]; total: number }>(`/calls?from=${since.toISOString()}&pageSize=50`);
  const talked = data?.items.reduce((s, c) => s + c.connectedSec, 0) ?? 0;

  return (
    <div className="w-full space-y-5">
      <PageHeader icon={Headphones} title="Softphone" subtitle="Set yourself Available in the softphone (bottom right) to take calls. Keep this tab open." />
      <StatStrip cols={2}>
        <Stat icon={PhoneIncoming} label="Calls today" value={data ? data.total : '—'} />
        <Stat icon={Timer} label="Talk time today" value={data ? duration(talked) : '—'} />
      </StatStrip>
      <Card flush className="overflow-hidden">
        <CardHeader title="Today's calls" className="px-5 pt-5">
          <Link href="/calls" className="text-[13px] font-medium text-accent">All my calls →</Link>
        </CardHeader>
        <div className="mt-4 overflow-x-auto">
          {data?.items.length === 0 ? (
            <Empty icon={Headphones} title="No calls yet today" text="Calls you answer show up here." />
          ) : (
            <table className={`${table.wrap} min-w-[640px]`}>
              <thead className={table.head}>
                <tr>
                  <th>When</th>
                  <th>Caller</th>
                  <th>Campaign</th>
                  <th>IVR</th>
                  <th className="text-right">Talk</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((c) => (
                  <tr key={c.id} className={table.row}>
                    <td className="whitespace-nowrap text-xs text-muted">{shortDateTime(c.startedAt)}</td>
                    <td className="whitespace-nowrap font-mono">{/^\+\d+$/.test(c.callerNumber) ? formatPhone(c.callerNumber) : c.callerNumber}{c.callerState && <span className="ml-1.5 font-sans text-xs text-faint">{c.callerState}</span>}</td>
                    <td className="max-w-[200px] truncate">{c.campaign?.name ?? '—'}</td>
                    <td className="max-w-[240px] truncate text-xs text-muted">{c.ivrPath ?? '—'}</td>
                    <td className="text-right font-mono tabular">{duration(c.connectedSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

export default function SoftphonePage() {
  return (
    <AppShell allow={['AGENT', 'TENANT_ADMIN', 'MANAGER']}>
      <SoftphoneContent />
    </AppShell>
  );
}
