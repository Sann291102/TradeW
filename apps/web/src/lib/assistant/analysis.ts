import { api } from '../api';

/**
 * Tara's market-analysis client — and the rule that makes it safe.
 *
 * ── THE JSON IS AUTHORITATIVE FOR EVERY NUMBER ─────────────────────────────
 *
 * Every figure Tara speaks about a market comes out of the payload this module
 * fetches, formatted by `formatObservation` below. Nothing here computes an
 * indicator, and nothing here asks a model what a number is. That is the
 * AI-OS rule ("structured JSON is authoritative for anything numeric") applied
 * where it matters most: the surface that talks to people.
 *
 * The alternative — letting the conversation brain narrate an analysis — fails
 * in a way that is invisible. A model given a chart and asked for the RSI will
 * produce a plausible number, and a plausible number on a trading screen is
 * indistinguishable from a measured one until someone acts on it. So the model
 * is never in the numeric path: the deterministic grammar decides an analysis
 * was requested, this module fetches the measurements, and this module renders
 * them.
 *
 * ── ONE ENGINE, NOT A FOURTH ───────────────────────────────────────────────
 *
 * `/market-analysis` proxies to `services/sentinel`'s `/market-observation`,
 * which projects the SAME `MarketSnapshot` that Sentinel's own observation and
 * the autonomous paper agents are computed from. There is deliberately no
 * client-side indicator maths here. The repository already carries three EMA
 * implementations (`services/sentinel`, `services/sentinel-py`, and the
 * unused `lib/sentinel/indicators.ts`); a fourth on the assistant path would
 * guarantee that what Tara says and what an agent traded on eventually
 * disagree, with no way to arbitrate which is right.
 *
 * ── WHAT THIS DELIBERATELY CANNOT RECEIVE ──────────────────────────────────
 *
 * No `synthesis`, no publication verdict, no `sideInFocus`, no strategy advice.
 * Those are Sentinel's premium reasoning and they are filtered on both sides of
 * the hop. The types below have nowhere to put one, which is the point.
 */

// ---------------------------------------------------------------------------
// Wire types — mirror services/sentinel/src/intelligence/market-observation.ts
// ---------------------------------------------------------------------------

export interface ObservationBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ObservationIndicators {
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  vwap: number | null;
  macdHistogram: number | null;
  cpr: { pivot: number; bc: number; tc: number } | null;
  volumeVsAvg: number | null;
  realizedVolPct: number | null;
  vix: number | null;
  breadthRatio: number | null;
  support: number | null;
  resistance: number | null;
}

export interface MarketObservation {
  symbol: string;
  timeframe: string;
  requestedTimeframe: string;
  timeframeNote: string | null;
  observedAt: string;
  barAt: string | null;
  lastPrice: number | null;
  latestBar: ObservationBar | null;
  session: {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
    bars: number;
  };
  priorDay: ObservationBar | null;
  openingRange: { high: number; low: number; establishedAt: string } | null;
  indicators: ObservationIndicators;
  trend: {
    sessionChangePct: number;
    momentumScore: number;
    volumeStrength: number;
    direction: 'bullish' | 'bearish' | 'neutral';
  } | null;
  marketProfile: {
    type: string;
    description: string;
    trend: string;
    volatility: string;
    structure: string;
    evidence: string[];
  } | null;
  regime: string | null;
  structure: {
    state: string;
    event: string | null;
    eventDirection: string | null;
    lastSwingHigh: number | null;
    lastSwingLow: number | null;
    evidence: string[];
  } | null;
  liquidity: {
    pools: { price: number; side: 'above' | 'below'; touches: number; swept: boolean }[];
    recentSweep: { side: 'above' | 'below'; price: number; reclaimed: boolean } | null;
  } | null;
  optionChain: {
    frontExpiry: string;
    pcr: number;
    maxPain: number;
    callOIWall: number | null;
    putOIWall: number | null;
    strikesAnalysed: number;
    atmStrike: number | null;
    atm: {
      strike: number;
      callOI: number;
      putOI: number;
      callLtp: number | null;
      putLtp: number | null;
      callIV: number | null;
      putIV: number | null;
    } | null;
  } | null;
  contracts: {
    readable: boolean;
    unreadableReason: string | null;
    strike: number | null;
    expiry: string | null;
    ce: { strike: number; changePct: number | null; direction: string | null; unavailableReason: string | null } | null;
    pe: { strike: number; changePct: number | null; direction: string | null; unavailableReason: string | null } | null;
    alignment: string | null;
    notes: string[];
  } | null;
  indexDirection: {
    direction: string;
    strength: number;
    votes: { id: string; label: string; direction: string; weight: number; detail: string }[];
    conflicts: string[];
    summary: string;
  } | null;
  freshness: {
    ok: boolean;
    candles: number;
    newestBarAt: string | null;
    barAgeMinutes: number | null;
    reason: string | null;
    checks: { id: string; label: string; passed: boolean; detail: string }[];
  };
  unavailable: { field: string; reason: string }[];
}

export interface SymbolCoverage {
  symbol: string;
  kind: 'nse-canonical' | 'crypto' | 'fx' | 'unknown';
  analysable: boolean;
  reason: string | null;
  dataSource: string;
}

export interface MarketAnalysisResult {
  ok: boolean;
  coverage: SymbolCoverage;
  observation?: MarketObservation;
  reason?: string;
}

/**
 * Ask for measurements.
 *
 * Throws on transport failure rather than returning a partial result — the
 * caller says "I couldn't reach the analysis engine" instead of narrating an
 * observation that is missing half its fields.
 */
export async function fetchMarketAnalysis(
  symbol: string,
  timeframe: string,
  includeContracts: boolean,
): Promise<MarketAnalysisResult> {
  return (await api('/market-analysis', {
    method: 'POST',
    body: JSON.stringify({ symbol, timeframe, includeContracts }),
  })) as MarketAnalysisResult;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const num = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Two decimals only where they carry information, matching `detectors.ts`. */
function n(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? whole.format(value) : num.format(value);
}

function pct(value: number | null | undefined, digits = 2): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function istTime(isoString: string | null): string | null {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Render one observation as Tara's reply.
 *
 * ── EVERY LINE IS A MEASUREMENT OR AN ABSENCE ──────────────────────────────
 *
 * There is no sentence here that is not either a number from the payload or an
 * explicit statement that a number could not be taken. In particular there is
 * no "looks constructive", no "approaching resistance", no "watch for" — those
 * are readings of the data rather than the data, and the line between the two
 * is what keeps this an observation surface rather than an advice surface
 * (`TRADEW-AI.md` §4).
 *
 * The classifications that DO appear (trend direction, market profile, market
 * structure state, index direction) are not this function's opinions: each is a
 * labelled output of the canonical engine, carried verbatim with the evidence
 * the engine recorded for it.
 */
export function formatObservation(o: MarketObservation): string {
  const lines: string[] = [];
  const i = o.indicators;

  const barTime = istTime(o.barAt);
  lines.push(
    `**${o.symbol} · ${o.timeframe}**${barTime ? ` — last bar ${barTime} IST` : ''}`,
  );
  if (o.timeframeNote) lines.push(`_${o.timeframeNote}_`);
  lines.push('');

  // ---- price ------------------------------------------------------------
  const last = n(o.lastPrice);
  if (last) {
    const change = o.trend ? pct(o.trend.sessionChangePct) : null;
    lines.push(`**Price** ${last}${change ? ` · session ${change}` : ''}`);
  } else {
    lines.push('**Price** — not available from the bars read.');
  }

  const bar = o.latestBar;
  if (bar) {
    lines.push(
      `Last bar O ${n(bar.open)} · H ${n(bar.high)} · L ${n(bar.low)} · C ${n(bar.close)} · Vol ${whole.format(bar.volume)}`,
    );
  }
  if (o.session.bars > 0) {
    lines.push(
      `Session H ${n(o.session.high)} · L ${n(o.session.low)} · ${o.session.bars} bar${o.session.bars === 1 ? '' : 's'}`,
    );
  }
  lines.push('');

  // ---- indicators -------------------------------------------------------
  const indicatorParts = [
    i.rsi14 != null ? `RSI(14) ${i.rsi14.toFixed(1)}` : null,
    i.ema20 != null ? `EMA20 ${n(i.ema20)}` : null,
    i.ema50 != null ? `EMA50 ${n(i.ema50)}` : null,
    i.vwap != null ? `VWAP ${n(i.vwap)}` : null,
    i.macdHistogram != null ? `MACD hist ${i.macdHistogram.toFixed(2)}` : null,
    i.volumeVsAvg != null ? `Volume ${i.volumeVsAvg.toFixed(2)}× the 20-bar average` : null,
    i.realizedVolPct != null ? `Realised vol ${i.realizedVolPct.toFixed(2)}%` : null,
    i.vix != null ? `VIX ${n(i.vix)}` : null,
    i.breadthRatio != null ? `Breadth ${i.breadthRatio.toFixed(2)} adv/dec` : null,
  ].filter(Boolean) as string[];
  if (indicatorParts.length) {
    lines.push('**Indicators**');
    lines.push(indicatorParts.join(' · '));
    lines.push('');
  }

  if (i.cpr) {
    lines.push(`**CPR** pivot ${n(i.cpr.pivot)} · BC ${n(i.cpr.bc)} · TC ${n(i.cpr.tc)}`);
    lines.push('');
  }

  // ---- levels -----------------------------------------------------------
  const levelParts = [
    i.support != null ? `Support ${n(i.support)}` : null,
    i.resistance != null ? `Resistance ${n(i.resistance)}` : null,
    o.openingRange ? `Opening range ${n(o.openingRange.low)}–${n(o.openingRange.high)}` : null,
  ].filter(Boolean) as string[];
  if (levelParts.length) {
    lines.push('**Levels**');
    lines.push(levelParts.join(' · '));
    lines.push('');
  }

  // ---- structure & regime ----------------------------------------------
  if (o.structure) {
    const event = o.structure.event
      ? ` · ${o.structure.event}${o.structure.eventDirection ? ` (${o.structure.eventDirection})` : ''}`
      : '';
    const swings = [
      o.structure.lastSwingHigh != null ? `last swing high ${n(o.structure.lastSwingHigh)}` : null,
      o.structure.lastSwingLow != null ? `last swing low ${n(o.structure.lastSwingLow)}` : null,
    ].filter(Boolean);
    lines.push('**Structure**');
    lines.push(`${o.structure.state}${event}${swings.length ? ` · ${swings.join(' · ')}` : ''}`);
    lines.push('');
  }

  if (o.marketProfile) {
    lines.push('**Market profile**');
    lines.push(
      `${o.marketProfile.type}${o.regime ? ` · regime ${o.regime}` : ''} — ${o.marketProfile.description}`,
    );
    lines.push('');
  }

  if (o.trend) {
    lines.push('**Momentum**');
    lines.push(
      `Direction ${o.trend.direction} · directional persistence ${(o.trend.momentumScore * 100).toFixed(0)}% · volume ${o.trend.volumeStrength.toFixed(2)}× average`,
    );
    lines.push('');
  }

  // ---- liquidity --------------------------------------------------------
  if (o.liquidity && (o.liquidity.pools.length || o.liquidity.recentSweep)) {
    lines.push('**Liquidity**');
    if (o.liquidity.recentSweep) {
      const s = o.liquidity.recentSweep;
      lines.push(
        `Recent sweep ${s.side} ${n(s.price)}${s.reclaimed ? ', reclaimed' : ', not reclaimed'}`,
      );
    }
    const pools = o.liquidity.pools
      .slice(0, 3)
      .map((p) => `${n(p.price)} (${p.side}, ${p.touches} touch${p.touches === 1 ? '' : 'es'}${p.swept ? ', swept' : ''})`);
    if (pools.length) lines.push(`Resting: ${pools.join(' · ')}`);
    lines.push('');
  }

  // ---- index direction --------------------------------------------------
  if (o.indexDirection) {
    lines.push('**Index direction**');
    lines.push(
      `${o.indexDirection.direction} at ${(o.indexDirection.strength * 100).toFixed(0)}% agreement — ${o.indexDirection.summary}`,
    );
    if (o.indexDirection.conflicts.length) {
      lines.push(`Dissenting reads: ${o.indexDirection.conflicts.join(', ')}`);
    }
    lines.push('');
  }

  // ---- option context ---------------------------------------------------
  if (o.optionChain) {
    const c = o.optionChain;
    lines.push('**Option chain**');
    lines.push(
      `PCR ${c.pcr.toFixed(2)} · max pain ${n(c.maxPain)}${c.callOIWall != null ? ` · call OI wall ${n(c.callOIWall)}` : ''}${c.putOIWall != null ? ` · put OI wall ${n(c.putOIWall)}` : ''} · ${c.strikesAnalysed} strikes`,
    );
    if (c.atm) {
      lines.push(
        `ATM ${n(c.atm.strike)} — CE ${n(c.atm.callLtp) ?? 'n/a'} / PE ${n(c.atm.putLtp) ?? 'n/a'} · CE OI ${whole.format(c.atm.callOI)} / PE OI ${whole.format(c.atm.putOI)}`,
      );
    }
    lines.push('');
  }

  if (o.contracts) {
    lines.push('**CE / PE legs**');
    if (!o.contracts.readable) {
      lines.push(o.contracts.unreadableReason ?? 'Contract series could not be read.');
    } else {
      // Rendered inline rather than through a helper: each leg reports either a
      // measurement or the reason it has none, and collapsing those into one
      // string would lose the distinction between "flat" and "unread".
      for (const [side, l] of [
        ['CE', o.contracts.ce],
        ['PE', o.contracts.pe],
      ] as const) {
        if (!l) continue;
        if (l.unavailableReason) {
          lines.push(`${side} ${n(l.strike)} — ${l.unavailableReason}`);
        } else {
          lines.push(`${side} ${n(l.strike)} — ${l.direction ?? 'unread'}${l.changePct != null ? ` ${pct(l.changePct)}` : ''}`);
        }
      }
      if (o.contracts.alignment) lines.push(`Alignment: ${o.contracts.alignment}`);
    }
    lines.push('');
  }

  // ---- freshness --------------------------------------------------------
  lines.push('**Data**');
  lines.push(
    `${o.freshness.candles} bars · newest ${istTime(o.freshness.newestBarAt) ?? 'unknown'}${
      o.freshness.barAgeMinutes != null ? ` (${o.freshness.barAgeMinutes} min old)` : ''
    } · ${o.freshness.ok ? 'within freshness limits' : `stale — ${o.freshness.reason ?? 'freshness check failed'}`}`,
  );

  // ---- what could not be measured ---------------------------------------
  if (o.unavailable.length) {
    lines.push('');
    lines.push('**Not measured**');
    for (const u of o.unavailable.slice(0, 6)) {
      lines.push(`• ${u.field} — ${u.reason}`);
    }
    if (o.unavailable.length > 6) {
      lines.push(`• …and ${o.unavailable.length - 6} more`);
    }
  }

  return lines.join('\n').trimEnd();
}

/** Trace lines for the dock — what was read, from where, on which bars. */
export function observationSteps(o: MarketObservation, coverage: SymbolCoverage): string[] {
  return [
    `Classified → market analysis (${coverage.kind})`,
    `Read ${o.symbol} on ${o.timeframe}${o.requestedTimeframe !== o.timeframe ? ` (asked for ${o.requestedTimeframe})` : ''}`,
    `Source: ${coverage.dataSource}`,
    `${o.freshness.candles} bars · ${o.freshness.ok ? 'fresh' : 'stale'}`,
    ...(o.unavailable.length ? [`${o.unavailable.length} measurement(s) unavailable and reported`] : []),
  ];
}
