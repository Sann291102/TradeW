import { Card, Badge, EmptyState } from '@tradew/ui';
import { ResearchIcon, SearchIcon } from '@/components/shell/icons';
import { RESEARCH_TABS } from '@/lib/mock/research';

export const metadata = { title: 'Research — TradeW' };

/**
 * Research workspace — TradeW AI's dedicated per-symbol deep-dive surface
 * (TRADEW-AI.md §2). Not built yet (that's TradeW AI agent work, out of scope
 * for this frontend-only milestone); this is the premium "coming soon" state
 * the Milestone 3 brief asks for — a real page with the planned structure
 * visible, not a blank route. Search + tab chips are disabled placeholders.
 */
export default function ResearchPage() {
  return (
    <div className="mx-auto max-w-[900px] p-4">
      <Card>
        <div className="relative mb-4">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            disabled
            placeholder="Search a symbol to research…"
            aria-label="Search a symbol to research"
            className="w-full cursor-not-allowed rounded-lg border border-border2 bg-bg py-2.5 pl-9 pr-3 text-sm text-faint placeholder:text-faint"
          />
        </div>
        <div className="mb-5 flex flex-wrap gap-1.5">
          {RESEARCH_TABS.map((t) => (
            <Badge key={t} tone="neutral" className="cursor-not-allowed px-2 py-0.5 text-[10px] opacity-60">
              {t}
            </Badge>
          ))}
        </div>
        <EmptyState
          icon={<ResearchIcon className="h-7 w-7" />}
          title="Research workspace — coming soon"
          description="Deep, structured per-symbol analysis (fundamentals, financials, shareholding, corporate actions, technicals, risk factors) powered by TradeW AI&apos;s Company/News/Technical Analysis agents. Observations only — never investment advice."
        />
      </Card>
    </div>
  );
}
