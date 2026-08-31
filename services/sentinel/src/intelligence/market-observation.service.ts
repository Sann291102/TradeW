import { Injectable, Logger } from '@nestjs/common';
import { MarketIntelligenceService } from './market-intelligence.service';
import {
  projectObservation,
  resolveInterval,
  type MarketObservation,
} from './market-observation';

/**
 * The observation-only read of a symbol, for the assistant surface.
 *
 * ── WHY THIS IS A THIN SERVICE AND NOT A SECOND ORCHESTRATOR ───────────────
 *
 * It does three things: ask `MarketIntelligenceService` for the canonical
 * snapshot on the requested interval, optionally ask it for the CE/PE legs on
 * those same bars, and hand both to the pure projection. There is no scan, no
 * confidence engine, no publication gate and no state machine — those produce
 * Sentinel's VERDICT, which is the premium product and is deliberately not
 * reachable from here.
 *
 * That absence is the design. `/observe` costs ten agents and a gate because
 * its output is a conclusion; this costs one snapshot because its output is a
 * set of measurements. Routing the assistant through the orchestrator would
 * have made every "what is NIFTY doing" a premium-priced request for facts the
 * user can already read off their own chart.
 *
 * ── ONE SNAPSHOT, THREE CONSUMERS ──────────────────────────────────────────
 *
 *   MarketIntelligenceService.snapshot()   ← the canonical MarketSnapshot
 *     ├─ SentinelOrchestrator     → /observe            (premium verdict)
 *     ├─ ExecutionEvaluation      → /execution/evaluate (paper agents)
 *     └─ this                     → /market-observation (Tara, measurements)
 *
 * All three describe one market because all three read one composition.
 */
@Injectable()
export class MarketObservationService {
  private readonly log = new Logger(MarketObservationService.name);

  constructor(private readonly market: MarketIntelligenceService) {}

  /**
   * Read one symbol on one timeframe.
   *
   * Throws whatever the market-data provider throws (`MarketDataUnavailableError`
   * in particular) — the controller maps that to a 503 so the caller can tell
   * "no real data for this symbol" from "the service is broken". Fabricating a
   * degraded observation instead would be the exact failure the provider's
   * no-simulator-fallback rule exists to prevent.
   */
  async observe(input: {
    symbol: string;
    timeframe: string;
    /** Read the CE/PE legs at the money on the same bars. Off by default. */
    includeContracts?: boolean;
    now?: Date;
  }): Promise<{ ok: true; observation: MarketObservation } | { ok: false; reason: string }> {
    const resolved = resolveInterval(input.timeframe);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    const snapshot = await this.market.snapshot(input.symbol, resolved.interval);

    // Additive and never fatal, exactly as it is on the orchestrator path: a
    // provider without contract-series capability degrades the CE/PE block to
    // "unreadable, and here is why", it does not fail the read of the
    // underlying that is otherwise fine.
    let contracts = null;
    if (input.includeContracts) {
      contracts = await this.market.contracts(snapshot).catch((err: unknown) => {
        this.log.warn(
          `contract read failed for ${input.symbol} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      });
    }

    return {
      ok: true,
      observation: projectObservation({
        snapshot,
        timeframe: resolved.interval,
        requestedTimeframe: input.timeframe,
        timeframeNote: resolved.note,
        now: input.now ?? new Date(),
        contracts,
      }),
    };
  }
}
