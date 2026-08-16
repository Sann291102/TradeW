import type { BreadthSnapshot, FiiDiiFlow, ParticipantOi } from '../sentinel/nse';
import { formatCrore } from '../sentinel/nse';

/**
 * Institutional-activity questions — "were FIIs buying today", "what's the
 * market breadth", "how are FIIs positioned in index futures".
 *
 * ── HOW THE AGENT "REACHES NSE" ────────────────────────────────────────────
 * By naming a question, never a URL. This module classifies an utterance into
 * one of three fixed asks and the executor calls the matching `/nse/*` route,
 * which is itself backed by a closed dataset catalogue
 * (`services/api/src/nse/nse-datasets.ts`). At no point does anything the model
 * or the user typed become part of an outbound request.
 *
 * That is deliberate and it is the whole design. Letting the assistant browse
 * nseindia.com freely would mean two things this repo has already decided
 * against: a caller-supplied URL fetched from inside the network (the standing
 * exposure the broker-integration review named), and third-party page text
 * flowing into a model context as prose. The connector returns parsed numbers;
 * a number cannot carry an instruction.
 *
 * ── WHAT IT MAY SAY ────────────────────────────────────────────────────────
 * Same boundary as `quotes.ts`: FACT RETRIEVAL, not interpretation. It reports
 * what institutions did, as published by the exchange. It does not say what
 * that implies for direction, does not call it bullish or bearish, and does
 * not connect it to what anyone should do. "FIIs were net buyers of ₹508 Cr"
 * is a fact; "FIIs are buying, so the market is strong" is a read, and reads
 * belong to the analysis agents.
 *
 * ── AND THE ONE THING IT MUST ALWAYS SAY ───────────────────────────────────
 * The session. FII/DII and participant OI are end-of-day publications with no
 * intraday equivalent anywhere, so an answer given at 11am is about yesterday.
 * Every formatter below leads with the date for that reason — an undated
 * institutional-flow answer is wrong in the way that matters most.
 */

export type FlowAsk =
  /** Cash-market FII/DII buy/sell/net for the last completed session. */
  | 'cash'
  /** Advance/decline breadth — the one genuinely live figure here. */
  | 'breadth'
  /** Participant-wise derivatives open interest. */
  | 'positioning';

export interface FlowQuestion {
  ask: FlowAsk;
}

/**
 * Judgement requests fall through to the analysis fallback, as in `quotes.ts`.
 * "Should I follow the FII flow" is not a data question, and answering it with
 * a number would be dodging it while looking helpful.
 *
 * ── WHY THIS LIST IS NOT `quotes.ts`'s LIST ────────────────────────────────
 * It deliberately omits the bare verbs `buy`, `sell` and `hold`, which that
 * one includes. In a PRICE question those words signal advice-seeking — "should
 * I buy NIFTY" is the whole reason that guard exists. Here they are the
 * domain's own vocabulary: buying and selling is literally what this dataset
 * records, and "did DIIs sell yesterday" is a question about a completed,
 * published session. Refusing it would decline to report a public number
 * because the number is about selling.
 *
 * What remains is the advice-seeking and forward-looking vocabulary, which is
 * what actually distinguishes the two. `will` is unqualified on purpose: any
 * "will X" question about institutional flow is a prediction, whatever its
 * subject. And this is the SECOND guard regardless — the router runs the hard
 * boundaries above this resolver, so "should I buy because FIIs are buying" is
 * refused before it ever arrives.
 */
const JUDGEMENT_RE =
  /\b(should|worth|good|bad|target|entry|exit|forecast|predict|will|going to|bullish|bearish|mean for|signal to)\b/i;

/** The institutions themselves. `FPI` is NSE's own label for the foreign side. */
const PARTICIPANT_RE = /\b(fii|fiis|fpi|fpis|dii|diis|institution(?:s|al)?|foreign investor|domestic investor)\b/i;

const BREADTH_RE =
  /\b(breadth|advance[s]?[ /-]?decline[s]?|advancing|declining|adv[ /-]?dec|how many (?:stocks|shares).*(?:up|down|advanc|declin)|market internals)\b/i;

/**
 * Derivatives positioning. Requires a participant to be named too (see
 * `resolveFlowQuestion`) — "open interest on NIFTY 24400 CE" is an option-chain
 * question about one strike, which this cannot answer and must not claim.
 */
const POSITIONING_RE =
  /\b(position(?:ed|ing|s)?|open interest|\boi\b|long[s]?|short[s]?|index future[s]?|futures? position)\b/i;

/** Cash-side flow. */
const CASH_RE = /\b(bought|sold|buying|selling|net buyer|net seller|flow[s]?|activity|cash market|inflow|outflow)\b/i;

/**
 * Classify an utterance as an institutional-data lookup, or return null.
 *
 * Ordering inside this function matters as much as the router's ordering does.
 * Breadth is checked first because it names no participant and cannot be
 * confused with the other two. Positioning is checked before cash because
 * "how are FIIs positioned" contains no cash verb, while "did FIIs buy futures"
 * legitimately contains both — and in that overlap the derivatives reading is
 * the more specific answer.
 */
export function resolveFlowQuestion(text: string): FlowQuestion | null {
  if (JUDGEMENT_RE.test(text)) return null;

  if (BREADTH_RE.test(text)) return { ask: 'breadth' };

  // Everything below is about a participant. Without one named, this is not a
  // question this module can answer — and claiming it would turn a generic
  // "what's the open interest" into an answer about the wrong thing.
  if (!PARTICIPANT_RE.test(text)) return null;

  if (POSITIONING_RE.test(text)) return { ask: 'positioning' };
  if (CASH_RE.test(text)) return { ask: 'cash' };

  // A bare "what about FIIs" — cash flow is the figure that phrase almost
  // always means, and the answer names what it is so a mismatch is visible
  // rather than silent.
  return { ask: 'cash' };
}

// ------------------------------------------------------------------ answers

/**
 * Cash-market flow, read back as published.
 *
 * `net` may be null when NSE published no figure for a participant. That is
 * rendered as "not published" and never as zero — zero means institutions
 * transacted to a dead heat, which is a different claim from having no reading.
 */
export function formatCashFlow(flow: FiiDiiFlow): string {
  if (flow.rows.length === 0) {
    return "NSE hasn't published FII/DII cash figures for a recent session yet, so I don't have any to give you.";
  }

  const lines = [`**Institutional cash activity — ${flow.session ?? 'last completed session'}**`, ''];

  for (const row of flow.rows) {
    const label = row.category === 'FII' ? 'FII / FPI' : 'DII';
    if (row.net == null) {
      lines.push(`**${label}** — not published for this session`);
      continue;
    }
    const stance = row.net > 0 ? 'net buyers' : row.net < 0 ? 'net sellers' : 'flat';
    lines.push(`**${label}** — ${stance} of ${formatCrore(row.net)}`);
    if (row.buy != null && row.sell != null) {
      lines.push(`bought ${formatCrore(row.buy)} · sold ${formatCrore(row.sell)}`);
    }
  }

  lines.push('');
  // The provenance line is not boilerplate. Someone asking this at 11am on a
  // Tuesday is being told about Monday, and nothing else on screen says so.
  lines.push(
    'Source: NSE, cash market. This is an end-of-day publication — there is no intraday FII/DII figure, so during market hours it describes the previous session.',
  );
  return lines.join('\n');
}

/** Advance/decline breadth — a live count of constituents, nothing derived. */
export function formatBreadth(breadth: BreadthSnapshot): string {
  if (breadth.advances == null || breadth.declines == null) {
    return `NSE didn't return advance/decline counts for ${breadth.index} just now, so I don't have breadth to report.`;
  }
  const lines = [
    `**${breadth.index} breadth**`,
    '',
    `${breadth.advances} advancing · ${breadth.declines} declining${
      breadth.unchanged != null ? ` · ${breadth.unchanged} unchanged` : ''
    }`,
  ];
  if (breadth.last != null) {
    const sign = (breadth.percentChange ?? 0) >= 0 ? '+' : '';
    lines.push(
      `Index at ${breadth.last.toLocaleString('en-IN')}${
        breadth.percentChange != null ? ` (${sign}${breadth.percentChange.toFixed(2)}%)` : ''
      }`,
    );
  }
  lines.push('', 'Source: NSE index constituents, live through the session.');
  return lines.join('\n');
}

/**
 * Derivatives positioning.
 *
 * Reports the long and short contract counts and their ratio, and stops there.
 * The ratio is arithmetic on two published numbers; what a short-heavy book
 * implies for direction is a read, and this module does not make reads.
 */
export function formatPositioning(oi: ParticipantOi): string {
  const rows = oi.rows.filter((r) => /^(FII|DII|Client|Pro)/i.test(r.participant));
  if (rows.length === 0) {
    return "NSE hasn't published a participant open-interest report for the recent sessions yet, so I don't have positioning to give you.";
  }

  const lines = [`**Derivatives positioning — ${oi.session ?? 'last completed session'}**`, '', '_Index futures, in contracts:_'];

  for (const row of rows) {
    if (row.futureIndexLong == null || row.futureIndexShort == null) continue;
    const ratio =
      row.futureIndexLong > 0 ? `${(row.futureIndexShort / row.futureIndexLong).toFixed(1)}× short` : '—';
    lines.push(
      `**${row.participant}** — ${row.futureIndexLong.toLocaleString('en-IN')} long · ${row.futureIndexShort.toLocaleString(
        'en-IN',
      )} short (${ratio})`,
    );
  }

  lines.push('');
  lines.push(
    'Source: NSE participant-wise open interest. End-of-day publication for the session shown, in contracts rather than rupees.',
  );
  return lines.join('\n');
}
