'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Shared primitives for the admin pages.
 *
 * Local to `/admin` rather than added to `@tradew/ui`: these carry the portal's
 * darker glass treatment and its 3D tilt, which the trader-facing product
 * deliberately does not use. Promoting them to the shared package would invite
 * the operator aesthetic into the product by accident.
 */

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

/** A headline number. `tone` colours only the delta line, never the figure —
 *  a number that changes colour with its value is hard to scan. */
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

/** Small status pill. Colour maps to meaning, and the text always says the same
 *  thing — never colour alone. */
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

/** HTTP status → tone. 2xx good, 3xx neutral, 4xx warn (the caller's fault),
 *  5xx bad (ours). The 4xx/5xx split is the one an operator triages on. */
export function statusTone(code: number): 'good' | 'neutral' | 'warn' | 'bad' {
  if (code >= 500) return 'bad';
  if (code >= 400) return 'warn';
  if (code >= 300) return 'neutral';
  return 'good';
}

/**
 * Dependency-free bar chart over an hourly series.
 *
 * SVG rather than a charting library: this renders one stacked bar per bucket
 * and nothing else. Pulling in a chart dependency for it would add more
 * configuration than drawing does.
 */
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

/** A scrollable table body with sticky headers. */
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

export function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th className={`whitespace-nowrap border-b border-white/[0.06] px-3 py-2 font-medium ${className}`}>{children}</th>;
}

export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap border-b border-white/[0.04] px-3 py-1.5 ${className}`}>{children}</td>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-[12px] text-faint">{children}</div>;
}

/** Window selector. 1h/6h/24h/7d covers "what just happened" through "is this
 *  a trend", which is the full range of questions this console is asked. */
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

/**
 * Poll an async loader on an interval.
 *
 * `useRef` on the loader means a caller can pass an inline arrow function
 * without the effect re-subscribing on every render — the mistake that turns a
 * 5-second poll into a request per keystroke. `alive` guards against a response
 * from a previous window landing after the user has already switched away.
 */
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
