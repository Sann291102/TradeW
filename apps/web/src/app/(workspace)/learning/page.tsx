import { LearningClient } from '@/components/learning/LearningClient';

export const metadata = { title: 'Learning — TradeW' };

/**
 * Restored 2026-08-04 as the Learning Hub homepage — the original
 * Course/Lesson/Flashcard/Quiz model built on services/api's LearningController
 * (which proxies services/sentinel's learning-platform generation, live and
 * unmodified throughout). Previously archived in favor of the catalog-based
 * design at commit d1c3031; that design is still fully live at
 * /learning/strategies, just no longer the homepage. See
 * archive/README.md's 2026-08-04 entry for the original archiving reasoning
 * and LearningClient.tsx for what changed on restoration (import paths only).
 */
export default function LearningPage() {
  return <LearningClient />;
}
