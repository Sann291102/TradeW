/**
 * "Explain X" questions — and why they must never resolve to navigation.
 *
 * ── THE BUG THIS EXISTS TO PREVENT (2026-08-11) ────────────────────────────
 *
 * Asked "How does the FVG concept work, and what is BOS, MSS, CHoCH?", the
 * assistant replied with the question restated as a goal and a single step:
 * "✓ Open Research". It had navigated to a page, reported success, and taught
 * the user nothing. The conversation brain produced that plan because opening
 * Research *looks* helpful, and its guardrail against it ("if the request needs
 * analysis, return no steps") is a prompt — advisory, not enforced.
 *
 * So the check moved here, into deterministic code the model cannot overrule.
 * An explain-question is classified before the brain is ever consulted, and the
 * honest answer is given instead: these concepts are not in the knowledge base
 * and the analysis agents are not connected, so she does not know. Opening a
 * page the user did not ask for, and calling that an answer, is worse than
 * saying "I can't explain that yet" — it wastes their time and it misrepresents
 * what the product can do.
 *
 * ── WHY NOT JUST ANSWER FROM THE MODEL ─────────────────────────────────────
 *
 * Because an ungrounded answer about market structure is exactly what this
 * product promises not to give. `knowledge-base/` holds 66 curated concepts
 * (breakout, false-breakout, liquidity-sweep, swing-point, trend…) and every
 * explanation the platform ships is meant to trace to one of them or to a book
 * in `docs/Trading Books/`. The Smart Money Concepts vocabulary — FVG, BOS,
 * CHoCH, MSS, order block — is genuinely absent from both today. Letting the
 * LLM improvise would produce confident, unsourced trading education, which is
 * the failure mode `TRADEW-AI.md` §4 exists to prevent.
 *
 * When the Learning AI phase lands (book ingestion + retrieval + provenance),
 * this module is where those questions get routed to real, cited answers.
 * Until then it is where they get an honest no.
 *
 * ── WHAT CHANGED, AND WHAT DID NOT (2026-08-31) ────────────────────────────
 *
 * Tara can now MEASURE a market (`analysis.ts` → the canonical observation
 * route): structure, levels, indicators, option context, all real. That does
 * not move this boundary an inch. "Where is the break of structure on NIFTY"
 * is a measurement and is answered; "what IS a break of structure" is trading
 * education and still is not, because the `knowledge-base/` corpus carries no
 * FVG, BOS or CHoCH concept to cite — even though the ENGINE detects all three
 * (`market-structure.ts`, `charts/fvg.ts`). Detecting a thing and being able to
 * teach it from a sourced definition are different capabilities, and conflating
 * them is how unsourced trading education ships.
 */

/**
 * Phrasings that mean "teach me what this is", not "take me somewhere".
 *
 * Exported because `commands.ts` must consult the SAME definition before it
 * treats "FVG" as an instruction to draw. Two copies of "what counts as a
 * question" is exactly how "what is a fair value gap" ends up answered by
 * putting rectangles on a chart — the failure this module exists to prevent.
 */
export const EXPLAIN_RE =
  /\b(explain|what (?:is|are|does|do)|what'?s\b|how (?:does|do|is|are|can|to)\b|meaning of|define|definition of|difference between|tell me about|teach me|help me understand|why (?:does|do|is|are))\b/i;

/**
 * Concept vocabulary the assistant is asked about but cannot source.
 *
 * Deliberately a NAMED list rather than a catch-all: each entry is a concept
 * someone has actually asked for and the knowledge base does not contain, so
 * the list doubles as the backlog for what to ingest first.
 */
export const UNSOURCED_CONCEPTS: ReadonlyArray<{ term: string; aliases: string[] }> = [
  { term: 'Fair Value Gap', aliases: ['fvg', 'fair value gap', 'imbalance'] },
  { term: 'Break of Structure', aliases: ['bos', 'break of structure'] },
  { term: 'Change of Character', aliases: ['choch', 'ch-och', 'change of character'] },
  { term: 'Market Structure Shift', aliases: ['mss', 'market structure shift'] },
  { term: 'Order Block', aliases: ['order block', 'orderblock', 'ob zone'] },
  { term: 'Smart Money Concepts', aliases: ['smart money concepts', 'smc', 'ict'] },
  { term: 'Liquidity Void', aliases: ['liquidity void'] },
  { term: 'Premium and Discount zones', aliases: ['premium zone', 'discount zone'] },
];

export interface ConceptQuestion {
  /** Concepts named in the utterance that the knowledge base cannot source. */
  unsourced: string[];
}

/**
 * Classify an utterance as an explain-question, or return null.
 *
 * Requires BOTH an explain phrasing and no command verb — "open the FVG chart"
 * is navigation that happens to mention a concept, and must keep resolving as
 * navigation.
 */
export function resolveConceptQuestion(text: string): ConceptQuestion | null {
  if (!EXPLAIN_RE.test(text)) return null;

  // A command verb wins: "show me what the option chain is" is still a request
  // to open the option chain.
  if (/\b(open|show|go to|take me|navigate|switch to|apply|hide)\b/i.test(text)) {
    // …unless the explain phrasing is clearly the subject ("explain what X is").
    if (!/\b(explain|meaning of|define|teach me|help me understand)\b/i.test(text)) return null;
  }

  const lower = text.toLowerCase();
  const unsourced = UNSOURCED_CONCEPTS.filter((c) =>
    c.aliases.some((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)),
  ).map((c) => c.term);

  return { unsourced };
}

/**
 * The reply. Names what was asked for, says plainly that it is not in the
 * knowledge base, and does not pretend a page visit is an answer.
 */
export function conceptReply(q: ConceptQuestion): string {
  if (q.unsourced.length) {
    const list =
      q.unsourced.length === 1
        ? q.unsourced[0]!
        : `${q.unsourced.slice(0, -1).join(', ')} and ${q.unsourced[q.unsourced.length - 1]}`;
    return [
      `I can't explain ${list} yet — honestly rather than badly.`,
      '',
      "Those concepts aren't in my knowledge base, and I won't improvise trading education I can't source. Everything I teach is meant to trace back to a curated concept or a book, and these don't yet.",
      '',
      "What I do have today: prices, the day's range and volume, control of the app, and a full measured read of any supported market — say \"analyse NIFTY\" and I'll give you indicators, structure, levels and option context off the canonical engine. Teaching a concept from a sourced knowledge base is the part that is still missing.",
    ].join('\n');
  }

  return [
    "That's a concept question, and I can't source an answer to it yet — the knowledge base doesn't cover it.",
    '',
    "I won't guess at an explanation: an unsourced answer about market structure is exactly what this platform promises not to give. What I can do instead is MEASURE it — \"analyse NIFTY on 15m\" gets you the real structure, levels and indicators rather than a definition.",
  ].join('\n');
}
