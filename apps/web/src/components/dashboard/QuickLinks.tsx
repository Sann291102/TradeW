import Link from 'next/link';
import { Surface } from '@tradew/ui';
import { MarketsIcon, TradeIcon, ResearchIcon, SentinelIcon } from '@/components/shell/icons';

/**
 * QuickLinks — one-click jumps from the Market Workspace to the surfaces the
 * user's vision calls out by name (NIFTY, BANKNIFTY, Option Chain, Research,
 * Journal). Destinations are today's real routes; re-pointable to dedicated
 * Index/Trade workspaces in a later phase without touching this layout.
 */
const LINKS = [
  { label: 'NIFTY', href: '/markets', icon: MarketsIcon },
  { label: 'BANKNIFTY', href: '/markets', icon: MarketsIcon },
  { label: 'Option Chain', href: '/trade', icon: TradeIcon },
  { label: 'Research', href: '/research', icon: ResearchIcon },
  { label: 'Journal', href: '/sentinel', icon: SentinelIcon },
] as const;

export function QuickLinks() {
  return (
    <section aria-label="Quick links" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {LINKS.map(({ label, href, icon: Icon }) => (
        <Link key={label} href={href}>
          <Surface elevation={1} interactive className="flex flex-col items-center gap-1.5 px-3 py-3 text-center">
            <Icon className="h-5 w-5 text-teal" />
            <span className="text-xs font-semibold text-text">{label}</span>
          </Surface>
        </Link>
      ))}
    </section>
  );
}
