'use client';

import { motion } from 'framer-motion';
import { fadeInUp } from '@tradew/ui';
import { pretty, type Synthesis } from '@/lib/sentinel/types';

export function AlertCallout({ synthesis }: { synthesis: Synthesis | null }) {
  if (!synthesis) {
    return (
      <section className="rounded-xl border border-border bg-card p-5">
        <p className="text-muted">
          <span className="mr-2 inline-block h-2 w-2 rounded-full bg-up" />
          No composite risk pattern right now. Sentinel keeps observing — individual signals appear in the timeline below.
        </p>
      </section>
    );
  }

  return (
    <motion.section
      initial="hidden"
      animate="visible"
      variants={fadeInUp}
      className="rounded-xl border border-down bg-down-bg p-5 shadow-elev3"
    >
      <div className="mb-2 flex items-center gap-3">
        <span className="rounded-md bg-down px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
          {pretty(synthesis.pattern)}
        </span>
        <span className="text-xs text-muted">
          confidence {(synthesis.confidence * 100).toFixed(0)}% · multiple corroborating signals
        </span>
      </div>
      <p className="leading-relaxed text-text">{synthesis.content}</p>
      <p className="mt-3 border-t border-border pt-2 text-[11.5px] italic text-faint">{synthesis.disclaimer}</p>
    </motion.section>
  );
}
