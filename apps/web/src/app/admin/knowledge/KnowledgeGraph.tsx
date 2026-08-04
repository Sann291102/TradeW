'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphData } from '@/lib/admin/knowledge';

const GROUP_COLORS: Record<string, string> = {
  Decisions: '#14b8a6',
  Research: '#8b9dff',
  Plans: '#f0a53c',
  Patterns: '#26a69a',
  Gotchas: '#ef5350',
  Agents: '#c084fc',
  API: '#38bdf8',
  root: '#8ea0c4',
};

interface P {
  x: number;
  y: number;
}

const W = 640;
const H = 460;

/**
 * Dependency-free force-directed graph over the vault's wiki-link edges.
 * A short deterministic simulation (repulsion + spring + centering) lays out
 * nodes; size encodes link degree, colour encodes the top-level folder.
 */
export function KnowledgeGraph({
  data,
  activePath,
  onOpen,
}: {
  data: GraphData | null;
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const [positions, setPositions] = useState<Record<string, P>>({});

  const { nodes, edges, neighborOf } = useMemo(() => {
    const ns = data?.nodes ?? [];
    const es = (data?.edges ?? []).filter(
      (e) => ns.some((n) => n.id === e.source) && ns.some((n) => n.id === e.target),
    );
    const neighbor = new Map<string, Set<string>>();
    for (const e of es) {
      if (!neighbor.has(e.source)) neighbor.set(e.source, new Set());
      if (!neighbor.has(e.target)) neighbor.set(e.target, new Set());
      neighbor.get(e.source)!.add(e.target);
      neighbor.get(e.target)!.add(e.source);
    }
    return { nodes: ns, edges: es, neighborOf: neighbor };
  }, [data]);

  useEffect(() => {
    if (nodes.length === 0) {
      setPositions({});
      return;
    }
    // seed on a circle (deterministic), then relax with a simple force model.
    const pos: Record<string, P> = {};
    nodes.forEach((n, i) => {
      const a = (i / nodes.length) * Math.PI * 2;
      pos[n.id] = { x: W / 2 + Math.cos(a) * 160, y: H / 2 + Math.sin(a) * 160 };
    });
    const ids = nodes.map((n) => n.id);
    for (let iter = 0; iter < 260; iter++) {
      const disp: Record<string, P> = {};
      for (const id of ids) disp[id] = { x: 0, y: 0 };
      // repulsion
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = pos[ids[i]];
          const b = pos[ids[j]];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = 5200 / d2;
          const d = Math.sqrt(d2);
          dx /= d;
          dy /= d;
          disp[ids[i]].x += dx * f;
          disp[ids[i]].y += dy * f;
          disp[ids[j]].x -= dx * f;
          disp[ids[j]].y -= dy * f;
        }
      }
      // spring attraction along edges
      for (const e of edges) {
        const a = pos[e.source];
        const b = pos[e.target];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 90) * 0.02;
        dx = (dx / d) * f;
        dy = (dy / d) * f;
        disp[e.source].x -= dx;
        disp[e.source].y -= dy;
        disp[e.target].x += dx;
        disp[e.target].y += dy;
      }
      const cool = 1 - iter / 400;
      for (const id of ids) {
        pos[id].x += Math.max(-8, Math.min(8, disp[id].x)) * cool + (W / 2 - pos[id].x) * 0.008;
        pos[id].y += Math.max(-8, Math.min(8, disp[id].y)) * cool + (H / 2 - pos[id].y) * 0.008;
        pos[id].x = Math.max(20, Math.min(W - 20, pos[id].x));
        pos[id].y = Math.max(20, Math.min(H - 20, pos[id].y));
      }
    }
    setPositions({ ...pos });
  }, [nodes, edges]);

  if (!data || nodes.length === 0) {
    return <p className="p-6 text-center text-[12px] text-[#64769c]">No linked notes to graph yet.</p>;
  }

  const active = hover ?? activePath;
  const activeNeighbors = active ? neighborOf.get(active) ?? new Set<string>() : new Set<string>();
  const dim = (id: string) => (active && id !== active && !activeNeighbors.has(id) ? 0.18 : 1);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    setPositions((p) => ({ ...p, [dragRef.current!]: { x, y } }));
  };

  return (
    <div className="flex h-full flex-col p-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="min-h-0 w-full flex-1 select-none"
        onMouseMove={onMove}
        onMouseUp={() => (dragRef.current = null)}
        onMouseLeave={() => {
          dragRef.current = null;
          setHover(null);
        }}
      >
        {edges.map((e, i) => {
          const a = positions[e.source];
          const b = positions[e.target];
          if (!a || !b) return null;
          const lit = active && (e.source === active || e.target === active);
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={lit ? '#14b8a6' : '#2a3a5c'}
              strokeWidth={lit ? 1.5 : 0.8}
              opacity={active && !lit ? 0.15 : 0.7}
            />
          );
        })}
        {nodes.map((n) => {
          const p = positions[n.id];
          if (!p) return null;
          const r = 5 + Math.min(9, n.degree * 1.6);
          const color = GROUP_COLORS[n.group] ?? '#8ea0c4';
          const opacity = dim(n.id);
          return (
            <g
              key={n.id}
              transform={`translate(${p.x},${p.y})`}
              className="cursor-pointer"
              opacity={opacity}
              onMouseEnter={() => setHover(n.id)}
              onMouseDown={() => (dragRef.current = n.id)}
              onClick={() => onOpen(n.id)}
            >
              <circle
                r={r}
                fill={color}
                stroke={n.id === activePath ? '#fff' : '#0d1524'}
                strokeWidth={n.id === activePath ? 2 : 1.5}
              />
              {(active === n.id || activeNeighbors.has(n.id) || n.degree >= 3) && (
                <text x={r + 3} y={4} fontSize={9} fill="#c6d0e2">
                  {n.label.length > 26 ? n.label.slice(0, 26) + '…' : n.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex shrink-0 flex-wrap gap-x-3 gap-y-1 px-2 text-[10px] text-[#64769c]">
        {Object.entries(GROUP_COLORS)
          .filter(([g]) => nodes.some((n) => n.group === g))
          .map(([g, c]) => (
            <span key={g} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: c }} /> {g}
            </span>
          ))}
        <span className="ml-auto">drag nodes · hover to focus · click to highlight</span>
      </div>
    </div>
  );
}
