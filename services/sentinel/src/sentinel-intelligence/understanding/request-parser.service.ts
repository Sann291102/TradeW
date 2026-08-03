import { Injectable } from '@nestjs/common';
import { ReasoningGraphService } from '../knowledge/reasoning-graph.service';
import type {
  Assumption,
  OptionRight,
  ReasonRequest,
  RequestIntent,
  ResolvedMarket,
  RiskProfile,
  Timeframe,
  TradingStyle,
  UnderstoodRequest,
} from '../types';

/**
 * Turns a free-text request plus structured overrides into a fully-specified
 * `UnderstoodRequest`.
 *
 * Deliberately deterministic — no LLM in the understanding path. The same
 * three arguments hold as for the assistant control layer
 * (`knowledge/Patterns/2026-07-26 - TradeW AI assistant control layer`):
 * parsing is instant and free, the whole grammar is unit-testable without an
 * API key, and there is no generative surface for a prompt injection to steer.
 * An LLM that mis-parses a strike silently produces a confident answer about
 * the wrong contract; a deterministic parser that cannot find one records an
 * explicit assumption instead.
 *
 * Four bugs that the assistant layer hit in production are guarded here by
 * construction — see the inline notes on index digits, nearest-occurrence
 * expiry resolution, longest-alias-first matching, and call/put as contract
 * syntax rather than a request for a tip.
 */
@Injectable()
export class RequestParserService {
  constructor(private readonly graph: ReasoningGraphService) {}

  parse(request: ReasonRequest, now: Date = new Date()): UnderstoodRequest {
    const rawText = (request.query ?? '').trim();
    const assumptions: Assumption[] = [];
    // Strike detection must not see the digits inside an index's display name.
    // "NIFTY 50 24300" contains two numbers and only one is a strike.
    const { text: scrubbed, matchedAliases } = scrubMarketAliases(rawText);

    const market = this.resolveMarket(request, rawText, assumptions);
    const right = resolveRight(request, rawText, assumptions);
    const strike = this.resolveStrike(request, scrubbed, market, assumptions);
    const { expiry, phrase } = resolveExpiry(request, rawText, now, assumptions);
    const timeframe = resolveTimeframe(request, rawText, assumptions);
    const style = resolveStyle(request, rawText, timeframe, assumptions);
    const riskProfile = resolveRiskProfile(request, rawText, assumptions);
    const indicators = resolveIndicators(request, rawText);
    const strategyIds = this.resolveStrategies(request, rawText);
    const intent = resolveIntent(rawText, { strike, right, strategyIds, indicators });

    // Parse confidence reports how much came from the request rather than from
    // a default, so a downstream agent can tell "the user said 15m" from
    // "nobody said anything and we assumed 15m".
    const explicitFields = [
      request.symbol || matchedAliases.length > 0,
      strike !== null,
      right !== null,
      expiry !== null,
      Boolean(request.timeframe) || /\b(\d+\s*(?:m|min|h|hour)|daily|intraday)\b/i.test(rawText),
      strategyIds.length > 0,
      indicators.length > 0,
      style !== 'unspecified',
      riskProfile !== 'unspecified',
      intent !== 'unknown',
    ];
    const parseConfidence = Number(
      (explicitFields.filter(Boolean).length / explicitFields.length).toFixed(3),
    );

    return {
      rawText,
      market,
      strike,
      right,
      expiry,
      expiryPhrase: phrase,
      timeframe,
      strategyIds,
      indicators,
      style,
      riskProfile,
      intent,
      assumptions,
      parseConfidence,
    };
  }

  private resolveMarket(request: ReasonRequest, text: string, assumptions: Assumption[]): ResolvedMarket {
    if (request.symbol) return describeMarket(request.symbol.toUpperCase());

    // Longest alias first. "bank nifty" must be tested before "nifty", or
    // "read bank nifty" silently resolves to NIFTY — a real bug from the
    // assistant layer, and a wrong-instrument answer is worse than no answer.
    const haystack = ` ${text.toLowerCase()} `;
    for (const [alias, symbol] of MARKET_ALIASES) {
      if (haystack.includes(` ${alias} `)) return describeMarket(symbol);
    }

    // A bare uppercase token that looks like an NSE symbol, e.g. "RELIANCE".
    const bareSymbol = /\b([A-Z][A-Z&-]{3,19})\b/.exec(text);
    if (bareSymbol && !RESERVED_WORDS.has(bareSymbol[1])) {
      return describeMarket(bareSymbol[1]);
    }

    assumptions.push({
      field: 'market',
      value: 'NIFTY',
      reason: 'No market named in the request; defaulted to the index the workspace opens on.',
    });
    return describeMarket('NIFTY');
  }

  /**
   * Strike resolution over text whose index aliases have already been removed.
   *
   * Takes the LARGEST remaining candidate rather than the first: an utterance
   * routinely carries small incidental numbers (an EMA period, a timeframe, an
   * RSI level) alongside one large strike, and the strike is reliably the
   * biggest of them.
   */
  private resolveStrike(
    request: ReasonRequest,
    scrubbedText: string,
    market: ResolvedMarket,
    assumptions: Assumption[],
  ): number | null {
    if (typeof request.strike === 'number' && Number.isFinite(request.strike)) return request.strike;
    if (!market.hasOptionChain) return null;

    // Drop date-shaped and indicator-bound numbers before looking for a strike.
    const cleaned = scrubbedText
      .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
      .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, ' ')
      .replace(/\b(?:ema|sma|rsi|macd|atr|adx)\s*\(?\s*\d{1,3}\)?/gi, ' ')
      .replace(/\b\d{1,3}\s*(?:m|min|mins|minute|minutes|h|hr|hour|hours|day|days)\b/gi, ' ');

    const candidates = [...cleaned.matchAll(/\b(\d{2,6}(?:\.\d+)?)\b/g)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n >= 50);

    if (candidates.length === 0) return null;
    const strike = Math.max(...candidates);

    // A "strike" an order of magnitude away from any plausible level for this
    // instrument is a misparse, not a strike. Refusing beats guessing.
    if (market.strikeStep !== null && strike < market.strikeStep) return null;

    if (candidates.length > 1) {
      assumptions.push({
        field: 'strike',
        value: String(strike),
        reason: `The request contained ${candidates.length} numbers (${candidates.join(', ')}); the largest was read as the strike.`,
      });
    }
    return strike;
  }

  /**
   * Strategy ids named in the request.
   *
   * Matched against the concept ontology rather than a hardcoded list, so a
   * strategy the corpus has learned becomes referable without a code change.
   */
  private resolveStrategies(request: ReasonRequest, text: string): string[] {
    if (request.strategyIds?.length) return request.strategyIds;
    if (!text) return [];

    const out = new Set<string>();
    for (const [phrase, id] of STRATEGY_ALIASES) {
      if (text.toLowerCase().includes(phrase)) out.add(id);
    }
    // Concepts in the strategy-bearing domains that the request names directly.
    //
    // Anything already resolved as an INDICATOR is excluded. "with VWAP and
    // fibonacci" names two tools to plot, not two strategies to validate, and
    // letting VWAP through as a strategy made the Strategy agent hunt for a
    // detection that was never requested — then report its absence as a
    // finding.
    const indicators = new Set(resolveIndicators(request, text));
    for (const concept of this.graph.detect(text)) {
      if (!STRATEGY_DOMAINS.has(concept.domain)) continue;
      if (indicators.has(concept.id)) continue;
      out.add(concept.id);
    }
    return [...out];
  }
}

// ---------------------------------------------------------------------------
// Market vocabulary
// ---------------------------------------------------------------------------

/**
 * Alias → symbol, ordered LONGEST FIRST.
 *
 * The ordering is load-bearing, not cosmetic: `Map` preserves insertion order
 * and the first containment hit wins, so "bank nifty" must precede "nifty".
 */
const MARKET_ALIASES = new Map<string, string>([
  ['bank nifty', 'BANKNIFTY'],
  ['banknifty', 'BANKNIFTY'],
  ['nifty bank', 'BANKNIFTY'],
  ['fin nifty', 'FINNIFTY'],
  ['finnifty', 'FINNIFTY'],
  ['nifty financial', 'FINNIFTY'],
  ['midcap nifty', 'MIDCPNIFTY'],
  ['midcpnifty', 'MIDCPNIFTY'],
  ['nifty 50', 'NIFTY'],
  ['nifty50', 'NIFTY'],
  ['sensex', 'SENSEX'],
  ['bankex', 'BANKEX'],
  ['natural gas', 'NATURALGAS'],
  ['crude oil', 'CRUDEOIL'],
  ['crudeoil', 'CRUDEOIL'],
  ['nifty', 'NIFTY'],
  ['gold', 'GOLD'],
  ['silver', 'SILVER'],
  ['copper', 'COPPER'],
]);

/** Uppercase tokens that look like symbols but are not. */
const RESERVED_WORDS = new Set([
  'CE', 'PE', 'OTM', 'ITM', 'ATM', 'OI', 'PCR', 'VWAP', 'RSI', 'MACD', 'EMA', 'SMA', 'CPR',
  'IV', 'LTP', 'PNL', 'SL', 'AI', 'API', 'NSE', 'BSE', 'MCX', 'FNO', 'IST', 'TF', 'HTF', 'LTF',
]);

/** Index/commodity metadata. Strike step drives ATM snapping. */
const MARKET_META: Record<string, { name: string; kind: ResolvedMarket['kind']; chain: boolean; step: number | null }> = {
  NIFTY: { name: 'Nifty 50', kind: 'index', chain: true, step: 50 },
  BANKNIFTY: { name: 'Nifty Bank', kind: 'index', chain: true, step: 100 },
  FINNIFTY: { name: 'Fin Nifty', kind: 'index', chain: true, step: 50 },
  MIDCPNIFTY: { name: 'Nifty Midcap Select', kind: 'index', chain: true, step: 25 },
  SENSEX: { name: 'BSE Sensex', kind: 'index', chain: true, step: 100 },
  BANKEX: { name: 'BSE Bankex', kind: 'index', chain: true, step: 100 },
  GOLD: { name: 'Gold', kind: 'commodity', chain: true, step: 100 },
  SILVER: { name: 'Silver', kind: 'commodity', chain: true, step: 250 },
  CRUDEOIL: { name: 'Crude Oil', kind: 'commodity', chain: true, step: 50 },
  NATURALGAS: { name: 'Natural Gas', kind: 'commodity', chain: true, step: 5 },
  COPPER: { name: 'Copper', kind: 'commodity', chain: false, step: null },
};

export function describeMarket(symbol: string): ResolvedMarket {
  const meta = MARKET_META[symbol];
  if (meta) {
    return { symbol, name: meta.name, kind: meta.kind, hasOptionChain: meta.chain, strikeStep: meta.step };
  }
  // Unknown symbol: assume an F&O-eligible equity. `hasOptionChain` is a
  // capability hint only — the Options agent abstains when the provider
  // returns no chain, so an optimistic guess here costs nothing.
  return { symbol, name: symbol, kind: 'stock', hasOptionChain: true, strikeStep: null };
}

/** Remove market alias text so its digits cannot be read as a strike. */
export function scrubMarketAliases(text: string): { text: string; matchedAliases: string[] } {
  let out = text;
  const matched: string[] = [];
  for (const alias of MARKET_ALIASES.keys()) {
    const pattern = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (pattern.test(out)) {
      matched.push(alias);
      out = out.replace(pattern, ' ');
    }
  }
  return { text: out, matchedAliases: matched };
}

// ---------------------------------------------------------------------------
// Field resolvers — pure, exported for direct testing.
// ---------------------------------------------------------------------------

/**
 * CE/PE resolution.
 *
 * `call` and `put` are contract syntax here, never a request for a tip — an
 * earlier advice-refusal pattern in the assistant layer matched
 * `calls?\s+(for|on|today)` and refused legitimate contract commands. The
 * directive framings that DO signal an advice request ("should I", "recommend")
 * are handled by the compliance agent and the vocabulary enforcer, not here.
 */
export function resolveRight(request: ReasonRequest, text: string, assumptions: Assumption[]): OptionRight | null {
  if (request.right) return request.right;
  if (/\b(ce|calls?)\b/i.test(text) && !/\b(pe|puts?)\b/i.test(text)) return 'CE';
  if (/\b(pe|puts?)\b/i.test(text) && !/\b(ce|calls?)\b/i.test(text)) return 'PE';
  if (/\b(ce|calls?)\b/i.test(text) && /\b(pe|puts?)\b/i.test(text)) {
    assumptions.push({
      field: 'right',
      value: 'none',
      reason: 'Both call and put were mentioned; neither side was pinned so both are read as context.',
    });
  }
  return null;
}

const TIMEFRAME_PATTERNS: [RegExp, Timeframe][] = [
  [/\b(1\s*m|1\s*min|one\s*minute)\b/i, '1m'],
  [/\b(3\s*m|3\s*min)\b/i, '3m'],
  [/\b(5\s*m|5\s*min|five\s*minute)\b/i, '5m'],
  [/\b(15\s*m|15\s*min|fifteen\s*minute)\b/i, '15m'],
  [/\b(30\s*m|30\s*min|half\s*hour)\b/i, '30m'],
  [/\b(1\s*h|60\s*m|hourly|one\s*hour)\b/i, '1h'],
  [/\b(1\s*d|daily|day\s*chart|eod)\b/i, '1d'],
];

export function resolveTimeframe(request: ReasonRequest, text: string, assumptions: Assumption[]): Timeframe {
  if (request.timeframe) return request.timeframe;
  for (const [pattern, timeframe] of TIMEFRAME_PATTERNS) {
    if (pattern.test(text)) return timeframe;
  }
  assumptions.push({
    field: 'timeframe',
    value: '15m',
    reason: 'No timeframe stated; defaulted to 15m, the interval the market engines already compute on.',
  });
  return '15m';
}

export function resolveStyle(
  request: ReasonRequest,
  text: string,
  timeframe: Timeframe,
  assumptions: Assumption[],
): TradingStyle {
  if (request.style) return request.style;
  if (/\bscalp(ing|er)?\b/i.test(text)) return 'scalping';
  if (/\bintra[- ]?day\b/i.test(text)) return 'intraday';
  if (/\bswing\b/i.test(text)) return 'swing';
  if (/\bposition(al)?\b/i.test(text) || /\blong[- ]term\b/i.test(text)) return 'positional';

  // Infer from the timeframe rather than leaving it unspecified — the risk and
  // strategy agents weight holding period, and an inferred value with a
  // recorded assumption beats no value at all.
  const inferred: TradingStyle =
    timeframe === '1m' || timeframe === '3m' ? 'scalping' : timeframe === '1d' ? 'swing' : 'intraday';
  assumptions.push({
    field: 'style',
    value: inferred,
    reason: `No trading style stated; inferred from the ${timeframe} timeframe.`,
  });
  return inferred;
}

export function resolveRiskProfile(request: ReasonRequest, text: string, assumptions: Assumption[]): RiskProfile {
  if (request.riskProfile) return request.riskProfile;
  if (/\b(conservative|cautious|low[- ]risk|safe)\b/i.test(text)) return 'conservative';
  if (/\b(aggressive|high[- ]risk|risky)\b/i.test(text)) return 'aggressive';
  if (/\b(balanced|moderate)\b/i.test(text)) return 'balanced';
  assumptions.push({
    field: 'riskProfile',
    value: 'balanced',
    reason: 'No risk profile stated; defaulted to balanced, which applies no risk-tolerance adjustment either way.',
  });
  return 'balanced';
}

const INDICATOR_ALIASES: [RegExp, string][] = [
  [/\bema\b|\bexponential moving average\b/i, 'ema'],
  [/\bsma\b|\bsimple moving average\b/i, 'sma'],
  [/\bvwap\b/i, 'vwap'],
  [/\brsi\b|\brelative strength\b/i, 'rsi'],
  [/\bmacd\b/i, 'macd'],
  [/\bcpr\b|\bcentral pivot\b/i, 'cpr'],
  [/\bpivot\b/i, 'pivot'],
  [/\bfib(onacci)?\b/i, 'fibonacci'],
  [/\bbollinger\b|\bbb\b/i, 'bollinger'],
  [/\bsupertrend\b/i, 'supertrend'],
  [/\batr\b|\baverage true range\b/i, 'atr'],
  [/\bvolume profile\b|\bvpoc\b|\bpoc\b/i, 'volume-profile'],
  [/\bopen(ing)? range\b|\borb\b/i, 'opening-range'],
  [/\bsupply\b|\bdemand\b/i, 'supply-demand'],
  [/\bliquidity\b/i, 'liquidity'],
  [/\bsupport\b|\bresistance\b|\bs\/r\b/i, 'support-resistance'],
];

export function resolveIndicators(request: ReasonRequest, text: string): string[] {
  if (request.indicators?.length) return request.indicators.map((i) => i.toLowerCase());
  const out = new Set<string>();
  for (const [pattern, id] of INDICATOR_ALIASES) {
    if (pattern.test(text)) out.add(id);
  }
  return [...out];
}

const STRATEGY_ALIASES = new Map<string, string>([
  ['opening range breakout', 'orb-breakout'],
  ['orb', 'orb-breakout'],
  ['vwap pullback', 'vwap-pullback'],
  ['liquidity sweep', 'liquidity-sweep'],
  ['order block', 'order-block'],
  ['fair value gap', 'fair-value-gap'],
  ['fvg', 'fair-value-gap'],
  ['market structure shift', 'market-structure-shift'],
  ['break of structure', 'market-structure-shift'],
  ['wyckoff', 'wyckoff-accumulation'],
  ['spring', 'wyckoff-spring'],
  ['ema cross', 'ema-cross'],
  ['golden cross', 'ema-cross'],
  ['cpr', 'cpr-breakout'],
  ['false breakout', 'false-breakout'],
  ['fake breakout', 'false-breakout'],
  ['divergence', 'divergence'],
]);

const STRATEGY_DOMAINS = new Set(['patterns', 'price-action', 'market-structure', 'institutional-concepts', 'technical-analysis']);

/**
 * Expiry resolution using NEAREST occurrence, not next occurrence.
 *
 * The bug this guards against is specific and was observed in production: a
 * bare "21st July" said on 26 July resolved to the *next* future 21 July, i.e.
 * the following year — a contract with no liquidity that the user plainly did
 * not mean. Picking whichever of last/this/next year is closest in absolute
 * days resolves it to the nearby date instead, and a resolved expiry in the
 * past is recorded as an assumption so downstream output can say the contract
 * is settled rather than presenting a dead contract as live.
 */
export function resolveExpiry(
  request: ReasonRequest,
  text: string,
  now: Date,
  assumptions: Assumption[],
): { expiry: Date | null; phrase: string | null } {
  if (request.expiry) {
    const parsed = new Date(request.expiry);
    if (!Number.isNaN(parsed.getTime())) return { expiry: parsed, phrase: request.expiry };
  }
  if (!text) return { expiry: null, phrase: null };

  if (/\b(this\s+week|weekly|current\s+week)\b/i.test(text)) {
    const expiry = nextWeekday(now, 4); // Thursday, the standard weekly expiry
    return { expiry, phrase: 'weekly' };
  }
  if (/\bnext\s+week\b/i.test(text)) {
    const expiry = nextWeekday(new Date(now.getTime() + 7 * 86_400_000), 4);
    return { expiry, phrase: 'next week' };
  }
  if (/\b(monthly|month\s*end|month\s*expiry)\b/i.test(text)) {
    return { expiry: lastWeekdayOfMonth(now, 4), phrase: 'monthly' };
  }

  // "21st July", "21 Jul", "July 21"
  const dayMonth = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(text);
  const monthDay = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(text);
  const match = dayMonth
    ? { day: Number(dayMonth[1]), month: MONTHS[dayMonth[2].toLowerCase()] }
    : monthDay
      ? { day: Number(monthDay[2]), month: MONTHS[monthDay[1].toLowerCase()] }
      : null;

  if (match && match.month !== undefined) {
    const year = yearForNearestOccurrence(now, match.month, match.day);
    const expiry = new Date(Date.UTC(year, match.month, match.day, 10, 0, 0));
    const phrase = (dayMonth ?? monthDay)![0];
    if (expiry.getTime() < now.getTime()) {
      assumptions.push({
        field: 'expiry',
        value: expiry.toISOString().slice(0, 10),
        reason: `"${phrase}" resolves to a date that has already passed — that contract is settled, not live.`,
      });
    }
    return { expiry, phrase };
  }

  return { expiry: null, phrase: null };
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Whichever of last/this/next year puts this day-month closest to `now`. */
export function yearForNearestOccurrence(now: Date, month: number, day: number): number {
  const base = now.getUTCFullYear();
  let bestYear = base;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const year of [base - 1, base, base + 1]) {
    const candidate = Date.UTC(year, month, day);
    const distance = Math.abs(candidate - now.getTime());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestYear = year;
    }
  }
  return bestYear;
}

/** Next occurrence of `weekday` (0=Sun) at or after `from`. */
export function nextWeekday(from: Date, weekday: number): Date {
  const result = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 10, 0, 0));
  const delta = (weekday - result.getUTCDay() + 7) % 7;
  result.setUTCDate(result.getUTCDate() + delta);
  return result;
}

/** Last occurrence of `weekday` in the month containing `from`. */
export function lastWeekdayOfMonth(from: Date, weekday: number): Date {
  const lastDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0, 10, 0, 0));
  const delta = (lastDay.getUTCDay() - weekday + 7) % 7;
  lastDay.setUTCDate(lastDay.getUTCDate() - delta);
  return lastDay;
}

export function resolveIntent(
  text: string,
  ctx: { strike: number | null; right: OptionRight | null; strategyIds: string[]; indicators: string[] },
): RequestIntent {
  if (!text) {
    // Structured-only call: the fields present say what was wanted.
    if (ctx.strike !== null || ctx.right !== null) return 'option-context';
    if (ctx.strategyIds.length > 0) return 'strategy-check';
    return 'market-read';
  }
  if (/\b(draw|chart|plot|annotate|visuali[sz]e|workspace)\b/i.test(text)) return 'visual-workspace';
  if (/\b(why|explain|reason|because|justify)\b/i.test(text)) return 'explain';
  if (/\b(revenge|tilt|fomo|discipline|over[- ]?trad|emotion|psycholog)/i.test(text)) return 'behaviour-review';
  // `risk\w*` rather than `\brisk\b`: "how risky is this" is the most natural
  // phrasing of a risk question and a word-bounded `risk` misses it entirely.
  if (/\b(risk\w*|exposure|margin|position siz\w*|drawdown)\b/i.test(text)) return 'risk-review';
  if (ctx.strike !== null || ctx.right !== null || /\b(option|chain|oi|pcr|iv|premium|strike|expiry)\b/i.test(text)) {
    return 'option-context';
  }
  if (ctx.strategyIds.length > 0 || /\b(strategy|setup|rule|confirm|trigger|pattern)\b/i.test(text)) {
    return 'strategy-check';
  }
  if (/\b(what|how|read|doing|structure|trend|market)\b/i.test(text)) return 'market-read';
  return 'unknown';
}
