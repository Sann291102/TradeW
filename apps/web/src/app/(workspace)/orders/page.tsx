import { PortfolioClient } from '../portfolio/PortfolioClient';

export const metadata = { title: 'Orders — TradeW' };

/**
 * Orders as a top-level destination.
 *
 * The order book has always existed — it is the Portfolio workspace's "Orders"
 * section, reading `/sim/orders` through `lib/query/usePortfolio`. What was
 * missing was a way to get to it in one click, and a URL to bookmark. This
 * route supplies both by opening the SAME workspace on that section; there is
 * no duplicated table and no second source of order data.
 *
 * The in-page rail is still there, so a trader who lands here can move to
 * Positions or Trade History without going back out to the sidebar.
 */
export default function OrdersPage() {
  return <PortfolioClient initialSection="orders" />;
}
