import { NewsClient } from './NewsClient';

export const metadata = { title: 'Market News — TradeW' };

/**
 * Market News — its own sidebar destination.
 *
 * Moved off the dashboard, where it competed for space with the market widgets
 * and could only show six items. Headlines are real, from Indian financial
 * newswires via services/api's /news; the previous dashboard widget rendered a
 * hardcoded array from lib/mock/market.ts.
 */
export default function NewsPage() {
  return <NewsClient />;
}
