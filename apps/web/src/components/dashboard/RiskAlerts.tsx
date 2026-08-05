import { Card, Badge, cn } from '@tradew/ui';
import { RISK_ALERTS } from '@/lib/mock/market';

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3.5 22 20H2L12 3.5Z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

/**
 * RiskAlerts — the "Market Alerts" card (renamed in copy only; component/file
 * name kept for a stable diff and because it still lives at
 * MarketWorkspace.tsx's known import path). Observation-only, same
 * disclaimer posture as Sentinel (never a buy/sell instruction). No backend
 * alerts feed exists, so this stays on the mock `RISK_ALERTS` list — no
 * fabricated timestamp is added (the data has none), unlike widgets with a
 * real live/preview split.
 */
export function RiskAlerts() {
  return (
    <Card title="Market Alerts" subtitle="· market conditions, not trade advice">
      <ul className="space-y-1.5">
        {RISK_ALERTS.map((a) => (
          <li
            key={a.id}
            className={cn(
              'rounded-lg border px-3 py-2',
              a.severity === 'high' ? 'border-down/40 bg-down-bg' : 'border-amber/40 bg-amber-bg',
            )}
          >
            <div className="flex items-start gap-2">
              <AlertIcon className={a.severity === 'high' ? 'mt-0.5 shrink-0 text-down' : 'mt-0.5 shrink-0 text-amber'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-text">{a.title}</span>
                  <Badge tone={a.severity === 'high' ? 'negative' : 'warning'} className="px-1.5 py-0 text-[9px]">
                    {a.severity === 'high' ? 'HIGH' : 'MEDIUM'}
                  </Badge>
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted">{a.detail}</p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
