'use client';
import { useEffect, useRef, useState } from 'react';

let mermaidLoaded: Promise<typeof import('mermaid')> | null = null;
let idSeq = 0;

/** Lazily loads mermaid (heavy) only when a diagram is actually on screen. */
function loadMermaid() {
  if (!mermaidLoaded) {
    mermaidLoaded = import('mermaid').then((mod) => {
      mod.default.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
      return mod;
    });
  }
  return mermaidLoaded;
}

export function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mmd-${idSeq++}`;
    loadMermaid()
      .then((mod) => mod.default.render(id, chart))
      .then(({ svg }) => {
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <pre className="overflow-x-auto rounded-lg border border-[#3a2d14] bg-[#1a1206] p-3 text-[12px] text-[#f0a53c]">
        mermaid render failed: {error}
        {'\n\n'}
        {chart}
      </pre>
    );
  }
  return <div ref={ref} className="my-3 flex justify-center overflow-x-auto rounded-lg bg-[#0d1524] p-3" />;
}
