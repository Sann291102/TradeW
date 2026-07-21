'use client';

import { motion } from 'framer-motion';
import { staggerContainer, listItem } from '@tradew/ui';
import { pretty, type Observation } from '@/lib/sentinel/types';

const FALLBACK: Observation = {
  agent: 'emotion',
  category: '',
  pattern: 'no_patterns',
  content: 'No behavioral patterns detected this session. Discipline holding steady.',
  evidence: [],
  confidence: 0.5,
};

export function ReflectionCards({ observations }: { observations: Observation[] }) {
  const emotions = observations.filter((o) => o.agent === 'emotion');
  const cards = emotions.length ? emotions.slice(0, 3) : [FALLBACK];

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">AI Reflection Cards</h2>
      <motion.div initial="hidden" animate="visible" variants={staggerContainer} className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {cards.map((o, i) => (
          <motion.div key={i} variants={listItem} className="rounded-xl border border-border bg-card p-4">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold capitalize text-amber">{pretty(o.pattern)}</span>
              <span className="text-[10.5px] text-faint">Emotion Intelligence</span>
            </div>
            <p className="text-[12.5px] leading-relaxed text-muted">{o.content}</p>
            <button className="mt-3 text-xs font-medium text-teal hover:underline">Reflect with AI ↗</button>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
