import { Panel, Badge, type BadgeTone } from '@tradew/ui';
import { NEWS, type NewsCategory } from '@/lib/mock/market';
import type { DockPanelContentProps } from './types';

const TONE: Record<NewsCategory, BadgeTone> = {
  company: 'brand',
  market: 'neutral',
  economy: 'warning',
  action: 'neutral',
};

/** News slot — compact market news feed for the terminal (mock). */
export function NewsPanel({ className, actions, collapsed }: DockPanelContentProps) {
  return (
    <Panel title="News" className={className} actions={actions} collapsed={collapsed}>
      <ul className="space-y-2">
        {NEWS.slice(0, 5).map((n) => (
          <li key={n.id} className="flex items-start gap-2">
            <Badge tone={TONE[n.category]} className="mt-0.5 shrink-0 px-1 py-0 text-[8px]">
              {n.category.toUpperCase()}
            </Badge>
            <div>
              <p className="text-[12px] leading-snug text-text">{n.text}</p>
              <span className="text-[10px] text-faint">{n.time}</span>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
