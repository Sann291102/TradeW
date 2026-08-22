import { PortfolioClient } from '../portfolio/PortfolioClient';

export const metadata = { title: 'Positions — TradeW' };

/** Positions as a top-level destination — the Portfolio workspace opened on
 *  its Positions section. See `../orders/page.tsx` for why this is a prop and
 *  not a copy. */
export default function PositionsPage() {
  return <PortfolioClient initialSection="positions" />;
}
