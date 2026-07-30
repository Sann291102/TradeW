import { LearningClient } from './LearningClient';

export const metadata = { title: 'Learning — TradeW' };

/**
 * Learning Hub workspace (LEARNING-HUB.md). The landing grid is now generated
 * from the knowledge graph and made interactive — see LearningClient. The
 * shared mock (`@/lib/mock/learning`) is intentionally left in place because
 * the dockable LearningMiniPanel and the command palette still consume it.
 */
export default function LearningPage() {
  return <LearningClient />;
}
