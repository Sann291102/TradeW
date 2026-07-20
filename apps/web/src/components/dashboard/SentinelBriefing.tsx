import Link from 'next/link';
import { Surface, Badge } from '@tradew/ui';
import { SENTINEL_BRIEFING } from '@/lib/mock/market';
import { SentinelIcon } from '@/components/shell/icons';

/**
 * SentinelBriefing — condensed daily-briefing preview of Sentinel's full
 * observation feed, on the Market Workspace landing page. Links to /sentinel
 * for the full experience. Observation-only, same guardrail as the full
 * page: diagnostic language, never a buy/sell instruction.
 */
export function SentinelBriefing() {
  return (
    <Link href="/sentinel" className="block">
      <Surface elevation={3} interactive className="p-4">
        <div className="flex items-center gap-2">
          <SentinelIcon className="h-4 w-4 text-teal" />
          <h2 className="text-sm font-semibold text-text">Sentinel Daily Briefing</h2>
          <Badge tone="brand" className="ml-auto px-1.5 py-0 text-[9px]">
            {Math.round(SENTINEL_BRIEFING.confidence * 100)}% confidence
          </Badge>
        </div>
        <p className="mt-2 text-sm font-medium text-text">{SENTINEL_BRIEFING.headline}</p>
        <p className="mt-1 text-xs text-muted">{SENTINEL_BRIEFING.body}</p>
        <p className="mt-2 text-[10px] text-faint">Observation only — never a buy/sell instruction.</p>
      </Surface>
    </Link>
  );
}
