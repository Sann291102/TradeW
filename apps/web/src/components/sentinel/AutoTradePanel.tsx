'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Button, cn } from '@tradew/ui';
import type { BadgeTone } from '@tradew/ui';
import { useAutoTradeStatus, useSetAutoTrade, type AutoTradeStatus } from '@/lib/query/useAutoTrade';

/**
 * Sentinel AutoTrade, in the user's own workspace.
 *
 * ## It renders nothing unless the SERVER says so
 *
 * The component's first branch is `if (!data.visible) return null`, and
 * `visible` is computed by the API from the Sentinel entitlement and the
 * profile's administrator-set state. There is no client-side capability check
 * anywhere in this file — §3 forbids one, and more practically, a client check
 * would disagree with the server the moment an administrator disarms a profile
 * mid-session.
 *
 * Hiding is not the security boundary either. `POST /autotrade/enabled` re-runs
 * the same decision and returns 403 with the failed check, so a user who never
 * saw this panel and posted directly gets refused for the same reason it would
 * have been greyed out.
 *
 * ## PAPER is stated, loudly and always
 *
 * The environment badge is not decoration. A user who believes an agent is
 * trading their real money when it is not — or the reverse — is the worst
 * outcome this panel can produce, so the mode is the largest thing in the
 * header and LIVE is rendered in the warning tone even when everything is
 * healthy.
 *
 * ## The trades are not shown here, on purpose
 *
 * §13: "Do not build a completely separate fake portfolio. Use the actual
 * portfolio system." So this panel counts and links; the trades themselves are
 * read on Orders, Positions and Portfolio, which already show them because the
 * agent writes to those exact tables.
 */
export function AutoTradePanel({ className }: { className?: string }) {
  const { data, isLoading, error } = useAutoTradeStatus();
  const setAutoTrade = useSetAutoTrade();
  const [failure, setFailure] = useState<string | null>(null);

  // While the first request is in flight, and for any account the server has
  // not told us to show it to. Both render nothing rather than a placeholder:
  // a skeleton for a capability most accounts do not have would advertise it.
  if (isLoading || error || !data || !data.visible) return null;

  const env = data.environment ?? 'PAPER';
  const isLive = env === 'LIVE';
  const on = data.autoTradeEnabled;

  const toggle = async () => {
    setFailure(null);
    try {
      await setAutoTrade.mutateAsync(!on);
    } catch (err) {
      // The server's own sentence, which names the condition that failed —
      // "an administrator must arm it", "the broker credential has expired".
      // Far more useful than a generic failure, and it is the only way a user
      // learns what to ask for.
      const body = (err as { body?: { message?: string } }).body;
      setFailure(body?.message ?? (err as Error).message);
    }
  };

  return (
    <section
      className={cn(
        'overflow-hidden rounded-2xl border bg-surface',
        on
          ? isLive
            ? 'border-warning/50 shadow-elev2 ring-1 ring-warning/25'
            : 'border-teal shadow-elev2'
          : 'border-border',
        className,
      )}
      aria-label="Sentinel AutoTrade"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight">Sentinel AutoTrade</h2>
            <Badge tone={isLive ? 'warning' : 'brand'}>{isLive ? 'LIVE TRADING' : 'PAPER TRADING'}</Badge>
            <StateBadge status={data} />
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            {data.profile
              ? `${data.profile.agent} on ${data.profile.symbol}${data.profile.strategyName ? ` · ${data.profile.strategyName}` : ''} · ${data.profile.lots} lot`
              : 'No trading profile is bound to this account.'}
          </p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <Button
            onClick={() => void toggle()}
            disabled={setAutoTrade.isPending || (!on && !data.eligible)}
            variant={on ? 'outline' : 'primary'}
          >
            {setAutoTrade.isPending ? 'Saving…' : on ? 'Stop AutoTrade' : 'Start AutoTrade'}
          </Button>
          {/* Turning it OFF is never gated, so this only ever explains why it
              cannot be turned ON. */}
          {!on && !data.eligible && data.reason && (
            <p className="max-w-[280px] text-right text-[11px] leading-snug text-faint">{data.reason}</p>
          )}
        </div>
      </header>

      {failure && (
        <p className="border-b border-border bg-down-bg/40 px-4 py-2 text-[12px] text-down">{failure}</p>
      )}

      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
        <Metric label="Status" value={on ? 'Active' : 'Stopped'} tone={on ? 'up' : 'muted'} />
        <Metric label="Trades today" value={String(data.today?.trades ?? 0)} sub={`${data.today?.orders ?? 0} orders placed`} />
        <Metric
          label="P&L today"
          value={formatInr(data.today?.realizedPnl ?? 0)}
          tone={(data.today?.realizedPnl ?? 0) > 0 ? 'up' : (data.today?.realizedPnl ?? 0) < 0 ? 'down' : 'muted'}
          sub="realized"
        />
        <Metric
          label="Win rate"
          // Null is "nothing has closed yet", which is not a 0% win rate. The
          // em dash says so; a "0%" would libel a strategy that has not traded.
          value={data.today?.winRate == null ? '—' : `${data.today.winRate}%`}
          sub={data.today && data.today.trades > 0 ? `${data.today.wins}W / ${data.today.losses}L today` : 'no closed trades today'}
        />
      </div>

      {data.performance && data.performance.trades > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-4 py-2.5 text-[12px]">
          <span className="text-faint">All time</span>
          <span className="text-muted">
            <strong className="font-semibold text-fg">{data.performance.trades}</strong> trades
          </span>
          <span className="text-muted">
            <strong className="font-semibold text-fg">
              {data.performance.winRate == null ? '—' : `${data.performance.winRate}%`}
            </strong>{' '}
            win rate
          </span>
          <span className={cn('text-muted', data.performance.realizedPnl < 0 ? 'text-down' : data.performance.realizedPnl > 0 ? 'text-up' : '')}>
            {formatInr(data.performance.realizedPnl)} realized
          </span>
        </div>
      )}

      {/* §10's readout, for the person whose account it is. Shown only in
          paper: once a profile is live the criteria have already served their
          purpose and continuing to show a progress bar would be confusing. */}
      {!isLive && data.qualification && <QualificationStrip qualification={data.qualification} />}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-[11.5px]">
        <p className="text-faint">
          {on
            ? isLive
              ? 'Sentinel is placing REAL broker orders in this account.'
              : 'Sentinel is trading automatically with simulated capital. Every trade appears in your normal Orders and Portfolio.'
            : 'Sentinel is not placing orders for this account.'}
        </p>
        <span className="flex items-center gap-3">
          <Link href="/orders" className="text-teal hover:underline">Orders</Link>
          <Link href="/positions" className="text-teal hover:underline">Positions</Link>
          <Link href="/portfolio" className="text-teal hover:underline">Portfolio</Link>
        </span>
      </footer>
    </section>
  );
}

/**
 * The execution state, named rather than implied.
 *
 * A user seeing "Paused" instead of a stopped toggle knows an administrator did
 * it and that their own switch is not the problem — which is the difference
 * between contacting support and repeatedly clicking a button.
 */
function StateBadge({ status }: { status: AutoTradeStatus }) {
  const state = status.profile?.state;
  if (!state) return null;
  const tone: BadgeTone =
    state === 'ERROR' ? 'negative'
    : state === 'PAUSED' ? 'warning'
    : state === 'LIVE_ARMED' || state === 'LIVE_RUNNING' ? 'warning'
    : state === 'PAPER_QUALIFIED' || state === 'PAPER_RUNNING' ? 'positive'
    : 'neutral';
  return (
    <Badge tone={tone} title={status.profile?.stateDescription}>
      {status.profile!.stateLabel}
    </Badge>
  );
}

/**
 * Progress toward the paper-trading qualification.
 *
 * States plainly that passing does not start live trading. That sentence is
 * there because the alternative — a progress bar labelled "qualification" with
 * no explanation — implies an automatic promotion at 100%, and §10/§11 are
 * emphatic that no such promotion exists.
 */
function QualificationStrip({ qualification: q }: { qualification: NonNullable<AutoTradeStatus['qualification']> }) {
  const met = q.results.filter((r) => r.met).length;
  const total = q.results.length || 1;

  return (
    <div className="border-t border-border px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Paper track record</h3>
        <Badge tone={q.passed ? 'positive' : 'neutral'}>
          {q.passed ? 'Qualification passed' : 'Qualification not yet passed'}
        </Badge>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
        <div
          className={cn('h-full rounded-full transition-all', q.passed ? 'bg-up' : 'bg-teal')}
          style={{ width: `${Math.round((met / total) * 100)}%` }}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-faint">
        <span>{q.metrics.trades} trades</span>
        <span>{q.metrics.tradingDays} trading days</span>
        <span>{q.metrics.winRate == null ? '—' : `${Math.round(q.metrics.winRate)}%`} win rate</span>
        <span>{formatInr(q.metrics.netPnl)} net</span>
        <span>{q.metrics.maxDrawdownPct}% max drawdown</span>
      </div>

      {!q.passed && q.unmet.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11.5px] leading-snug text-faint">
          {q.unmet.map((u) => (
            <li key={u.id}>· {u.detail}</li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[11px] leading-snug text-faint">
        Qualifying does not switch this account to live trading. Live execution is a separate authorization that only
        a TradeW administrator can grant.
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = 'muted',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'up' | 'down' | 'muted';
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-[18px] font-semibold tabular-nums leading-none',
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-fg',
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

function formatInr(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}
