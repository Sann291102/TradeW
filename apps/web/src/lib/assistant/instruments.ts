import { INDEX_QUOTES, TICKER_EXTRA, WATCHLIST, TOP_GAINERS, TOP_LOSERS } from '@/lib/mock/market';
import { FO_STOCK_UNIVERSE } from '@/lib/mock/foUniverse';
import { ALL_NSE_INDICES } from '@/lib/mock/indices';

/**
 * Instrument & option-contract parsing for the assistant's control layer.
 *
 * The driving example is the spoken command
 *   "open NIFTY 50 24300 call of 21st July"
 * which has to become the deep link the Trade workspace already understands:
 *   /trade?symbol=NIFTY&strike=24300&type=CE&expiry=2026-07-21
 * (see components/trade/TradeWorkspace.tsx — it already reads symbol/strike/
 * type/expiry off the query string and renders that contract's own chart, so
 * the assistant needs no new rendering path, only resolution.)
 *
 * Number-WORDS are handled ("twenty four thousand three hundred") because
 * voice input is the next phase and speech-to-text commonly emits words for
 * spoken figures; text input already gives digits. Both paths land here.
 */

// ---------------------------------------------------------------------------
// Symbol universe
// ---------------------------------------------------------------------------

/** Every symbol the app knows, same sources the command palette searches
 *  (lib/search/providers.ts) so the assistant and the palette can never
 *  disagree about what exists. */
export const SYMBOL_UNIVERSE: ReadonlyArray<{ symbol: string; name: string }> = (() => {
  const map = new Map<string, string>();
  for (const q of [...INDEX_QUOTES, ...TICKER_EXTRA]) map.set(q.symbol, q.name);
  for (const w of WATCHLIST) map.set(w.symbol, w.name);
  for (const m of [...TOP_GAINERS, ...TOP_LOSERS]) map.set(m.symbol, m.name);
  for (const s of FO_STOCK_UNIVERSE) map.set(s.symbol, s.name);
  for (const idx of ALL_NSE_INDICES) if (!map.has(idx.name)) map.set(idx.name, idx.name);
  return Array.from(map.entries()).map(([symbol, name]) => ({ symbol, name }));
})();

/**
 * Spoken/typed forms that don't literally equal the traded symbol. Longest
 * phrases first — "bank nifty" must win over "nifty", or "open bank nifty"
 * resolves to NIFTY and silently opens the wrong instrument.
 */
const SYMBOL_ALIASES: ReadonlyArray<[string, string]> = [
  ['nifty bank', 'BANKNIFTY'],
  ['bank nifty', 'BANKNIFTY'],
  ['banknifty', 'BANKNIFTY'],
  ['nifty fifty', 'NIFTY'],
  ['nifty 50', 'NIFTY'],
  ['nifty50', 'NIFTY'],
  ['fin nifty', 'FINNIFTY'],
  ['finnifty', 'FINNIFTY'],
  ['midcap nifty', 'MIDCPNIFTY'],
  ['nifty midcap', 'MIDCPNIFTY'],
  ['midcpnifty', 'MIDCPNIFTY'],
  ['sensex', 'SENSEX'],
  ['bankex', 'BANKEX'],
  ['nifty', 'NIFTY'],
];

/**
 * Find the instrument named in `text`. Aliases are matched as phrases first,
 * then real symbols on word boundaries (so "ITC" doesn't match inside
 * "SWITCH"), then company names.
 */
export function findSymbol(text: string): { symbol: string; matched: string } | null {
  const lower = text.toLowerCase();

  for (const [alias, symbol] of SYMBOL_ALIASES) {
    if (new RegExp(`\\b${escapeRe(alias)}\\b`).test(lower)) return { symbol, matched: alias };
  }

  // Longest symbol first, so BANKNIFTY beats NIFTY when both could match.
  const bySymbolLength = [...SYMBOL_UNIVERSE].sort((a, b) => b.symbol.length - a.symbol.length);
  for (const s of bySymbolLength) {
    if (new RegExp(`\\b${escapeRe(s.symbol.toLowerCase())}\\b`).test(lower)) {
      return { symbol: s.symbol, matched: s.symbol };
    }
  }

  // Company names are only worth matching when reasonably distinctive —
  // two-letter fragments produce constant false positives.
  for (const s of bySymbolLength) {
    const name = s.name.toLowerCase();
    if (name.length >= 5 && lower.includes(name)) return { symbol: s.symbol, matched: s.name };
  }

  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Number words (voice-readiness)
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** Indian and international scales both appear in spoken strike figures. */
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, lakh: 100_000, lac: 100_000 };

/**
 * "twenty four thousand three hundred" -> 24300.
 *
 * Standard accumulate-and-flush word-number algorithm: `current` builds the
 * group under the active scale, `total` accumulates flushed groups. Returns
 * null when the phrase contains no number words at all.
 */
export function wordsToNumber(phrase: string): number | null {
  const tokens = phrase.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let sawNumber = false;

  for (const t of tokens) {
    if (t === 'and') continue;
    if (t in UNITS) {
      current += UNITS[t];
      sawNumber = true;
    } else if (t in TENS) {
      current += TENS[t];
      sawNumber = true;
    } else if (t in SCALES) {
      if (!sawNumber) return null; // "hundred" with nothing before it — not a figure
      const scale = SCALES[t];
      // "hundred" multiplies only the pending group ("twenty four hundred");
      // larger scales flush the group into the total ("twenty four thousand").
      if (scale === 100) {
        current *= 100;
      } else {
        total += (current || 1) * scale;
        current = 0;
      }
    } else if (sawNumber) {
      // A non-number token ends the figure — stop rather than skipping ahead
      // and gluing two separate numbers together.
      break;
    }
  }

  if (!sawNumber) return null;
  return total + current;
}

// ---------------------------------------------------------------------------
// Option contract
// ---------------------------------------------------------------------------

export interface ParsedContract {
  symbol: string;
  strike: number;
  optionType: 'CE' | 'PE';
  /** ISO `YYYY-MM-DD`, only when the user named an actual date. */
  expiryIso?: string;
  /** How the expiry was expressed, for the trace line. */
  expiryLabel: string;
  /** True when no explicit date was given and the chain's default expiry is used. */
  expiryImplied: boolean;
  /** True when the named expiry has already passed — the reply says so rather
   *  than presenting a dead contract as a live one. */
  expiryPast: boolean;
}

const CALL_RE = /\b(ce|calls?)\b/i;
const PUT_RE = /\b(pe|puts?)\b/i;

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Resolve an explicit expiry to ISO. Handles "21st July", "21 Jul",
 * "July 21", "21/07", "21-07-2026" and a bare ISO date.
 *
 * A day+month with no year resolves to the NEAREST occurrence in absolute
 * distance from today, not the next FUTURE one. That distinction matters:
 * said on 26 Jul 2026, "21st July" means the 21st five days ago, not the one
 * 360 days out. An earlier version rolled forward to the next future date and
 * turned "21st July" into a 2027 expiry — a contract with no meaningful
 * liquidity that the user plainly hadn't asked for. Said in December, "21st
 * July" still resolves forward, because next July really is nearer.
 *
 * `today` is injectable so this is testable without freezing the clock.
 */
export function parseExpiry(text: string, today = new Date()): { iso: string; label: string } | null {
  const lower = text.toLowerCase();

  const iso = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return { iso: iso[0], label: iso[0] };

  const monthNames = MONTHS.join('|');
  const monthAbbrs = MONTHS.map((m) => m.slice(0, 3)).join('|');
  const monthPattern = `${monthNames}|${monthAbbrs}`;

  // "21st July" / "21 jul"
  let m = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthPattern})\\b`));
  // "July 21" / "jul 21st"
  if (!m) {
    const m2 = lower.match(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
    if (m2) m = [m2[0], m2[2], m2[1]] as unknown as RegExpMatchArray;
  }

  if (m) {
    const day = Number(m[1]);
    const monthIdx = MONTHS.findIndex((name) => name.startsWith(m![2].slice(0, 3)));
    if (monthIdx < 0 || day < 1 || day > 31) return null;
    const yearMatch = lower.match(/\b(20\d{2})\b/);
    const year = yearMatch ? Number(yearMatch[1]) : yearForNearestOccurrence(monthIdx, day, today);
    return { iso: toIso(year, monthIdx, day), label: `${day} ${cap(MONTHS[monthIdx].slice(0, 3))} ${year}` };
  }

  // Numeric "21/07" or "21-07-2026" — day-first, matching Indian convention.
  const numeric = lower.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (numeric) {
    const day = Number(numeric[1]);
    const monthIdx = Number(numeric[2]) - 1;
    if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
    let year: number;
    if (numeric[3]) {
      const raw = Number(numeric[3]);
      year = raw < 100 ? 2000 + raw : raw;
    } else {
      year = yearForNearestOccurrence(monthIdx, day, today);
    }
    return { iso: toIso(year, monthIdx, day), label: `${day} ${cap(MONTHS[monthIdx].slice(0, 3))} ${year}` };
  }

  return null;
}

/** The year (this one, last, or next) whose occurrence of month/day sits
 *  closest to today in absolute days. */
function yearForNearestOccurrence(monthIdx: number, day: number, today: Date): number {
  const base = startOfDay(today).getTime();
  const thisYear = today.getFullYear();
  let best = thisYear;
  let bestDistance = Infinity;
  for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
    const distance = Math.abs(new Date(year, monthIdx, day).getTime() - base);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = year;
    }
  }
  return best;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** True when `iso` is strictly before today — used to warn that an expiry has
 *  already passed instead of opening it as though it were live. */
export function isPastDate(iso: string, today = new Date()): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime() < startOfDay(today).getTime();
}

function toIso(year: number, monthIdx: number, day: number): string {
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse a full option-contract reference. Returns null unless BOTH a strike
 * and a call/put marker are present — an utterance naming only a symbol is an
 * underlying-chart command, not a contract command, and must not be guessed
 * into a specific strike.
 */
export function parseContract(text: string, today = new Date()): ParsedContract | null {
  const sym = findSymbol(text);
  if (!sym) return null;

  const isCall = CALL_RE.test(text);
  const isPut = PUT_RE.test(text);
  if (isCall === isPut) return null; // neither, or a contradictory "call put"

  const strike = findStrike(text, sym.matched);
  if (strike == null) return null;

  const expiry = parseExpiry(text, today);
  return {
    symbol: sym.symbol,
    strike,
    optionType: isCall ? 'CE' : 'PE',
    expiryIso: expiry?.iso,
    expiryLabel: expiry?.label ?? 'nearest expiry',
    expiryImplied: !expiry,
    expiryPast: expiry ? isPastDate(expiry.iso, today) : false,
  };
}

/**
 * Pull the strike out of the utterance.
 *
 * The alias text is removed first, because index names contain digits that are
 * not strikes — "NIFTY 50 24300 call" must yield 24300, not 50. Digit groups
 * win over number-words when both appear.
 */
function findStrike(text: string, matchedSymbolText: string): number | null {
  let cleaned = text.toLowerCase().replace(new RegExp(escapeRe(matchedSymbolText.toLowerCase()), 'g'), ' ');

  // Strip anything that reads as a date, so "21st July" can't be taken as a
  // strike of 21 — dates are resolved separately by parseExpiry.
  cleaned = cleaned
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\b`, 'g'), ' ')
    .replace(new RegExp(`\\b(?:${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'g'), ' ')
    .replace(/\b20\d{2}\b/g, ' ');

  // "24,300" / "24300" / "24300.00" — commas are grouping, not decimals.
  const digits = cleaned.match(/\b\d[\d,]*(?:\.\d+)?\b/g);
  if (digits) {
    const candidates = digits
      .map((d) => Number(d.replace(/,/g, '')))
      .filter((n) => Number.isFinite(n) && n > 0);
    // Largest wins: leftover small integers are lot counts or stray ordinals,
    // never the strike in any real instrument.
    if (candidates.length) return Math.max(...candidates);
  }

  // "twenty four thousand three hundred"
  const spoken = wordsToNumber(cleaned);
  if (spoken != null && spoken > 0) return spoken;

  return null;
}

/** Build the Trade-workspace deep link for a parsed contract. */
export function contractHref(c: ParsedContract): string {
  const params = new URLSearchParams({
    symbol: c.symbol,
    strike: String(c.strike),
    type: c.optionType,
  });
  // Omitted when the user named no date — TradeWorkspace/the Option Chain tab
  // then fall back to the chain's own near expiry rather than the assistant
  // inventing a date the contract may not even expire on.
  if (c.expiryIso) params.set('expiry', c.expiryIso);
  return `/trade?${params.toString()}`;
}
