'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';

export interface Series {
  key: string;
  label: string;
  /** CSS color, e.g. var(--series-1) */
  color: string;
}

interface ChartProps<T> {
  data: T[];
  x: (d: T) => string;
  series: Series[];
  value: (d: T, key: string) => number;
  format?: (v: number) => string;
  height?: number;
  /** Stack bars instead of placing series side by side (bars only). */
  stacked?: boolean;
  /** Values are counts: use whole-number axis steps. */
  integer?: boolean;
  /** Axis label for a point (default: a date like 9/24). */
  label?: (d: T) => string;
}

const PAD = { top: 12, right: 12, bottom: 26, left: 44 };

function niceStep(v: number) {
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

/** Axis top: 4 even gridline steps. Counts use whole-number steps (0,1,2,3,4 rather than 0,0.25…). */
function niceMax(v: number, integer = false) {
  if (v <= 0) return integer ? 4 : 1;
  const step = niceStep(v / 4);
  return (integer ? Math.max(1, Math.ceil(step)) : step) * 4;
}

const shortDay = (d: string) => {
  const [, m, day] = d.split('-');
  return `${Number(m)}/${Number(day)}`;
};

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const observer = useMemo(
    () =>
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => setWidth(Math.max(280, Math.round(entries[0].contentRect.width)))),
    [],
  );
  const setRef = (el: HTMLDivElement | null) => {
    if (ref.current && observer) observer.unobserve(ref.current);
    (ref as { current: HTMLDivElement | null }).current = el;
    if (el && observer) observer.observe(el);
  };
  return { setRef, width };
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-4 text-xs text-muted">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ left, title, rows }: { left: number; title: string; rows: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 min-w-36 -translate-x-1/2 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-xl"
      style={{ left }}
    >
      <div className="mb-1 font-medium">{title}</div>
      {rows}
    </div>
  );
}

function YAxis({ max, innerH, width, format }: { max: number; innerH: number; width: number; format: (v: number) => string }) {
  return (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const y = PAD.top + innerH - f * innerH;
        return (
          <g key={f}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end" fontSize={11} fill="var(--faint)" fontFamily="var(--font-geist-mono)">
              {format(max * f)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** Bars per day; one bar per series (or stacked). Hover shows the day's values. */
export function BarChart<T>({ data, x, series, value, format = (v) => String(Math.round(v)), height = 220, stacked, integer, label }: ChartProps<T>) {
  const { setRef, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const totals = data.map((d) => (stacked ? series.reduce((s, se) => s + value(d, se.key), 0) : Math.max(...series.map((se) => value(d, se.key)))));
  const max = niceMax(Math.max(0, ...totals), integer);
  const band = innerW / Math.max(data.length, 1);
  const groupW = Math.min(band * 0.7, 48);
  const barW = stacked ? groupW : Math.max(2, (groupW - 2 * (series.length - 1)) / series.length);
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(innerW / 44)));

  return (
    <div ref={setRef} className="relative w-full min-w-0 overflow-hidden">
      <svg width={width} height={height} role="img" aria-label={`Bar chart of ${series.map((s) => s.label).join(', ')} per day`}>
        <YAxis max={max} innerH={innerH} width={width} format={format} />
        {data.map((d, i) => {
          const cx = PAD.left + band * i + band / 2;
          let acc = 0;
          return (
            <g key={x(d)}>
              {series.map((se, si) => {
                const v = value(d, se.key);
                const h = (v / max) * innerH;
                const bx = stacked ? cx - groupW / 2 : cx - groupW / 2 + si * (barW + 2);
                const by = PAD.top + innerH - h - (stacked ? acc : 0);
                if (stacked) acc += h;
                if (h <= 0) return null;
                // Stacked: 2px surface gap between segments; data end rounded.
                const top = !stacked || si === series.length - 1 || series.slice(si + 1).every((s2) => value(d, s2.key) === 0);
                return (
                  <rect
                    key={se.key}
                    x={bx}
                    y={by + (stacked && si > 0 ? 0 : 0)}
                    width={barW}
                    height={Math.max(stacked && si > 0 ? h - 2 : h, 1)}
                    rx={top ? Math.min(4, barW / 2) : 0}
                    fill={se.color}
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                );
              })}
              {i % labelEvery === 0 && (
                <text x={cx} y={height - 8} textAnchor="middle" fontSize={11} fill="var(--faint)" fontFamily="var(--font-geist-mono)">
                  {label ? label(d) : shortDay(x(d))}
                </text>
              )}
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <Tooltip
          left={Math.min(Math.max(PAD.left + band * hover + band / 2, 80), width - 80)}
          title={x(data[hover])}
          rows={series.map((se) => (
            <div key={se.key} className="flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5 text-muted">
                <span className="h-2 w-2 rounded-sm" style={{ background: se.color }} />
                {se.label}
              </span>
              <span className="font-medium tabular-nums">{format(value(data[hover], se.key))}</span>
            </div>
          ))}
        />
      )}
    </div>
  );
}

/** Lines per day with a crosshair tooltip and end-of-line labels. */
export function LineChart<T>({ data, x, series, value, format = (v) => String(v), height = 220, integer, label }: ChartProps<T>) {
  const { setRef, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const labelRoom = series.length > 1 ? 64 : 0;
  const innerW = width - PAD.left - PAD.right - labelRoom;
  const innerH = height - PAD.top - PAD.bottom;
  const all = data.flatMap((d) => series.map((s) => value(d, s.key)));
  const max = niceMax(Math.max(0, ...all), integer);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const px = (i: number) => PAD.left + (data.length <= 1 ? innerW / 2 : (innerW * i) / (data.length - 1));
  const py = (v: number) => PAD.top + innerH - ((v - min) / span) * innerH;
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(innerW / 44)));

  // End-of-line labels: keep at least 13px apart so lines ending together stay readable.
  const endLabelY: Record<string, number> = {};
  if (data.length) {
    const placed = series
      .map((s) => ({ key: s.key, y: py(value(data[data.length - 1], s.key)) }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < placed.length; i++) placed[i].y = Math.max(placed[i].y, placed[i - 1].y + 13);
    const overflow = placed.length ? placed[placed.length - 1].y - (PAD.top + innerH) : 0;
    for (const p of placed) endLabelY[p.key] = overflow > 0 ? p.y - overflow : p.y;
  }

  return (
    <div ref={setRef} className="relative w-full min-w-0 overflow-hidden">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Line chart of ${series.map((s) => s.label).join(', ')} per day`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const rel = e.clientX - rect.left - PAD.left;
          const i = data.length <= 1 ? 0 : Math.round((rel / innerW) * (data.length - 1));
          setHover(Math.max(0, Math.min(data.length - 1, i)));
        }}
      >
        <YAxis max={max} innerH={innerH} width={width - labelRoom} format={format} />
        {min < 0 && <line x1={PAD.left} x2={PAD.left + innerW} y1={py(0)} y2={py(0)} stroke="var(--muted)" strokeWidth={1} />}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={x(d)} x={px(i)} y={height - 8} textAnchor="middle" fontSize={11} fill="var(--faint)" fontFamily="var(--font-geist-mono)">
              {label ? label(d) : shortDay(x(d))}
            </text>
          ) : null,
        )}
        {hover !== null && <line x1={px(hover)} x2={px(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--muted)" strokeDasharray="3 3" />}
        {series.map((s) => {
          const path = data.map((d, i) => `${i ? 'L' : 'M'}${px(i)},${py(value(d, s.key))}`).join(' ');
          const last = data.length - 1;
          return (
            <g key={s.key}>
              <path d={path} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {hover !== null && <circle cx={px(hover)} cy={py(value(data[hover], s.key))} r={4} fill={s.color} stroke="var(--card)" strokeWidth={2} />}
              {series.length > 1 && last >= 0 && (
                <text x={px(last) + 8} y={endLabelY[s.key] + 4} fontSize={11} fill="var(--faint)" fontFamily="var(--font-geist-mono)">
                  {s.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <Tooltip
          left={Math.min(Math.max(px(hover), 80), width - 80)}
          title={x(data[hover])}
          rows={series.map((se) => (
            <div key={se.key} className="flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5 text-muted">
                <span className="h-0.5 w-3" style={{ background: se.color }} />
                {se.label}
              </span>
              <span className="font-medium tabular-nums">{format(value(data[hover], se.key))}</span>
            </div>
          ))}
        />
      )}
    </div>
  );
}

/** Tiny trend line for stat tiles (no axes; decorative, so hidden from screen readers). */
export function Sparkline({ values, width = 72, height = 26, color = 'var(--series-1)' }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none" aria-hidden className="shrink-0">
      <polyline points={pts} stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
