import { motion } from 'framer-motion';
import { staggerContainer, listItem } from '@tradew/ui';
import type { SafetyCardData } from '@/lib/sentinel/deriveContext';
import { SafetyCard } from './SafetyCard';

/**
 * "What should the trader pay attention to?" (redesign question 4) — a
 * chronological feed of short action words (Wait & Watch, Enough, Book &
 * Breathe, Trail or Exit, Pause, Setup Forming), each expandable into its
 * evidence. Replaces the old Reflection Cards / Agent Timeline / Observation
 * Feed three-column layout, which exposed internal agent architecture
 * instead of a single readable conclusion per event.
 */
export function LiveSafetyFeed({ cards }: { cards: SafetyCardData[] }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Live Safety Feed</h2>
      {cards.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-5 text-[13px] text-muted">
          Nothing to flag right now. This feed stays quiet on purpose — it only surfaces when a genuine setup or a
          behavioral pattern is actually detected, not on every market tick. Sentinel keeps watching in the background.
        </div>
      ) : (
        <motion.ul initial="hidden" animate="visible" variants={staggerContainer} className="space-y-2.5">
          {cards.map((c) => (
            <motion.div key={c.id} variants={listItem}>
              <SafetyCard card={c} />
            </motion.div>
          ))}
        </motion.ul>
      )}
    </section>
  );
}
