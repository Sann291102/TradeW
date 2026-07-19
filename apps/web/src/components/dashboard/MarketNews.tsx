import { Card, Badge, type BadgeTone } from '@tradew/ui';
import { NEWS, type NewsCategory } from '@/lib/mock/market';

const CATEGORY: Record<NewsCategory, { label: string; tone: BadgeTone }> = {
  company: { label: 'COMPANY', tone: 'brand' },
  market: { label: 'MARKET', tone: 'neutral' },
  economy: { label: 'ECONOMY', tone: 'warning' },
  action: { label: 'CORP ACTION', tone: 'neutral' },
};

/**
 * MarketNews — the "Market News" feed from the canonical home. Sentiment/
 * category pill + headline + time. Independent widget (Step 5). Mock feed;
 * the vendor feed arrives via services/market-data later.
 */
export function MarketNews() {
  return (
    <Card title="Market News" subtitle="· mock feed">
      <ul className="divide-y divide-border">
        {NEWS.map((n) => {
          const cat = CATEGORY[n.category];
          return (
            <li key={n.id} className="flex flex-col gap-1 py-2.5">
              <div className="flex items-start gap-2">
                <Badge tone={cat.tone} className="mt-0.5 shrink-0 px-1.5 py-0 text-[9px]">
                  {cat.label}
                </Badge>
                <span className="text-sm text-text">{n.text}</span>
              </div>
              <div className="pl-1 text-[11px] text-faint">
                {n.time}
                {n.symbol && <span className="ml-1 text-teal">· {n.symbol}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
