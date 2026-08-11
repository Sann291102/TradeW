'use client';

import { useMemo } from 'react';
import type { LayerRow, PerceptorRow } from '@/lib/admin/api';

/**
 * The four-layer stack, drawn as a signal path.
 *
 * WHY A DIAGRAM AND NOT FOUR MORE STAT CARDS
 *
 * The question this answers is not "how much did each layer do" — that is a
 * number, and four cards would carry it. It is **"where does the signal stop?"**
 * A network can be busy at L1 and dead at L3, and in a table of four healthy
 * looking counts that is invisible; drawn as a path with the width of each
 * band proportional to what actually flowed through it, the collapse is the
 * first thing you see.
 *
 * The bands are sized by *outputs*, so the shape narrows naturally: every layer
 * discards something, and a stack that does not narrow is one where the gates
 * are not gating. A stack that narrows to nothing at one particular layer is a
 * bug with an address.
 *
 * Everything here is plain SVG and CSS. Consistent with `admin.css`: nothing
 * animates a layout property, and the whole thing is legible as a still frame
 * under `prefers-reduced-motion` because it encodes state in geometry and
 * label, never in motion.
 */

const LAYER_COLORS: Record<string, string> = {
  L1_PERCEPTION: '#2dd4bf',
  L2_ENCODING: '#38bdf8',
  L3_ASSOCIATION: '#a78bfa',
  L4_CONSOLIDATION: '#fbbf24',
};

/** What each layer consumes and emits, so the diagram explains itself. */
const LAYER_IO: Record<string, { in: string; out: string }> = {
  L1_PERCEPTION: { in: 'raw sensor output', out: 'percepts above the floor' },
  L2_ENCODING: { in: 'percepts', out: 'signatures + vectors' },
  L3_ASSOCIATION: { in: 'encoded signals', out: 'hypotheses' },
  L4_CONSOLIDATION: { in: 'hypotheses', out: 'memories + proposals' },
};

export function NeuralLayers({
  layers,
  perceptors,
  running,
}: {
  layers: LayerRow[];
  perceptors: PerceptorRow[];
  /** Drives the flowing pulse. False when the loop is off or this replica is
   *  not the leader — a still diagram is the honest picture of a still network. */
  running: boolean;
}) {
  const ordered = useMemo(() => [...layers].sort((a, b) => a.index - b.index), [layers]);

  // Scale every band against the widest, so the shape is comparative rather
  // than absolute. An absolute scale would make a quiet hour look like a
  // failure, which is the opposite of what this is for.
  const peak = Math.max(1, ...ordered.map((l) => l.outputs));

  const sensorsByDomain = useMemo(() => {
    const map = new Map<string, { total: number; live: number }>();
    for (const perceptor of perceptors) {
      const entry = map.get(perceptor.domain) ?? { total: 0, live: 0 };
      entry.total += 1;
      if (perceptor.enabled && perceptor.health?.status === 'healthy') entry.live += 1;
      map.set(perceptor.domain, entry);
    }
    // `Array.from` rather than spreading the iterator: apps/web targets a
    // pre-ES2015 lib for downlevel iteration, and the spread form does not
    // compile there.
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [perceptors]);

  return (
    <section className="admin-card rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 backdrop-blur-sm">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[12.5px] font-semibold tracking-wide">The four layers</h2>
          <p className="text-[11px] text-muted">
            Band width is what each layer actually emitted. A stack that narrows is working; one that stops narrowing at
            a particular layer has a bug there.
          </p>
        </div>
        <span className="text-[10.5px] uppercase tracking-[0.13em] text-faint">
          {running ? 'signal flowing' : 'network idle'}
        </span>
      </header>

      {/* Sensor inputs — the diagram starts where the data does. */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {sensorsByDomain.map(([domain, counts]) => (
          <span
            key={domain}
            className="rounded border border-white/10 px-1.5 py-0.5 text-[10.5px] text-muted"
            title={`${counts.live} of ${counts.total} ${domain} perceptors healthy and enabled`}
          >
            {domain} <span className="num text-faint">{counts.live}/{counts.total}</span>
          </span>
        ))}
        {!sensorsByDomain.length && <span className="text-[11px] text-faint">No perceptors registered.</span>}
      </div>

      <ol className="space-y-2">
        {ordered.map((layer, i) => {
          const color = LAYER_COLORS[layer.id] ?? '#2dd4bf';
          const io = LAYER_IO[layer.id];
          // 8% minimum, so a layer that emitted nothing is still a visible,
          // labelled band rather than disappearing off the diagram — "this
          // layer produced zero" is the single most important thing it can say.
          const width = Math.max(8, (layer.outputs / peak) * 100);
          const starved = layer.passes > 0 && layer.inputs > 0 && layer.outputs === 0;

          return (
            <li key={layer.id} className="relative">
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="num text-[10.5px] text-faint">L{i + 1}</span>
                  <span className="truncate text-[12px] font-medium" style={{ color }}>
                    {layer.label}
                  </span>
                  {starved && (
                    <span className="shrink-0 rounded border border-down/40 px-1 py-px text-[10px] text-down">
                      emitting nothing
                    </span>
                  )}
                </div>
                <span className="num shrink-0 text-[11px] text-muted">
                  {layer.inputs.toLocaleString()} in → {layer.outputs.toLocaleString()} out
                </span>
              </div>

              <div className="mt-1 h-6 w-full overflow-hidden rounded-md border border-white/[0.06] bg-black/30">
                <div
                  className="relative h-full transition-[width] duration-500"
                  style={{
                    width: `${width}%`,
                    background: `linear-gradient(90deg, ${color}44, ${color}22)`,
                    borderRight: `2px solid ${color}`,
                  }}
                >
                  {running && (
                    // The flowing pulse is `transform` only and inherits the
                    // reduced-motion block in admin.css via `.admin-packet`.
                    <span
                      className="admin-packet absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
                      style={{ background: color, animationDelay: `${i * 0.4}s` }}
                      aria-hidden
                    />
                  )}
                </div>
              </div>

              <p className="mt-1 text-[10.5px] text-faint">
                {io ? `${io.in} → ${io.out}. ` : ''}
                {layer.description}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Sensor status → tone. Quarantined and failing read as bad; stale as warn —
 *  a sensor that has stopped is not the same fault as one that is throwing. */
export function perceptorTone(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
  if (status === 'healthy') return 'good';
  if (status === 'stale') return 'warn';
  if (status === 'failing' || status === 'quarantined') return 'bad';
  return 'neutral';
}

/**
 * A 0..1 weight as a bar.
 *
 * `reinforcements` is rendered alongside deliberately, and dimmed to nothing
 * when it is zero. A weight that has never been scored by an outcome is a guess
 * the network made and nothing has confirmed — showing it identically to one
 * that survived forty outcomes would misrepresent the single number this whole
 * system exists to produce.
 */
export function WeightBar({ weight, reinforcements }: { weight: number; reinforcements: number }) {
  const proven = reinforcements > 0;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative block h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${Math.round(weight * 100)}%`,
            background: proven ? '#2dd4bf' : 'rgb(255 255 255 / 0.28)',
          }}
        />
      </span>
      <span className={`num text-[11px] ${proven ? 'text-text' : 'text-faint'}`}>{weight.toFixed(2)}</span>
      {!proven && <span className="text-[10px] text-faint">unproven</span>}
    </span>
  );
}
