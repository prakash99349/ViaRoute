'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  Briefcase, Crown, Headphones, Mic, CreditCard, Crosshair, FileSpreadsheet, Hash, LayoutDashboard, LifeBuoy, LogOut, Megaphone, Menu, Network, PauseCircle, Phone, Plus, Radio, Search,
  Settings, ShieldAlert, Tag, Target, Users, Wallet, X, type LucideIcon,
} from 'lucide-react';
import { api, money } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { homeFor, type Role } from '@/lib/types';
import { useDocumentBrand, ViaRouteMark } from './brand';
import { EmailBanner } from './email-banner';
import { Softphone } from './softphone';
import { NotificationBell } from './notification-bell';
import { IconButton, Spinner } from './ui';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Only these roles see the item (default: everyone). */
  roles?: Role[];
  badge?: 'live';
  /** Also shown to in-house agents (who otherwise see only their softphone). */
  agent?: boolean;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const STAFF: Role[] = ['TENANT_ADMIN', 'MANAGER'];

const TENANT_NAV: NavGroup[] = [
  {
    items: [
      { href: '/softphone', label: 'Softphone', icon: Headphones, roles: ['AGENT'] },
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/live', label: 'Live calls', icon: Radio, badge: 'live' },
      { href: '/calls', label: 'Call logs', icon: Phone, agent: true },
      { href: '/recordings', label: 'Recordings', icon: Mic, roles: ['TENANT_ADMIN', 'MANAGER', 'BUYER'], agent: true },
      { href: '/reports', label: 'Reports', icon: FileSpreadsheet },
    ],
  },
  {
    label: 'Set up',
    items: [
      { href: '/campaigns', label: 'Campaigns', icon: Target, roles: STAFF },
      { href: '/numbers', label: 'Phone numbers', icon: Hash, roles: STAFF },
      { href: '/publishers', label: 'Publishers', icon: Megaphone, roles: STAFF },
      { href: '/buyers', label: 'Buyers', icon: Briefcase, roles: STAFF },
      { href: '/targets', label: 'Targets', icon: Crosshair, roles: STAFF },
      { href: '/agents', label: 'Agents', icon: Headphones, roles: STAFF },
      { href: '/spam', label: 'Spam & blocking', icon: ShieldAlert, roles: STAFF },
    ],
  },
  {
    label: 'Account',
    items: [
      { href: '/billing', label: 'Billing', icon: CreditCard, roles: ['TENANT_ADMIN'] },
      { href: '/team', label: 'Team', icon: Users, roles: STAFF },
      { href: '/settings', label: 'Settings', icon: Settings, agent: true },
    ],
  },
];

const ADMIN_NAV: NavGroup[] = [
  {
    items: [
      { href: '/admin', label: 'Customers', icon: Crown },
      { href: '/admin/carriers', label: 'Carriers', icon: Network },
      { href: '/admin/spam', label: 'Spam protection', icon: ShieldAlert },
      { href: '/admin/plans', label: 'Plans', icon: Tag },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

/** Bottom tabs on phones. */
const MOBILE_TABS: NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/softphone', label: 'Phone', icon: Headphones, roles: ['AGENT'] },
  { href: '/live', label: 'Live', icon: Radio },
  { href: '/calls', label: 'Calls', icon: Phone, agent: true },
  { href: '/campaigns', label: 'Campaigns', icon: Target, roles: STAFF },
];

/** Agents see only items marked for them; everyone else sees items without a role list or with their role. */
function visible(i: NavItem, role: Role) {
  if (role === 'AGENT') return !!i.agent || !!i.roles?.includes('AGENT');
  return !i.roles || i.roles.includes(role);
}

function isActive(path: string, href: string) {
  if (href === '/admin') return path === href || path.startsWith('/admin/customers/');
  return path === href || path.startsWith(`${href}/`);
}

function initialsOf(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
}

interface TenantInfo {
  walletBalance: string;
  plan: { name: string } | null;
  status?: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  suspendReason?: string | null;
}

/** Authenticated layout: guards the page, applies portal branding, renders the navigation. */
export function AppShell({ children, allow }: { children: ReactNode; allow: Role[] }) {
  const { user, portal, loading, logout } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [liveCount, setLiveCount] = useState(0);

  const allowed = !!user && allow.includes(user.role);
  const isAdmin = user?.role === 'SUPER_ADMIN';
  const staff = !!user && STAFF.includes(user.role);

  useEffect(() => {
    // Signed in but not allowed here → their own home page (not the login page, which would send them back).
    if (!loading && !allowed) router.replace(user ? homeFor(user.role) : '/login');
  }, [loading, allowed, router, user]);

  // Plan + wallet for the sidebar, live-call count for the nav badge.
  useEffect(() => {
    if (!allowed || !staff) return;
    let stop = false;
    api<TenantInfo>('/tenant').then((t) => !stop && setTenant(t)).catch(() => {});
    const tick = () => api<unknown[]>('/calls/live').then((r) => !stop && setLiveCount(r.length)).catch(() => {});
    tick();
    const t = setInterval(tick, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [allowed, staff, path]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- close the phone menu after navigating
  useEffect(() => setDrawer(false), [path]);

  // Tab title: the page's nav label, then the portal (or ViaRoute) name.
  const pageLabel = [...ADMIN_NAV, ...TENANT_NAV].flatMap((g) => g.items).find((i) => isActive(path, i.href))?.label;
  useDocumentBrand(pageLabel, portal && !portal.platform ? portal : null);

  if (loading || !allowed) return <Spinner />;

  const groups = (isAdmin ? ADMIN_NAV : TENANT_NAV)
    .map((g) => ({ ...g, items: g.items.filter((i) => visible(i, user.role)) }))
    .filter((g) => g.items.length);
  const title = isAdmin ? 'ViaRoute' : portal?.branding?.portalName ?? portal?.name ?? 'Portal';
  const subtitle = isAdmin ? 'Platform admin' : tenant?.plan ? `${tenant.plan.name} plan` : user.role === 'PUBLISHER' ? 'Publisher' : user.role === 'BUYER' ? 'Buyer' : '';
  const brandStyle = portal?.branding?.primaryColor ? ({ '--brand': portal.branding.primaryColor, '--brand-contrast': '#ffffff' } as CSSProperties) : undefined;
  const tabs = MOBILE_TABS.filter((t) => !isAdmin && visible(t, user.role));

  const logo = isAdmin ? (
    <ViaRouteMark size={32} />
  ) : portal?.branding?.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- tenant-uploaded logo (data URL)
    <img src={portal.branding.logoUrl} alt="" className="h-8 w-8 rounded-lg object-contain" />
  ) : (
    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-brand-contrast">
      <Phone size={16} strokeWidth={2.2} aria-hidden />
    </span>
  );

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    router.push(q ? `/calls?q=${encodeURIComponent(q)}` : '/calls');
  }

  const sidebar = (
    <div className="flex h-full flex-col px-3.5 pb-4 pt-4">
      <div className="flex items-center gap-2.5 px-2 pb-5">
        {logo}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{title}</div>
          {subtitle && <div className="truncate text-xs text-faint">{subtitle}</div>}
        </div>
      </div>

      <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto">
        {groups.map((g, gi) => (
          <div key={gi} className="space-y-0.5">
            {g.label && <div className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{g.label}</div>}
            {g.items.map((item) => {
              const active = isActive(path, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm transition ${
                    active ? 'bg-subtle font-semibold text-foreground' : 'font-medium text-muted hover:bg-subtle/70 hover:text-foreground'
                  }`}
                >
                  <Icon size={18} strokeWidth={active ? 2 : 1.75} aria-hidden />
                  <span className="flex-1">{item.label}</span>
                  {item.badge === 'live' && liveCount > 0 && (
                    <span className="flex items-center gap-1 font-mono text-xs font-semibold text-success" title={`${liveCount} live calls`}>
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" aria-hidden />
                      {liveCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {user.role === 'TENANT_ADMIN' && tenant && (
        <div className="mt-4 space-y-2.5 rounded-xl border border-border p-3.5">
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Wallet size={15} strokeWidth={1.75} aria-hidden />
            Wallet
          </div>
          <div className={`font-mono text-xl font-semibold tracking-tight tabular ${Number(tenant.walletBalance) <= 0 ? 'text-danger' : ''}`}>{money(tenant.walletBalance)}</div>
          {Number(tenant.walletBalance) <= 0 && <div className="text-xs text-danger">Calls are paused until you add funds</div>}
          <Link href="/billing" className="flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border-strong text-[13px] font-medium hover:bg-subtle">
            <Plus size={14} strokeWidth={2} aria-hidden />
            Add funds
          </Link>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2.5 px-1.5 pt-1">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-semibold text-muted">{initialsOf(user.name)}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{user.name}</div>
          <div className="truncate text-xs text-faint">{user.email}</div>
        </div>
        <IconButton icon={LogOut} aria-label="Log out" onClick={logout} className="h-8 w-8" />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen flex-1" style={brandStyle}>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-border bg-card lg:block">{sidebar}</aside>

      {/* Phone / tablet drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/30" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border bg-card shadow-xl">
            <IconButton icon={X} aria-label="Close menu" onClick={() => setDrawer(false)} className="absolute right-2 top-3" />
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card/95 px-3 backdrop-blur sm:px-6 lg:px-8">
          <IconButton icon={Menu} aria-label="Open menu" onClick={() => setDrawer(true)} className="lg:hidden" />
          <span className="truncate text-sm font-semibold lg:hidden">{title}</span>
          {!isAdmin && (
            <form onSubmit={search} role="search" className="hidden h-9 w-full max-w-sm items-center gap-2.5 rounded-lg bg-subtle px-3 text-sm text-faint md:flex">
              <Search size={16} strokeWidth={1.75} aria-hidden />
              <input name="q" aria-label="Search calls by caller number" placeholder="Search calls by caller number…" className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-faint" />
            </form>
          )}
          <span className="flex-1" />
          <a
            href="mailto:support@viaroute.com"
            aria-label="Help"
            title="Help"
            className="hidden h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-foreground sm:inline-flex"
          >
            <LifeBuoy size={18} strokeWidth={1.75} aria-hidden />
          </a>
          {staff && <NotificationBell />}
        </header>

        <main className="min-w-0 flex-1 px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pb-10 lg:pt-7">
          {user.impersonatedBy && (
            <div className="mb-5 flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-300 bg-violet-50 px-4 py-2.5 text-sm text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200">
              <span className="flex items-center gap-2">
                <LifeBuoy size={16} aria-hidden /> Support mode: {user.impersonatedBy} is viewing this account as {user.name}. Actions are logged.
              </span>
              <button onClick={logout} className="font-medium underline">End support session</button>
            </div>
          )}
          {tenant?.status === 'SUSPENDED' && (
            <div role="alert" className="mb-5 flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger-bg px-4 py-2.5 text-sm text-danger">
              <span className="flex items-center gap-2">
                <PauseCircle size={16} aria-hidden />
                <b className="font-semibold">Account paused.</b>
                {tenant.suspendReason ?? 'Your monthly payment could not be taken. Add funds to your wallet to reactivate.'} Calls are not being routed.
              </span>
              {!tenant.suspendReason && user.role === 'TENANT_ADMIN' && <Link href="/billing" className="font-medium underline">Add funds</Link>}
            </div>
          )}
          {!user.emailVerified && !user.impersonatedBy && <EmailBanner />}
          {children}
        </main>
        {(user.role === 'TENANT_ADMIN' || user.role === 'MANAGER' || user.role === 'AGENT') && <Softphone />}
      </div>

      {/* Phone bottom tabs */}
      {!isAdmin && (
        <nav aria-label="Quick" className="fixed inset-x-0 bottom-0 z-30 grid h-16 border-t border-border bg-card lg:hidden" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
          {tabs.map((t) => {
            const active = isActive(path, t.href);
            const Icon = t.icon;
            return (
              <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined} className={`flex flex-col items-center justify-center gap-1 text-[11px] ${active ? 'font-semibold text-foreground' : 'font-medium text-faint'}`}>
                <Icon size={20} strokeWidth={active ? 2 : 1.75} aria-hidden />
                {t.label}
              </Link>
            );
          })}
          <button onClick={() => setDrawer(true)} className="flex flex-col items-center justify-center gap-1 text-[11px] font-medium text-faint">
            <Menu size={20} strokeWidth={1.75} aria-hidden />
            More
          </button>
        </nav>
      )}
    </div>
  );
}
