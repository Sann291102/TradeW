import { Card, Badge, type BadgeTone } from '@tradew/ui';
import { ECONOMIC_EVENTS } from '@/lib/mock/market';

const IMPACT_TONE: Record<string, BadgeTone> = { high: 'negative', medium: 'warning', low: 'neutral' };

/**
 * EconomicCalendar — upcoming macro events for the Market Workspace landing
 * page. Independent widget; impact badges reuse the same tone system as
 * everywhere else (never a market-direction color for non-market data).
 */
export function EconomicCalendar() {
  return (
    <Card title="Economic Calendar">
      <ul className="divide-y divide-border">
        {ECONOMIC_EVENTS.map((e) => (
          <li key={e.id} className="flex items-center gap-3 py-2">
            <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-faint">{e.time}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-text">{e.title}</span>
            <span className="shrink-0 text-[10px] text-faint">{e.region}</span>
            <Badge tone={IMPACT_TONE[e.impact]} className="shrink-0 px-1.5 py-0 text-[9px]">
              {e.impact.toUpperCase()}
            </Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}
