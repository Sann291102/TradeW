import { PortfolioClient } from './PortfolioClient';

export const metadata = { title: 'Portfolio — TradeW' };

/**
 * Portfolio workspace — the real paper account.
 *
 * Superseded the mock version (hardcoded PORTFOLIO_SUMMARY stat cards over a
 * permanent "once the trading backend is connected" empty state). That copy was
 * already wrong when it was written: `/sim/portfolio` and `/sim/positions` were
 * live and holding real fills, so the page showed invented figures as the
 * user's own account. The previous file is preserved at
 * archive/web-portfolio-mock-page.tsx.txt per the repo's archive-don't-delete
 * rule.
 *
 * Holdings and Journal tabs are deliberately not carried over: this engine has
 * no delivery/holdings concept distinct from positions, and the journal lives
 * on the Sentinel surface which owns JournalEntry. Two tabs that could only
 * ever render an empty state are worse than two tabs fewer.
 */
export default function PortfolioPage() {
  return <PortfolioClient />;
}
