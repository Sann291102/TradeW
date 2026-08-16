'use client';

import type { RadarFactor } from '@/lib/sentinel/dashboardModel';

/**
 * Risk Radar — an 8-axis spider chart of the real risk-engine factors
 * (`risk.factors[]` from /observe). Higher = more risk on that axis. The
 * filled polygon is drawn from the actual factor scores; the concentric rings
 * are the 25/50/75/100 gridlines. Pure SVG, theme-aware via design tokens.
 */
export function RiskRadar({ factors }: { factors: RadarFactor[] }) {
  const size = 260;
  const cx = size / 2;
  const cy = size / 2 + 6;
  const r = size / 2 - 40;
  const n = factors.length;

  if (n < 3) {
    return (
      <div className="flex h-[260px] items-center justify-center text-center text-[12px] text-faint">
        No risk-factor read available yet.
      </div>
    );
  }

  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const point = (i: number, radius: number) => ({
    x: cx + radius * Math.cos(angle(i)),
    y: cy + radius * Math.sin(angle(i)),
  });

  const polygon = factors
    .map((f, i) => {
      const p = point(i, (f.score / 100) * r);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(' ');

  const rings = [0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto block w-full max-w-[280px]" role="img" aria-label="Risk radar, 8 factors">
      <defs>
        <radialGradient id="risk-fill" cx="50%" cy="50%" r="65%">
          <stop offset="0%" stopColor="var(--green)" stopOpacity="0.55" />
          <stop offset="55%" stopColor="var(--amber)" stopOpacity="0.5" />
          <stop offset="100%" stopColor="var(--red)" stopOpacity="0.5" />
        </radialGradient>
      </defs>

      {/* concentric grid rings */}
      {rings.map((ring) => (
        <polygon
          key={ring}
          points={factors.map((_, i) => { const p = point(i, ring * r); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ')}
          fill="none"
          stroke="var(--border)"
          strokeWidth={1}
        />
      ))}

      {/* spokes */}
      {factors.map((_, i) => {
        const p = point(i, r);
        return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="var(--border)" strokeWidth={1} />;
      })}

      {/* data polygon */}
      <polygon points={polygon} fill="url(#risk-fill)" stroke="var(--amber)" strokeWidth={1.5} />

      {/* vertices */}
      {factors.map((f, i) => {
        const p = point(i, (f.score / 100) * r);
        return <circle key={f.key} cx={p.x} cy={p.y} r={2.4} fill="var(--text)" />;
      })}

      {/* axis labels + scores */}
      {factors.map((f, i) => {
        const p = point(i, r + 18);
        const a = angle(i);
        const anchor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
        return (
          <text key={f.key} x={p.x} y={p.y} textAnchor={anchor} dominantBaseline="middle">
            <tspan className="fill-faint" style={{ fontSize: 8.5, fontWeight: 600 }}>{f.label}</tspan>
            <tspan x={p.x} dy={11} className="fill-muted" style={{ fontSize: 9.5, fontWeight: 800 }}>{f.score}</tspan>
          </text>
        );
      })}
    </svg>
  );
}
