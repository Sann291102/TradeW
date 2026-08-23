'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Panel({
  title,
  subtitle,
  right,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`admin-card rounded-xl border border-white/[0.07] bg-white/[0.02] shadow-elev2 backdrop-blur-sm ${className}`}
    >
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-[12.5px] font-semibold tracking-wide">{title}</h2>}
            {subtitle && <p className="truncate text-[11px] text-muted">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'good' ? 'text-up' : tone === 'warn' ? 'text-amber' : tone === 'bad' ? 'text-down' : 'text-muted';
  return (
    <div className="admin-card overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 backdrop-blur-sm">
      <div className="text-[10.5px] uppercase tracking-[0.13em] text-faint">{label}</div>
      <div className="num mt-1 text-[22px] font-semibold leading-none">{value}</div>
      {sub && <div className={`num mt-1.5 text-[11.5px] ${toneClass}`}>{sub}</div>}
    </div>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  const map = {
    neutral: 'border-white/10 text-muted',
    good: 'border-up/40 text-up',
    warn: 'border-amber/40 text-amber',
    bad: 'border-down/40 text-down',
    info: 'border-teal/40 text-teal',
  } as const;
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-px text-[10.5px] font-medium ${map[tone]}`}>
      {children}
    </span>
  );
}

export function statusTone(code: number): 'good' | 'neutral' | 'warn' | 'bad' {
  if (code >= 500) return 'bad';
  if (code >= 400) return 'warn';
  if (code >= 300) return 'neutral';
  return 'good';
}

export function BarChart({
  data,
  height = 120,
  series,
}: {
  data: Array<Record<string, number | string>>;
  height?: number;
  series: Array<{ key: string; color: string; label: string }>;
}) {
  if (!data.length) {
    return <div className="flex items-center justify-center py-10 text-[11.5px] text-faint">No activity in this window.</div>;
  }

  const totals = data.map((d) => series.reduce((sum, s) => sum + Number(d[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const barWidth = 100 / data.length;

  return (
    <div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        {data.map((row, i) => {
          let y = height;
          return (
            <g key={i}>
              {series.map((s) => {
                const value = Number(row[s.key] ?? 0);
                const h = (value / max) * (height - 4);
                y -= h;
                return (
                  <rect
                    key={s.key}
                    x={i * barWidth + barWidth * 0.15}
                    y={y}
                    width={barWidth * 0.7}
                    height={Math.max(0, h)}
                    fill={s.color}
                    opacity={0.85}
                  >
                    <title>{`${new Date(String(row.bucket)).toLocaleString()} — ${s.label}: ${value}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-3 px-1">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[10.5px] text-muted">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="max-h-[520px] overflow-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-[#070b12]/95 backdrop-blur">
          <tr className="text-left text-[10.5px] uppercase tracking-[0.1em] text-faint">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th className={`whitespace-nowrap border-b border-white/[0.06] px-3 py-2 font-medium ${className}`}>{children}</th>;
}

/** `title` is the hover readout for a cell whose content is `truncate`d — the
 *  only way the clipped half stays reachable without widening the table. */
export function Td({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <td title={title} className={`whitespace-nowrap border-b border-white/[0.04] px-3 py-1.5 ${className}`}>
      {children}
    </td>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-[12px] text-faint">{children}</div>;
}

export function WindowPicker({ hours, onChange }: { hours: number; onChange: (h: number) => void }) {
  const options = [
    { h: 1, label: '1h' },
    { h: 6, label: '6h' },
    { h: 24, label: '24h' },
    { h: 168, label: '7d' },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.08] p-0.5">
      {options.map((o) => (
        <button
          key={o.h}
          type="button"
          onClick={() => onChange(o.h)}
          className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
            hours === o.h ? 'bg-teal/15 text-teal' : 'text-muted hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function usePolling<T>(
  load: () => Promise<T>,
  deps: unknown[],
  intervalMs = 10_000,
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const next = await loadRef.current();
        if (!alive) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Request failed');
      } finally {
        if (alive) setLoading(false);
      }
    };
    void run();
    const timer = setInterval(run, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, nonce]);

  return { data, error, loading, refresh: () => setNonce((n) => n + 1) };
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtUsd(v: number): string {
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtNum(v: number): string {
  return v.toLocaleString();
}

export function fmtTime(iso: string | number | Date): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ago(iso: string | number | Date | null): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

// ===========================================================================
// Operator-console primitives (2026-08-12 UI phase).
//
// Built on the same tokens the rest of this file uses (text-up/down/amber/teal/
// faint/muted, the admin-* CSS layer). The rule that governs every one of these:
// they render exactly what they are handed and invent nothing. A card with no
// value shows an em dash, not a plausible number; a "live" dot is only green
// when the caller passes a healthy status derived from a real read.
// ===========================================================================

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'idle';

const DOT_BG: Record<Tone, string> = {
  good: 'bg-up',
  warn: 'bg-amber',
  bad: 'bg-down',
  info: 'bg-teal',
  idle: 'bg-slate-500',
  neutral: 'bg-slate-500',
};

const TONE_TEXT: Record<Tone, string> = {
  good: 'text-up',
  warn: 'text-amber',
  bad: 'text-down',
  info: 'text-teal',
  idle: 'text-faint',
  neutral: 'text-muted',
};

/** A small status dot, optionally pulsing. `pulse` is for live/healthy signals;
 *  a steady dot reads as a settled state. */
export function StatusDot({ tone = 'good', pulse = false, size = 8 }: { tone?: Tone; pulse?: boolean; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden>
      {pulse && (tone === 'good' || tone === 'info') && (
        <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${DOT_BG[tone]}`} />
      )}
      <span className={`relative inline-block rounded-full ${DOT_BG[tone]}`} style={{ width: size, height: size }} />
    </span>
  );
}

/** Dot + label, e.g. "● All systems operational". */
export function StatusIndicator({ label, tone = 'good', pulse = true }: { label: ReactNode; tone?: Tone; pulse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium">
      <StatusDot tone={tone} pulse={pulse} />
      <span className={TONE_TEXT[tone]}>{label}</span>
    </span>
  );
}

/**
 * A high-information KPI card. `value` is the real number; `delta` is only ever
 * rendered when the caller has a genuine comparison to show — there is no
 * default "vs yesterday", because the backend does not currently expose one and
 * inventing it is exactly what the design brief forbids.
 */
export function MetricCard({
  label,
  value,
  sub,
  delta,
  accent = 'teal',
  tone = 'neutral',
  live = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  delta?: { text: string; dir: 'up' | 'down' | 'flat' };
  accent?: 'teal' | 'violet' | 'amber' | 'red' | 'green' | 'slate';
  tone?: Tone;
  live?: boolean;
}) {
  const accentBar: Record<string, string> = {
    teal: 'from-teal/70', violet: 'from-[#8b9dff]/70', amber: 'from-amber/70',
    red: 'from-down/70', green: 'from-up/70', slate: 'from-slate-500/60',
  };
  const deltaTone = delta?.dir === 'up' ? 'text-up' : delta?.dir === 'down' ? 'text-down' : 'text-faint';
  const deltaArrow = delta?.dir === 'up' ? '↑' : delta?.dir === 'down' ? '↓' : '→';
  return (
    <div className="admin-card group relative overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 backdrop-blur-sm">
      <span className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r to-transparent ${accentBar[accent]}`} aria-hidden />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] uppercase tracking-[0.13em] text-faint">{label}</span>
        {live && <StatusDot tone="good" pulse size={6} />}
      </div>
      <div className={`num mt-1.5 text-[24px] font-semibold leading-none ${tone !== 'neutral' ? TONE_TEXT[tone] : ''}`}>{value}</div>
      <div className="mt-1.5 flex items-center gap-2">
        {delta && <span className={`num text-[11px] ${deltaTone}`}>{deltaArrow} {delta.text}</span>}
        {sub && <span className="num truncate text-[11px] text-muted">{sub}</span>}
      </div>
    </div>
  );
}

/** A labelled section header for grouping panels on dense pages. */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-0.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h2>
      {right}
    </div>
  );
}

/** Service-health rows from a real health report. `status` drives the dot; no
 *  status is ever assumed. */
export function SystemHealthList({
  services,
}: {
  services: Array<{ name: string; status: 'up' | 'down' | string; latencyMs?: number; error?: string | null }>;
}) {
  if (!services.length) return <Empty>No services reported.</Empty>;
  return (
    <ul className="divide-y divide-white/[0.04]">
      {services.map((s) => {
        const tone: Tone = s.status === 'up' ? 'good' : s.status === 'down' ? 'bad' : 'warn';
        return (
          <li key={s.name} className="flex items-center justify-between gap-3 px-4 py-2">
            <span className="flex items-center gap-2 text-[12px]">
              <StatusDot tone={tone} pulse={tone === 'good'} />
              {s.name}
            </span>
            <span className={`num text-[11px] ${tone === 'bad' ? 'text-down' : 'text-faint'}`}>
              {tone === 'bad' ? (s.error ? 'down' : 'down') : s.latencyMs != null ? fmtMs(s.latencyMs) : 'up'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A vertical activity feed. Items are real records; `at` is a real timestamp. */
export function ActivityFeed({
  items,
  emptyLabel = 'Nothing recent.',
}: {
  items: Array<{ id: string; title: ReactNode; meta?: ReactNode; at?: string | number | Date | null; tone?: Tone }>;
  emptyLabel?: string;
}) {
  if (!items.length) return <Empty>{emptyLabel}</Empty>;
  return (
    <ul className="divide-y divide-white/[0.04]">
      {items.map((it) => (
        <li key={it.id} className="flex items-start gap-2.5 px-4 py-2">
          <span className="mt-1"><StatusDot tone={it.tone ?? 'idle'} pulse={false} size={7} /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px]">{it.title}</div>
            {it.meta && <div className="truncate text-[10.5px] text-faint">{it.meta}</div>}
          </div>
          {it.at != null && <span className="num shrink-0 text-[10.5px] text-faint">{ago(it.at)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A donut chart from real segments. Renders a hollow ring (empty track when
 *  there is nothing to show) plus optional centre text. Legends are the caller's
 *  job so each page can format values its own way. Used by Model Usage (AI) and
 *  Synapse Distribution (neural). */
export function Donut({
  segments,
  size = 132,
  thickness = 15,
  centerValue,
  centerLabel,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
  size?: number;
  thickness?: number;
  centerValue?: ReactNode;
  centerLabel?: ReactNode;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={thickness} />
        {total > 0 && segments.map((s) => {
          const frac = s.value / total;
          const dash = frac * circ;
          const el = (
            <circle key={s.label} cx={c} cy={c} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
              strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={-acc * circ}
              transform={`rotate(-90 ${c} ${c})`} />
          );
          acc += frac;
          return el;
        })}
      </svg>
      {(centerValue !== undefined || centerLabel !== undefined) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {centerValue !== undefined && <div className="num text-[16px] font-semibold leading-none">{centerValue}</div>}
          {centerLabel !== undefined && <div className="mt-0.5 text-[9px] uppercase tracking-wide text-faint">{centerLabel}</div>}
        </div>
      )}
    </div>
  );
}

/** A minimal inline sparkline from a series of numbers. Purely presentational;
 *  renders nothing rather than a flat fake line when handed no data. */
export function Sparkline({ values, color = 'rgb(38 166 154)', height = 28 }: { values: number[]; color?: string; height?: number }) {
  if (values.length < 2) return <div style={{ height }} className="flex items-center text-[10px] text-faint">—</div>;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${height - ((v - min) / span) * (height - 4) - 2}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
