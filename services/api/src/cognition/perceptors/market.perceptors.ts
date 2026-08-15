import { NewPercept, SenseContext } from '@tradew/ai-core';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaPerceptor, clamp01 } from './shared';

/**
 * The market domain — what Sentinel noticed, and how well its gate is tuned.
 *
 * WHAT THIS DOMAIN DELIBERATELY DOES NOT DO
 *
 * It does not analyse the market. Sentinel already does that, with a compliance
 * vocabulary, an evidence trail and a publication gate that four independent
 * conditions have to satisfy before a single word reaches a trader. Building a
 * second analytical path here would produce a system that can reach a user's
 * screen without passing that gate, which ARCHITECTURE Rule 2 forbids and which
 * would be the most consequential mistake available in this codebase.
 *
 * So these perceptors are **meta**: they observe Sentinel observing. They read
 * the observations Sentinel logged and the runs it published or suppressed, and
 * what they learn is which of Sentinel's patterns actually correspond to things
 * that recur, and whether the gate is set somewhere sensible. That is knowledge
 * about the *analyst*, not about the market, and it is safe to hold here.
 *
 * L4 refuses to turn a market hypothesis into a proposal for the same reason —
 * see `ConsolidationLayer.proposalFor`.
 */

// ---------------------------------------------------------------------------

/**
 * Patterns Sentinel logged, grouped by pattern and symbol.
 *
 * Feeds the association layer with the vocabulary Sentinel actually uses, so
 * over time the network learns which patterns co-occur and which ones precede
 * outcomes that got scored. This is the raw material for "bull_trap on this
 * symbol tends to show up alongside a liquidity sweep" — a claim about
 * Sentinel's own reasoning, learned from its own logs.
 */
export class SentinelObservationPerceptor extends PrismaPerceptor {
  constructor(prisma: PrismaService) {
    super(
      {
        id: 'market.sentinel-observations',
        domain: 'market',
        label: 'Sentinel observations',
        description: 'Patterns Sentinel logged in the window, grouped by pattern and symbol. Observes the analyst, not the market.',
        cadence: 'interval',
        expectedIntervalMs: 5 * 60_000,
        emits: ['pattern_observed', 'pattern_cluster'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const rows = await this.prisma.sentinelObservation.groupBy({
      by: ['pattern', 'symbol', 'agent'],
      where: { createdAt: { gte: context.since, lt: context.until }, pattern: { not: null } },
      _count: { _all: true },
      _avg: { confidence: true },
      _max: { confidence: true },
    });

    return rows.map((row) => {
      const avgConfidence = row._avg.confidence ?? 0.5;
      const count = row._count._all;
      return this.percept({
        // A pattern seen once is an observation; the same pattern seen several
        // times in one window is a cluster, and the network should treat the
        // two differently — repetition inside a five-minute window usually means
        // several agents converged, which is the interesting case.
        kind: count > 1 ? 'pattern_cluster' : 'pattern_observed',
        subject: { type: 'symbol', id: row.symbol ?? 'market-wide', label: row.symbol ?? 'market-wide' },
        observedAt: context.until,
        // Sentinel's own confidence drives salience: a pattern it barely
        // believes should not command the network's attention just because it
        // was written down.
        salience: clamp01(avgConfidence * (count > 1 ? 1 : 0.8)),
        confidence: avgConfidence,
        features: { observations: count, avgConfidence, maxConfidence: row._max.confidence ?? 0 },
        summary: `${row.agent} logged ${row.pattern} on ${row.symbol ?? 'the market'} ${count}× at ${(avgConfidence * 100).toFixed(0)}% confidence`,
        payload: { pattern: row.pattern, agent: row.agent },
        occurrences: count,
        tags: ['sentinel', row.pattern ?? 'unlabelled', row.agent],
      });
    });
  }
}

// ---------------------------------------------------------------------------

/**
 * How often Sentinel spoke versus stayed silent, and at what confidence.
 *
 * Sentinel staying quiet is a designed behaviour, not an error — so this is a
 * *calibration* read-out, and it is the only place the platform asks whether
 * the publication gate is set anywhere sensible. Two failure modes, opposite
 * and equally bad: a gate so tight that nothing ever reaches a trader (the
 * product does nothing), and one so loose that everything does (the product is
 * noise and the compliance surface widens for no benefit).
 *
 * Fires only at the extremes, because a healthy silent rate covers a wide band
 * and an alarm inside that band is an alarm operators learn to ignore.
 */
export class PublicationGatePerceptor extends PrismaPerceptor {
  /** Below this surfaced-rate the gate is suspiciously tight. */
  private static readonly TIGHT = 0.02;
  /** Above this it is suspiciously loose. */
  private static readonly LOOSE = 0.6;
  /** Fewer runs than this in the window is not enough to judge either way. */
  private static readonly MIN_RUNS = 20;

  constructor(prisma: PrismaService) {
    super(
      {
        id: 'market.publication-gate',
        domain: 'market',
        label: 'Publication gate calibration',
        description: 'Surfaced-versus-silent rate across Sentinel runs. Silence is designed behaviour, so this fires only when the rate reaches an extreme.',
        cadence: 'interval',
        expectedIntervalMs: 30 * 60_000,
        emits: ['gate_too_tight', 'gate_too_loose'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    // A wider window than the pass: a five-minute sample of a rate that is
    // meant to sit near a few percent is almost always zero, and would report
    // "too tight" continuously and meaninglessly.
    const since = new Date(context.until.getTime() - 6 * 3_600_000);

    const [runs, surfaced, confidence] = await Promise.all([
      this.prisma.agentRun.count({ where: { system: 'sentinel', startedAt: { gte: since }, status: 'ok' } }),
      this.prisma.agentRun.count({ where: { system: 'sentinel', startedAt: { gte: since }, status: 'ok', surfaced: true } }),
      this.prisma.agentRun.aggregate({
        where: { system: 'sentinel', startedAt: { gte: since }, confidence: { not: null } },
        _avg: { confidence: true },
      }),
    ]);

    if (runs < PublicationGatePerceptor.MIN_RUNS) return [];
    const rate = surfaced / runs;
    const tooTight = rate < PublicationGatePerceptor.TIGHT;
    const tooLoose = rate > PublicationGatePerceptor.LOOSE;
    if (!tooTight && !tooLoose) return [];

    return [
      this.percept({
        kind: tooTight ? 'gate_too_tight' : 'gate_too_loose',
        subject: { type: 'subsystem', id: 'publication-gate', label: 'Sentinel publication gate' },
        observedAt: context.until,
        salience: tooLoose ? 0.75 : 0.5,
        confidence: this.sampleConfidence(runs, 40),
        features: { runs, surfaced, surfacedRate: rate, avgConfidence: confidence._avg.confidence ?? 0 },
        summary: tooTight
          ? `Sentinel surfaced ${surfaced} of ${runs} runs (${(rate * 100).toFixed(1)}%) over 6h — the gate may be too tight`
          : `Sentinel surfaced ${surfaced} of ${runs} runs (${(rate * 100).toFixed(1)}%) over 6h — the gate may be too loose`,
        tags: ['sentinel', 'calibration'],
      }),
    ];
  }
}

// ---------------------------------------------------------------------------

/** Classified news, weighted by event type and how many symbols it touches. */
export class NewsPerceptor extends PrismaPerceptor {
  /**
   * Event types that move things. Everything else is recorded at a low weight
   * rather than discarded — the association layer can still learn that a type
   * this list calls unimportant reliably precedes something that is.
   */
  private static readonly HIGH_IMPACT = new Set([
    'earnings',
    'guidance',
    'regulatory',
    'monetary_policy',
    'merger_acquisition',
    'credit_rating',
  ]);

  constructor(prisma: PrismaService) {
    super(
      {
        id: 'market.news',
        domain: 'market',
        label: 'Classified news',
        description: 'News events in the window, weighted by category and breadth. Low-impact categories are kept at low weight rather than dropped.',
        cadence: 'interval',
        expectedIntervalMs: 5 * 60_000,
        emits: ['news_event'],
        enabled: true,
      },
      prisma,
    );
  }

  async sense(context: SenseContext): Promise<NewPercept[]> {
    const events = await this.prisma.newsEvent.findMany({
      where: { createdAt: { gte: context.since, lt: context.until } },
      select: { id: true, headline: true, eventType: true, symbols: true, confidence: true, publishedAt: true, source: true },
      orderBy: { publishedAt: 'desc' },
      take: 100,
    });

    return events.map((event) => {
      const impact = NewsPerceptor.HIGH_IMPACT.has(event.eventType) ? 0.8 : 0.3;
      // Breadth matters: an item touching a dozen symbols is a sector or macro
      // event, and that is a different thing from a single-name headline.
      const breadth = clamp01(event.symbols.length / 10);
      return this.percept({
        kind: 'news_event',
        subject: {
          type: 'symbol',
          id: event.symbols[0] ?? 'market-wide',
          label: event.symbols[0] ?? 'market-wide',
        },
        // The publication time, not ingestion time — a backfilled item from
        // this morning must not read as breaking now.
        observedAt: event.publishedAt,
        salience: clamp01(impact + breadth * 0.2),
        confidence: event.confidence ?? 0.5,
        features: { symbolCount: event.symbols.length, impact },
        summary: `${event.eventType}: ${event.headline.slice(0, 160)}`,
        payload: { eventId: event.id, source: event.source, symbols: event.symbols },
        tags: ['news', event.eventType],
      });
    });
  }
}

export function marketPerceptors(prisma: PrismaService) {
  return [new SentinelObservationPerceptor(prisma), new PublicationGatePerceptor(prisma), new NewsPerceptor(prisma)];
}
