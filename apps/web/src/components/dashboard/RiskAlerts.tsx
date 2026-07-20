import { Card, Badge, cn } from '@tradew/ui';
import { RISK_ALERTS } from '@/lib/mock/market';

/**
 * RiskAlerts — high/medium-risk market condition alerts on the Market
 * Workspace landing page. Observation-only, same disclaimer posture as
 * Sentinel (never a buy/sell instruction) — these describe market
 * conditions (volatility, liquidity), not trade recommendations.
 */
export function RiskAlerts() {
  return (
    <Card title="Risk Alerts" subtitle="· market conditions, not trade advice">
      <ul className="space-y-2">
        {RISK_ALERTS.map((a) => (
          <li
            key={a.id}
            className={cn(
              'rounded-lg border px-3 py-2',
              a.severity === 'high' ? 'border-down bg-down-bg' : 'border-amber bg-amber-bg',
            )}
          >
            <div className="flex items-center gap-2">
              <Badge tone={a.severity === 'high' ? 'negative' : 'warning'} className="px-1.5 py-0 text-[9px]">
                {a.severity === 'high' ? 'HIGH' : 'MEDIUM'}
              </Badge>
              <span className="text-sm font-semibold text-text">{a.title}</span>
            </div>
            <p className="mt-1 text-xs text-muted">{a.detail}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
