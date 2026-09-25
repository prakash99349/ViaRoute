import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

export type { LucideIcon };

/** `flush` removes the padding (for full-width tables and lists). */
export function Card({ children, className = '', flush }: { children: ReactNode; className?: string; flush?: boolean }) {
  return <div className={`min-w-0 rounded-xl border border-border bg-card ${flush ? '' : 'p-5'} ${className}`}>{children}</div>;
}

/** Card title row: heading on the left, optional actions on the right. */
export function CardHeader({ title, subtitle, children, icon: Icon, className = '' }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode; icon?: LucideIcon; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      {Icon && <Icon size={17} strokeWidth={1.75} className="text-faint" aria-hidden />}
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger';

export function Button({
  className = '',
  variant = 'primary',
  icon: Icon,
  size = 'md',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: LucideIcon; size?: 'sm' | 'md' }) {
  const styles = {
    primary: 'bg-brand text-brand-contrast hover:opacity-90',
    secondary: 'border border-border-strong bg-card hover:bg-subtle',
    ghost: 'border border-border-strong bg-card hover:bg-subtle', // same as secondary (kept for existing call sites)
    subtle: 'text-muted hover:bg-subtle hover:text-foreground',
    danger: 'bg-danger text-white hover:opacity-90',
  }[variant];
  const sizing = size === 'sm' ? 'h-8 px-2.5 text-xs gap-1.5' : 'h-9 px-3.5 text-[13px] gap-2';
  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition disabled:pointer-events-none disabled:opacity-50 ${sizing} ${styles} ${className}`}
      {...props}
    >
      {Icon && <Icon size={size === 'sm' ? 14 : 16} strokeWidth={1.9} aria-hidden />}
      {children}
    </button>
  );
}

/** Square icon-only button. Always pass an aria-label. */
export function IconButton({ icon: Icon, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; 'aria-label': string }) {
  return (
    <button className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-subtle hover:text-foreground ${className}`} {...props}>
      <Icon size={18} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

const inputCls =
  'w-full rounded-lg border border-border-strong bg-card px-3 py-2 text-sm outline-none transition placeholder:text-faint focus:border-foreground/40 focus:ring-4 focus:ring-foreground/5';

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium">{label}</label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={inputCls} {...props} />
      {hint && <span id={`${id}-hint`} className="block text-xs text-muted">{hint}</span>}
    </div>
  );
}

export function Select({ label, hint, children, className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label?: string; hint?: ReactNode }) {
  const id = useId();
  const select = (
    <select id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={`${inputCls} h-9 py-0 ${className}`} {...props}>
      {children}
    </select>
  );
  if (!label) return select;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium">{label}</label>
      {select}
      {hint && <span id={`${id}-hint`} className="block text-xs text-muted">{hint}</span>}
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-5 w-9 rounded-full bg-border-strong transition peer-checked:bg-brand peer-focus-visible:ring-4 peer-focus-visible:ring-foreground/10" />
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
      </span>
      <span>
        <span className="block text-[13px] font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Inline message. Errors by default (existing call sites). */
export function Alert({ children, tone = 'error', action }: { children: ReactNode; tone?: 'error' | 'warning' | 'info' | 'success'; action?: ReactNode }) {
  const t = {
    error: { icon: XCircle, cls: 'text-danger', box: 'bg-danger-bg' },
    warning: { icon: AlertTriangle, cls: 'text-warning', box: 'bg-warning-bg' },
    info: { icon: Info, cls: 'text-accent', box: 'bg-subtle' },
    success: { icon: CheckCircle2, cls: 'text-success', box: 'bg-success-bg' },
  }[tone];
  const Icon = t.icon;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className="flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 text-[13px]">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${t.box} ${t.cls}`}>
        <Icon size={15} strokeWidth={2} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

/** One figure in a stat strip: icon + label, big number, footnote. */
export function Stat({ label, value, icon: Icon, foot, trend }: { label: string; value: ReactNode; icon: LucideIcon; foot?: ReactNode; trend?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5 p-5">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Icon size={16} strokeWidth={1.75} aria-hidden />
        {label}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="truncate font-mono text-[21px] font-medium leading-none tracking-tight tabular sm:text-[26px]">{value}</span>
        {trend && <span className="hidden sm:block">{trend}</span>}
      </div>
      {foot && <div className="text-xs text-muted">{foot}</div>}
    </div>
  );
}

/** Stats sharing one card, split by thin dividers. */
export function StatStrip({ children, cols }: { children: ReactNode; cols: 2 | 3 | 4 | 5 }) {
  const grid = {
    2: 'grid-cols-2',
    3: 'grid-cols-2 md:grid-cols-3 max-md:[&>*:last-child:nth-child(odd)]:col-span-2',
    4: 'grid-cols-2 lg:grid-cols-4',
    5: 'grid-cols-2 lg:grid-cols-5 max-lg:[&>*:last-child:nth-child(odd)]:col-span-2',
  }[cols];
  // 1px gaps over a border-coloured background draw the dividers at every breakpoint.
  return <section className={`grid gap-px overflow-hidden rounded-xl border border-border bg-border [&>*]:bg-card ${grid}`}>{children}</section>;
}

/** Up/down change: green when good, red when bad. */
export function Delta({ value, goodWhenUp = true, suffix = '' }: { value: number | null; goodWhenUp?: boolean; suffix?: string }) {
  if (value === null || !Number.isFinite(value)) return <span className="text-faint">—</span>;
  const up = value >= 0;
  const good = up === goodWhenUp;
  return (
    <span className={`font-semibold ${value === 0 ? 'text-muted' : good ? 'text-success' : 'text-danger'}`}>
      {up ? '↑' : '↓'} {Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}
      {suffix}
    </span>
  );
}

export function Spinner() {
  return (
    <div className="flex flex-1 items-center justify-center py-24" role="status" aria-label="Loading">
      <Loader2 size={26} className="animate-spin text-faint" aria-hidden />
    </div>
  );
}

type Tone = 'green' | 'yellow' | 'red' | 'gray' | 'blue';

export function Badge({ children, tone = 'gray', dot }: { children: ReactNode; tone?: Tone; dot?: boolean }) {
  const t = {
    green: 'bg-success-bg text-success',
    yellow: 'bg-warning-bg text-warning',
    red: 'bg-danger-bg text-danger',
    gray: 'bg-subtle text-muted',
    blue: 'bg-series-1/10 text-accent',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${t}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/** Rounded-square icon tile (list rows, empty states). */
export function IconTile({ icon: Icon, tone = 'gray', size = 32 }: { icon: LucideIcon; tone?: Tone; size?: number }) {
  const t = { green: 'bg-success-bg text-success', yellow: 'bg-warning-bg text-warning', red: 'bg-danger-bg text-danger', gray: 'bg-subtle text-muted', blue: 'bg-series-1/10 text-accent' }[tone];
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-lg ${t}`} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.48)} strokeWidth={1.9} aria-hidden />
    </span>
  );
}

/** Initials in a neutral square (campaigns, companies). */
export function Initials({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .split(/[\s–-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-lg bg-subtle text-[11px] font-semibold text-muted" style={{ width: size, height: size }} aria-hidden>
      {initials}
    </span>
  );
}

/** Centered dialog; closes on Escape or backdrop click. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-3 backdrop-blur-[1px] sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Never taller than the screen: the title stays put and only the body scrolls. */}
      <div className={`flex max-h-[calc(100dvh-1.5rem)] w-full flex-col ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-2xl border border-border bg-card shadow-2xl sm:max-h-[calc(100dvh-2rem)]`}>
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton icon={X} aria-label="Close" onClick={onClose} className="-mr-2 h-8 w-8" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">{children}</div>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, children, icon: Icon }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
          {Icon && <Icon size={22} strokeWidth={1.75} className="text-faint" aria-hidden />}
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Empty({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <IconTile icon={Icon} size={44} />
      <div className="mt-3 font-medium">{title}</div>
      {text && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{text}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Shared table styling. */
export const table = {
  wrap: 'w-full text-[13px]',
  head: 'border-y border-border bg-subtle/60 text-left text-xs text-faint [&_th]:px-4 [&_th]:py-2.5 [&_th]:font-medium [&_th:first-child]:pl-5 [&_th:last-child]:pr-5',
  row: 'border-b border-border last:border-0 [&_td]:px-4 [&_td]:py-3 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5',
  rowHover: 'cursor-pointer hover:bg-subtle/60',
};
