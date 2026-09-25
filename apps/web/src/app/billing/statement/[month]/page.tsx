'use client';

import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import { money } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';

interface Statement {
  month: string;
  tenant: { name: string; subdomain: string };
  openingBalance: string | number;
  closingBalance: string | number;
  totals: Record<string, string>;
  transactions: { id: string; type: string; amount: string; balanceAfter: string; description: string | null; createdAt: string }[];
}

const TYPE_LABEL: Record<string, string> = {
  TOPUP: 'Top-ups', SUBSCRIPTION: 'Plan', CALL_USAGE: 'Call usage', NUMBER_RENTAL: 'Number rental',
  RECORDING: 'Recordings', ADJUSTMENT: 'Adjustments', REFUND: 'Refunds',
};

/** Printable monthly statement (use the browser's "Save as PDF"). */
function StatementContent() {
  const { month } = useParams<{ month: string }>();
  const { portal } = useAuth();
  const { data: s, error } = useApi<Statement>(`/billing/statements/${month}`);
  if (error) return <Alert>{error}</Alert>;
  if (!s) return <Spinner />;

  const monthName = new Date(`${s.month}-01T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link href="/billing" className="text-sm text-muted hover:text-foreground"><span className="inline-flex items-center gap-1.5"><ArrowLeft size={14} aria-hidden />Billing</span></Link>
        <Button icon={Printer} onClick={() => window.print()}>Print / Save as PDF</Button>
      </div>
      <Card className="print:border-0 print:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted">{portal?.branding?.portalName ?? 'ViaRoute'}</div>
            <h1 className="text-2xl font-semibold">Statement — {monthName}</h1>
            <div className="text-sm text-muted">{s.tenant.name}</div>
          </div>
          <div className="text-right text-sm">
            <div className="text-muted">Opening balance</div>
            <div className="font-semibold">{money(s.openingBalance)}</div>
            <div className="mt-2 text-muted">Closing balance</div>
            <div className="text-lg font-semibold">{money(s.closingBalance)}</div>
          </div>
        </div>

        <h2 className="mt-5 font-semibold">Summary</h2>
        <table className="mt-2 w-full text-sm">
          <tbody>
            {Object.entries(s.totals).map(([k, v]) => (
              <tr key={k} className="border-b border-border">
                <td className="py-2">{TYPE_LABEL[k] ?? k}</td>
                <td className="py-2 text-right tabular-nums">{Number(v) > 0 ? '+' : '−'}{money(Math.abs(Number(v)))}</td>
              </tr>
            ))}
            {!Object.keys(s.totals).length && (
              <tr><td className="py-2 text-muted">No activity this month.</td></tr>
            )}
          </tbody>
        </table>

        <h2 className="mt-6 font-semibold">Details</h2>
        <table className="mt-2 w-full text-xs">
          <thead className="text-left text-muted">
            <tr className="border-b border-border">
              <th className="py-2">Date</th>
              <th className="py-2">Description</th>
              <th className="py-2 text-right">Amount</th>
              <th className="py-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {s.transactions.map((t) => (
              <tr key={t.id} className="border-b border-border">
                <td className="whitespace-nowrap py-1.5 pr-3">{new Date(t.createdAt).toLocaleDateString()}</td>
                <td className="py-1.5 pr-3">{t.description ?? TYPE_LABEL[t.type]}</td>
                <td className="py-1.5 text-right tabular-nums">{Number(t.amount) > 0 ? '+' : '−'}{money(Math.abs(Number(t.amount)))}</td>
                <td className="py-1.5 text-right tabular-nums">{money(t.balanceAfter)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export default function StatementPage() {
  return (
    <AppShell allow={['TENANT_ADMIN']}>
      <StatementContent />
    </AppShell>
  );
}
