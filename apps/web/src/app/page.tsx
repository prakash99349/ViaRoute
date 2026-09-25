'use client';

import { BarChart3, Hash, Palette, SearchX, Shuffle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ViaRouteLogo } from '@/components/brand';
import { IconTile, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const FEATURES = [
  { icon: Hash, title: 'Tracking numbers', text: 'Buy local and toll-free numbers in seconds and assign them to campaigns and publishers.' },
  { icon: Shuffle, title: 'Smart call routing', text: 'Route by geo, hours, caps and priority, with automatic failover so no call is lost.' },
  { icon: BarChart3, title: 'Real-time reporting', text: 'Live calls, recordings, conversions and profit per publisher, buyer and campaign.' },
  { icon: Palette, title: 'Your brand', text: 'Your own portal on your subdomain or custom domain, with your logo and colors.' },
];

export default function Home() {
  const { portal, portalError, user, loading } = useAuth();
  const router = useRouter();

  const isTenantPortal = !!portal && !portal.platform;
  useEffect(() => {
    if (loading) return;
    if (user) router.replace(user.role === 'SUPER_ADMIN' ? '/admin' : '/dashboard');
    else if (isTenantPortal) router.replace('/login');
  }, [loading, user, isTenantPortal, router]);

  if (portalError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <SearchX size={40} strokeWidth={1.5} className="text-faint" aria-hidden />
        <h1 className="text-2xl font-semibold">Portal not found</h1>
        <p className="text-muted">Check the address, or ask your account owner for the right link.</p>
      </div>
    );
  }
  if (loading || user || isTenantPortal) return <Spinner />;

  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between p-4 sm:p-6">
        <ViaRouteLogo />
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/login" className="rounded-lg px-3 py-2 hover:bg-foreground/5">Log in</Link>
          <Link href="/signup" className="rounded-lg bg-brand px-4 py-2 font-medium text-brand-contrast hover:opacity-90">Start free trial</Link>
        </nav>
      </header>

      <section className="mx-auto w-full max-w-4xl px-4 py-16 text-center sm:py-24">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
          Track, route and sell <span className="text-accent">every phone call</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted">
          The pay-per-call platform for affiliates, networks and lead buyers. Launch your own branded call portal in minutes.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Link href="/signup" className="rounded-lg bg-brand px-6 py-3 font-medium text-brand-contrast hover:opacity-90">Create your portal →</Link>
          <Link href="/login" className="rounded-lg border border-border px-6 py-3 font-medium hover:bg-foreground/5">Log in</Link>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 pb-24 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-xl border border-border bg-card p-6">
            <IconTile icon={f.icon} size={40} />
            <h3 className="mt-4 font-semibold">{f.title}</h3>
            <p className="mt-2 text-sm text-muted">{f.text}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
