import Link from 'next/link';
import { Badge, Card } from '@tradew/ui';
import { SettingsSection } from '@/components/settings/SettingsSection';

export const metadata = { title: 'How to Use — TradeW Settings' };

/**
 * A guide to what each workspace does — and, as importantly, what it does not.
 *
 * Every entry is written from the implementation, not from the product wish
 * list. Where an area is incomplete, the entry says so in the same voice as
 * the rest; instructions for a feature that does not exist are worse than no
 * instructions, because a reader who follows them concludes the app is broken.
 */
interface GuideEntry {
  href: string;
  title: string;
  what: string;
  does: string[];
  doesNot?: string;
  state?: 'partial' | 'not-built';
}

const GUIDE: GuideEntry[] = [
  {
    href: '/dashboard',
    title: 'Home',
    what: 'The market workspace you land on: indices, movers, sector heat, your portfolio summary and the Sentinel briefing in one view.',
    does: [
      'Live index and instrument prices from the market feed',
      'Your paper account summary, read from the same endpoint the Portfolio page uses',
      'Market news and today’s trades',
    ],
    doesNot: 'The economic-calendar widget on this page is illustrative sample content, not a live macro feed. The Calendar workspace uses real exchange data instead.',
  },
  {
    href: '/markets',
    title: 'Markets',
    what: 'Browse instruments, indices and the global board.',
    does: ['Live quotes and market status', 'Instrument search and selection', 'Charts for the selected instrument'],
  },
  {
    href: '/portfolio',
    title: 'Portfolio',
    what: 'Your paper account in full: summary, holdings, positions, orders, trade history and performance.',
    does: [
      'Every figure computed server-side by the order and settlement engine',
      'Holdings with cost, value and overall P&L',
      'Performance from stored portfolio snapshots',
    ],
  },
  {
    href: '/trade',
    title: 'Trade',
    what: 'The dockable trading terminal: chart, option chain, depth, blotter, order ticket, news and Sentinel in one arrangeable workspace.',
    does: [
      'Place paper orders that are matched by TradeW’s own engine',
      'Lot-size and margin checks before an order is accepted',
      'Discipline limits that can stop an order and ask for a typed reason',
    ],
    doesNot: 'Orders are never routed to a broker or an exchange. Nothing you do here moves real money.',
  },
  {
    href: '/orders',
    title: 'Orders',
    what: 'Your order book: pending, filled, cancelled and rejected orders with their reasons.',
    does: ['The same data as Portfolio → Orders, opened directly'],
  },
  {
    href: '/positions',
    title: 'Positions',
    what: 'Open positions with average price, mark, and realised and unrealised P&L.',
    does: ['The same data as Portfolio → Positions, opened directly'],
  },
  {
    href: '/sentinel',
    title: 'AI Sentinel',
    what: 'Market intelligence: day classification, market context, live safety observations, and strategies you define and watch.',
    does: [
      'Describe a strategy in plain language or adopt a built-in one',
      'Watch a market or an option pair and follow the observation timeline',
      'Emotion and trap detection, and the trading journal',
    ],
    doesNot: 'Sentinel observes. It does not place orders and does not take buy or sell commands — that boundary is enforced in the software, not just described.',
  },
  {
    href: '/learning',
    title: 'Learning',
    what: 'Courses, concepts and strategies, with progress tracked on your account.',
    does: ['Structured courses and lessons', 'Concept pages the assistant can link into', 'A strategy browser you can apply from'],
  },
  {
    href: '/backtesting',
    title: 'Backtesting',
    what: 'Replaying a strategy over historical data.',
    does: [],
    doesNot: 'Not built. There is no backtesting engine in TradeW, and the page says so rather than simulating one in the browser.',
    state: 'not-built',
  },
  {
    href: '/research',
    title: 'Research',
    what: 'Market research and analysis on instruments and market structure.',
    does: ['Research surfaces over real instrument and market data'],
  },
  {
    href: '/news',
    title: 'News Feed',
    what: 'Market news from real newswires, associated with symbols.',
    does: ['Filtering by symbol and source', 'Article detail with timestamps'],
  },
  {
    href: '/reports',
    title: 'Reports',
    what: 'Exporting your account records.',
    does: ['CSV exports of your orders, fills, positions and holdings, built from your real account'],
    doesNot: 'There is no reporting service: no generated statements, no scheduling, no stored documents.',
    state: 'partial',
  },
  {
    href: '/notifications',
    title: 'Alerts',
    what: 'Everything TradeW has notified you about: order updates, Sentinel observations, broker state, announcements.',
    does: ['Real notifications from your account', 'Per-category muting in Settings → Notifications'],
  },
  {
    href: '/calendar',
    title: 'Calendar',
    what: 'Upcoming corporate events published by the exchange.',
    does: ['Board meetings and their stated purpose, from NSE'],
    doesNot: 'No economic-release feed, no expiry entries and no personal reminders — none of those exist in the platform.',
    state: 'partial',
  },
  {
    href: '/community',
    title: 'Community',
    what: 'Trader, strategy and learning discussions.',
    does: [],
    doesNot: 'Not built. There is no community backend, and the page shows an empty state rather than seeded posts.',
    state: 'not-built',
  },
];

export default function HowToUsePage() {
  return (
    <SettingsSection
      title="How to use TradeW"
      description="What each workspace does, what it reads from, and where it stops."
    >
      <Card title="Getting started">
        <ol className="space-y-2 text-xs leading-relaxed text-muted">
          <li>
            <span className="font-semibold text-text">1. Set your defaults.</span> Appearance for
            theme and candle colours, Trading for what the order ticket opens with.
          </li>
          <li>
            <span className="font-semibold text-text">2. Connect a broker (optional).</span> Settings
            → Integrations links Dhan for live market data. TradeW never places orders with it.
          </li>
          <li>
            <span className="font-semibold text-text">3. Place a paper order.</span> Open Trade,
            pick an instrument, and use the order ticket. Fills land in Orders and Positions.
          </li>
          <li>
            <span className="font-semibold text-text">4. Watch a strategy.</span> AI Sentinel turns a
            described strategy into a live watch and tells you what it sees.
          </li>
        </ol>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        {GUIDE.map((entry) => (
          <Card key={entry.href} className="flex flex-col">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={entry.href} className="text-sm font-bold text-text hover:text-teal">
                {entry.title}
              </Link>
              {entry.state === 'not-built' && (
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">NOT BUILT</Badge>
              )}
              {entry.state === 'partial' && (
                <Badge tone="warning" className="px-1.5 py-0 text-[9px]">PARTIAL</Badge>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{entry.what}</p>
            {entry.does.length > 0 && (
              <ul className="mt-2 space-y-1">
                {entry.does.map((d) => (
                  <li key={d} className="flex items-start gap-2 text-[11px] text-muted">
                    <span aria-hidden="true" className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-up" />
                    <span>{d}</span>
                  </li>
                ))}
              </ul>
            )}
            {entry.doesNot && (
              <p className="mt-2 text-[11px] leading-relaxed text-amber">{entry.doesNot}</p>
            )}
          </Card>
        ))}
      </div>

      <Card title="Keyboard shortcuts">
        <p className="text-xs text-muted">
          Press <kbd className="rounded border border-border2 bg-bg px-1 font-mono text-[10px]">?</kbd>{' '}
          anywhere in the workspace for the shortcut list, or{' '}
          <kbd className="rounded border border-border2 bg-bg px-1 font-mono text-[10px]">Ctrl/⌘ K</kbd>{' '}
          for the command palette.
        </p>
      </Card>
    </SettingsSection>
  );
}
