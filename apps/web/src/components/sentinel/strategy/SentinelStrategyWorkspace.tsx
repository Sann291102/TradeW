'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button } from '@tradew/ui';
import { faultMessage } from '@/lib/sentinel/faults';
import { useUserStrategies, useWatchSessions } from '@/lib/sentinel/useStrategyWorkspace';
import { useWatchPrices } from '@/lib/sentinel/useWatchPrices';
import { byUrgency, groupWatches, selectableStrategies } from '@/lib/sentinel/watchModel';
import type { UserStrategy, WatchSession } from '@/lib/sentinel/strategyApi';
import { InbuiltStrategyPicker } from './InbuiltStrategyPicker';
import { PositionEntryForm } from './PositionEntryForm';
import { SelectedStrategyPanel } from './SelectedStrategyPanel';
import { StrategyComposer } from './StrategyComposer';
import { StrategyList } from './StrategyList';
import { WatchCard } from './WatchCard';
import { WatchCreator } from './WatchCreator';

/**
 * "Your strategies" — the user-authored half of Sentinel, in the Sentinel
 * workspace where the user already is.
 *
 * Left: write a strategy, confirm what Sentinel understood, save it.
 * Right: apply a saved strategy to an instrument, then follow the watches it
 * produced from IDLE through CONFIRMED and, if the user takes a position, to
 * IN_TRADE.
 *
 * This is the browser surface for services/sentinel-py. Nothing in it decides
 * anything: the rules are the user's words, the levels are the user's numbers,
 * and the states come from the engine's own evaluation of those rules.
 */
export function SentinelStrategyWorkspace() {
  const strategiesState = useUserStrategies();
  const watchesState = useWatchSessions();
  const prices = useWatchPrices(watchesState.watches);

  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  /** The watch whose "I'm in" form is open, if any. */
  const [enteringWatchId, setEnteringWatchId] = useState<string | null>(null);
  const [closingWatchId, setClosingWatchId] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const selectable = useMemo(() => selectableStrategies(strategiesState.strategies), [strategiesState.strategies]);

  // Keep a selection pointing at something that still exists; default to the
  // most recent strategy so "apply" is one click after saving one.
  useEffect(() => {
    if (selectable.length === 0) {
      setSelectedStrategyId(null);
      return;
    }
    setSelectedStrategyId((current) =>
      current !== null && selectable.some((s) => s.id === current) ? current : selectable[0].id,
    );
  }, [selectable]);

  const selectedStrategy = selectable.find((s) => s.id === selectedStrategyId) ?? null;
  const grouped = groupWatches(watchesState.watches);
  const watching = [...grouped.watching].sort(byUrgency);

  const handleClose = async (watch: WatchSession) => {
    setClosingWatchId(watch.id);
    try {
      await watchesState.markClosed(watch.id);
    } finally {
      setClosingWatchId(null);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-elev2">
      <header className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-bold text-text">Your strategies</h2>
        <p className="text-[11.5px] text-muted">
          Sentinel watches for the conditions you defined — nothing more, nothing else.
        </p>
        {watching.length + grouped.inTrade.length > 0 && (
          <Badge tone="neutral" className="px-2 py-0 text-[10px]">
            {watching.length} watching · {grouped.inTrade.length} in trade
          </Badge>
        )}
      </header>

      <div className="grid grid-cols-12 items-start gap-5">
        {/* author + own */}
        <div className="col-span-12 space-y-4 lg:col-span-5">
          <StrategyComposer onSave={strategiesState.save} onSaved={(s) => setSelectedStrategyId(s.id)} />

          {/* The two ways in, one under the other. Describing a strategy and
              adopting a definition produce the SAME UserStrategy and continue
              into the same configure/watch/feed workflow — the divider marks a
              choice of input, not two different products. */}
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[10.5px] font-bold uppercase tracking-wide text-faint">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <InbuiltStrategyPicker
            onAdopted={async (id) => {
              await strategiesState.refresh();
              setSelectedStrategyId(id);
            }}
          />

          <div className="border-t border-border pt-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-[12px] font-bold uppercase tracking-wide text-faint">Saved</h3>
              {strategiesState.strategies.length > 0 && (
                <span className="text-[10.5px] text-faint">{selectable.length} available</span>
              )}
            </div>
            {strategiesState.fault ? (
              <Fault message={faultMessage(strategiesState.fault, 'your strategies')} onRetry={strategiesState.refresh} />
            ) : (
              <StrategyList
                strategies={selectable}
                selectedId={selectedStrategyId}
                onSelect={setSelectedStrategyId}
                onPauseResume={(s: UserStrategy) =>
                  strategiesState.setStatus(s.id, s.status === 'paused' ? 'active' : 'paused')
                }
                onArchive={(s: UserStrategy) => strategiesState.archive(s.id)}
                loading={strategiesState.loading}
              />
            )}
          </div>
        </div>

        {/* apply + follow */}
        <div className="col-span-12 space-y-4 lg:col-span-7">
          {selectedStrategyId && (
            <div className="rounded-xl border border-border p-3.5">
              <SelectedStrategyPanel strategyId={selectedStrategyId} />
            </div>
          )}

          {/* WHERE the selected strategy is applied — a different question from
              WHICH strategy, so it is a separate control with its own heading
              rather than a second thing that looks like a strategy picker. */}
          <div className="rounded-xl border border-border p-3.5">
            <h3 className="mb-1 text-[12px] font-bold uppercase tracking-wide text-faint">Watch market</h3>
            <p className="mb-2.5 text-[11px] text-muted">
              {selectedStrategy
                ? `Choose what to run "${selectedStrategy.name}" on.`
                : 'Pick a strategy first — this chooses where it is applied, not what is watched for.'}
            </p>
            <WatchCreator strategy={selectedStrategy} onStart={watchesState.start} />
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-[12px] font-bold uppercase tracking-wide text-faint">Active watches</h3>
              {watchesState.loading && watchesState.watches.length === 0 && (
                <span className="text-[10.5px] text-faint">loading…</span>
              )}
            </div>

            {watchesState.fault ? (
              <Fault message={faultMessage(watchesState.fault, 'your watches')} onRetry={watchesState.refresh} />
            ) : watching.length === 0 && grouped.inTrade.length === 0 ? (
              <p className="rounded-xl border border-border bg-bg px-3 py-6 text-center text-[12px] leading-relaxed text-muted">
                No active watches. Pick a strategy, choose what to watch it on, and Sentinel will tell you when your
                conditions are met.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {grouped.inTrade.map((watch) => (
                  <li key={watch.id}>
                    <WatchCard
                      watch={watch}
                      strategies={strategiesState.strategies}
                      price={prices[watch.id] ?? null}
                      action={
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleClose(watch)}
                            disabled={closingWatchId === watch.id}
                          >
                            {closingWatchId === watch.id ? 'Closing…' : "I've closed this"}
                          </Button>
                          <span className="text-[10.5px] text-faint">
                            Stops the in-trade tracking. It places no order.
                          </span>
                        </div>
                      }
                    />
                  </li>
                ))}

                {watching.map((watch) => (
                  <li key={watch.id}>
                    <WatchCard
                      watch={watch}
                      strategies={strategiesState.strategies}
                      price={prices[watch.id] ?? null}
                      action={
                        enteringWatchId === watch.id ? (
                          <PositionEntryForm
                            watch={watch}
                            livePrice={prices[watch.id] ?? null}
                            onSubmit={async (id, input) => {
                              const updated = await watchesState.markEntered(id, input);
                              setEnteringWatchId(null);
                              return updated;
                            }}
                            onCancel={() => setEnteringWatchId(null)}
                          />
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant={watch.state === 'CONFIRMED' ? 'primary' : 'outline'}
                              onClick={() => setEnteringWatchId(watch.id)}
                            >
                              I&apos;m in
                            </Button>
                            <span className="text-[10.5px] leading-relaxed text-faint">
                              {watch.state === 'CONFIRMED'
                                ? 'Your conditions are met. If you take the position, record your own levels here.'
                                : 'Already taken this position? Record your own levels to have it tracked.'}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleClose(watch)}
                              disabled={closingWatchId === watch.id}
                              className="ml-auto text-[11px] font-semibold text-muted hover:text-down disabled:opacity-50"
                            >
                              Stop watching
                            </button>
                          </div>
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            )}

            {grouped.closed.length > 0 && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowClosed((v) => !v)}
                  className="text-[11px] font-semibold text-muted hover:text-text"
                >
                  {showClosed ? 'Hide' : 'Show'} {grouped.closed.length} closed{' '}
                  {grouped.closed.length === 1 ? 'watch' : 'watches'}
                </button>
                {showClosed && (
                  <ul className="mt-2 space-y-2.5">
                    {grouped.closed.map((watch) => (
                      <li key={watch.id}>
                        <WatchCard watch={watch} strategies={strategiesState.strategies} price={null} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Fault({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  return (
    <div className="rounded-xl border border-border bg-bg px-3 py-4 text-center">
      <p className="text-[12px] leading-relaxed text-muted">{message}</p>
      <button
        type="button"
        onClick={() => void onRetry()}
        className="mt-2 text-[11.5px] font-semibold text-teal hover:underline"
      >
        Try again
      </button>
    </div>
  );
}
