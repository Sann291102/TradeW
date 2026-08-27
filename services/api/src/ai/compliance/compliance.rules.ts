/**
 * The advice boundary, as code.
 *
 * `TRADEW-OS.md` §1 requires "observation, never advice" to be an
 * ARCHITECTURAL property, not a prompt instruction. This module is that
 * property: a pure, deterministic evaluator that every assistant response
 * passes through on the server before it can reach a client
 * (`TRADEW-ASSISTANT.md` §11).
 *
 * Pure by design — no Nest, no I/O, no model call. That makes the boundary
 * exhaustively testable, which is the only way to have justified confidence in
 * it. `compliance.gate.ts` wraps this with fail-closed error handling and
 * persistence.
 *
 * ## The distinction this file exists to draw
 *
 * The hard problem is not spotting the word "buy". It is separating
 * DIRECTIVE from DESCRIPTIVE, because legitimate market commentary is soaked
 * in trading vocabulary:
 *
 *   BLOCK   "You should buy RELIANCE above 1400 with a stop at 1380."
 *   ALLOW   "Long buildup in RELIANCE — buyers added positions above 1400."
 *
 * Both contain "buy"/"long"/"1400". Only the first tells the user what to do.
 * A gate that blocks the second is useless, because it makes the product
 * unable to describe the market at all. Every rule below therefore matches on
 * the SHAPE of a recommendation — imperative mood, second-person modal,
 * first-person endorsement, or an instruction-bearing price level — and every
 * one is paired with descriptive constructions it must not fire on
 * (`compliance.rules.spec.ts` asserts both directions).
 */

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type ComplianceDecision = 'allow' | 'block';

export interface ComplianceFinding {
  /** Stable rule id, e.g. `advice.stop-loss`. Logged, so keep these stable. */
  ruleId: string;
  /** The clause that tripped it, truncated. For audit, not for display. */
  excerpt: string;
}

export interface ComplianceVerdict {
  decision: ComplianceDecision;
  findings: ComplianceFinding[];
  /** Bumped when rules change, so a stored verdict says which logic produced it. */
  gateVersion: string;
  evaluatedAt: string;
  /** Set when the gate failed closed rather than reaching a real decision. */
  failedClosed?: boolean;
  error?: string;
}

export const GATE_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const ZERO_WIDTH = /[​-‍﻿⁠]/g;
const BIDI = /[‪-‮⁦-⁩]/g;

/** Cyrillic/Greek lookalikes for Latin letters used in the rule vocabulary. */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ѕ: 's',
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴇ: 'e', ɡ: 'g', ʟ: 'l', ᴏ: 'o', ѕ_: 's',
  ο: 'o', ε: 'e', ρ: 'p', τ: 't', υ: 'u', ν: 'v',
};

/**
 * Fold text to a comparable form. Deliberately moderate: the realistic threat
 * is a model drifting into advice or a user prompt-injecting for a signal —
 * both produce ordinary prose, not homoglyph soup. Enough normalization to
 * defeat casual obfuscation, not so much that it mangles legitimate text.
 */
export function normalize(input: string): string {
  let s = input.normalize('NFKC').replace(ZERO_WIDTH, '').replace(BIDI, '');
  s = s.replace(/[а-яёα-ωᴀ-ᴢ]/g, (ch) => HOMOGLYPHS[ch] ?? ch);
  s = s.toLowerCase();
  // Markdown emphasis and code ticks, so `**buy**` reads as `buy`.
  s = s.replace(/[*_`~]/g, '');
  // Currency and thousands separators, so "1,400" and "₹1400" compare equal.
  s = s.replace(/[₹$]/g, ' ');
  s = s.replace(/(\d),(\d)/g, '$1$2');
  // Collapse 3+ repeats ("buuuy" -> "buuy" -> matched by the \w+ patterns).
  s = s.replace(/(.)\1{2,}/g, '$1$1');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Split into independently-judged clauses.
 *
 * Clause-level rather than message-level evaluation is what stops a refusal
 * prefix from laundering a directive: "I can't give advice, but buy RELIANCE"
 * splits at ", but", so the exemption covers only the first half and the
 * second half is judged on its own. Sentence terminators, semicolons, bullets,
 * newlines and contrastive conjunctions are all boundaries.
 */
export function clauses(normalized: string): string[] {
  return normalized
    // Dashes are clause boundaries too. Splitting more aggressively only ever
    // makes the gate stricter: an exemption then covers less text, so a
    // directive is more likely to be judged on its own.
    .split(/(?:[.!?;\n]+|\s+[—–]\s+|,\s*(?:but|however|though|although)\b|\s+(?:but|however)\s+|^[-•*]\s*)/gm)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Exemptions — descriptive constructions that must never be blocked
// ---------------------------------------------------------------------------

/**
 * Market-structure and options vocabulary. These describe what participants
 * DID; they are the substance of legitimate analysis and are especially dense
 * in Indian F&O commentary ("long buildup", "short covering").
 */
const DESCRIPTIVE = [
  /\b(buyers?|sellers?)\b/,
  /\b(buying|selling)\s+(pressure|interest|activity|momentum|volume|flow)\b/,
  /\b(buy|sell)[-\s]?side\b/,
  /\blong\s+(buildup|build[-\s]?up|unwinding|positions?\s+(were|are|have))\b/,
  /\bshort\s+(buildup|build[-\s]?up|covering|unwinding|interest|positions?\s+(were|are|have))\b/,
  /\b(call|put)\s+(writers?|writing|buyers?|sellers?|oi|open\s+interest)\b/,
  /\b(bought|sold|accumulated|offloaded)\b/,
  /\b(fiis?|diis?|institutions?|retail|promoters?)\b.*\b(bought|sold|net)\b/,
  /\bsold\s+off\b/,
  /\b(support|resistance)\s+(at|near|around|zone|level)\b/,
];

/**
 * Definitional / educational framing. The Learning Assistant's whole job is
 * explaining what a stop-loss IS; that must not read as setting one.
 */
const EDUCATIONAL = [
  /\b(a|an|the)\s+[\w\s-]{0,24}\b(is|are|means?|refers?\s+to|describes?)\b/,
  /\b(traders?|investors?|people|some|many|most)\s+(often|typically|usually|sometimes|generally|may|might|will)\b/,
  // A named third-party group as the grammatical subject is description, not
  // instruction: "some traders go long when price reclaims VWAP" teaches a
  // pattern, "go long when price reclaims VWAP" tells the reader to do it.
  /\b(?:some|many|most|other|professional|experienced|retail|institutional|swing|intraday)\s+(?:traders?|investors?|participants?)\b/,
  /\bfor\s+example\b/,
  /\bthe\s+term\b/,
  /\bthink\s+of\s+it\s+as\b/,
];

/**
 * Third-party attribution. Reporting that analysts have a target is market
 * information; adopting that target is advice. The rules below fire on the
 * latter, so attribution must exempt the former explicitly.
 */
const ATTRIBUTED = [
  /\b(analysts?|brokerages?|the\s+street|consensus|research\s+houses?|estimates?)\b/,
  /\baccording\s+to\b/,
  /\b\w+\s+(has|have|had)\s+(a|an)\s+(target|rating|price\s+target)\b/,
];

/**
 * The assistant's own refusal and disclaimer copy.
 *
 * Without this the gate blocks its own refusals — the refusal text necessarily
 * contains "buy or sell" — and every boundary-testing question would return a
 * fail-closed error instead of a clean "I don't do that." A real bug class,
 * asserted against in the spec.
 */
const REFUSAL = [
  /\bi\s+(can'?t|cannot|won'?t|do\s?n'?t|am\s+not\s+able\s+to|'m\s+not\s+able\s+to)\b/,
  /\bnever\s+(investment\s+)?advice\b/,
  /\bnot\s+(investment|financial|trading)\s+advice\b/,
  /\bobservations?\s+only\b/,
  /\bi\s+(don'?t|do\s+not)\s+(give|provide|offer|make)\b/,
  /\bthat'?s\s+not\s+something\s+i\b/,
  /\bmy\s+remit\b/,
  /\boutside\s+what\s+i\s+do\b/,
];

function matchesAny(clause: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(clause));
}

/** True when a clause is descriptive/educational/attributed/refusal framing. */
export function isExempt(clause: string): boolean {
  return (
    matchesAny(clause, REFUSAL) ||
    matchesAny(clause, DESCRIPTIVE) ||
    matchesAny(clause, EDUCATIONAL) ||
    matchesAny(clause, ATTRIBUTED)
  );
}

// ---------------------------------------------------------------------------
// Blocking rules
// ---------------------------------------------------------------------------

export interface ComplianceRule {
  id: string;
  description: string;
  pattern: RegExp;
}

const TRADE_VERB = '(buy|sell|short|long|purchase|acquire|dump|offload|exit|enter|book|square\\s+off|average|accumulate|avoid|hold|add)';

export const RULES: ComplianceRule[] = [
  {
    id: 'advice.recommendation',
    description: 'Second-person or first-person recommendation to trade',
    pattern: new RegExp(
      `\\b(?:you\\s+(?:should|must|need\\s+to|ought\\s+to|can|could|might\\s+want\\s+to|may\\s+want\\s+to|'?d\\s+better)\\s+(?:\\w+\\s+){0,2}${TRADE_VERB}` +
        `|i\\s*(?:'d|\\s+would)\\s+(?:${TRADE_VERB})` +
        `|i\\s+(?:recommend|suggest|advise|urge)\\b` +
        `|my\\s+(?:recommendation|advice|suggestion|call)\\b` +
        `|(?:it'?s|its|this\\s+is|that'?s)\\s+(?:a\\s+)?(?:good|great|strong|smart|safe)\\s+(?:time\\s+to\\s+)?${TRADE_VERB}` +
        `|\\bis\\s+a\\s+(?:strong\\s+)?(?:buy|sell)\\b` +
        `|worth\\s+(?:buying|selling|shorting|holding|accumulating)\\b` +
        `|\\b(?:best|ideal)\\s+(?:entry|exit|time\\s+to\\s+(?:buy|sell))\\b)`,
      'i',
    ),
  },
  {
    id: 'advice.imperative',
    description: 'Bare imperative trade instruction addressed to the reader',
    // Clause-initial imperative: "buy RELIANCE", "go long here", "book profits".
    // Requires the verb at clause start so "buyers bought" cannot match.
    pattern: new RegExp(
      `^(?:so\\s+|then\\s+|now\\s+|just\\s+|please\\s+)?` +
        `(?:go\\s+(?:long|short)|${TRADE_VERB})\\b(?!\\s*(?:ers?|ing|side|-side)\\b)`,
      'i',
    ),
  },
  {
    id: 'advice.stop-loss',
    description: 'Setting a stop-loss for the user',
    pattern:
      /\b(?:stop[-\s]?loss|stoploss|\bsl\b|trailing\s+stop)\s*(?:at|of|near|below|above|:)\s*\d|\b(?:keep|place|put|set|trail|maintain)\s+(?:a\s+|your\s+|the\s+)?(?:stop|sl|stop[-\s]?loss)\b/i,
  },
  {
    id: 'advice.target',
    description: 'Issuing a price target as a call',
    pattern:
      /\b(?:target|tgt|tp)\s*(?:price)?\s*(?:of|at|is|:)\s*\d|\b(?:aim|look)\s+for\s+\d|\bfirst\s+target\b|\btargets?\s+of\s+\d/i,
  },
  {
    id: 'advice.entry-exit-level',
    description: 'Instructing entry or exit at a level',
    pattern:
      /\b(?:entry|enter|exit|buy|sell|add|accumulate|average)\s+(?:at|above|below|near|around|on)\s+(?:\d|dips?|rallies|declines?|support|resistance)|\bbook\s+(?:profits?|partial|gains?)\b|\bcut\s+(?:your\s+)?loss(?:es)?\b|\bhold\s+(?:on\s+)?(?:to|for)\b/i,
  },
  {
    id: 'advice.position-directive',
    description: 'Directing the user to take or change a position',
    pattern:
      /\b(?:take|initiate|open|build|start)\s+(?:a\s+|your\s+)?(?:long|short|position|trade)\b|\bgo\s+(?:long|short)\b|\bsquare\s+off\b|\bstay\s+(?:long|short|out)\b|\bget\s+out\s+of\b/i,
  },
  {
    id: 'advice.certainty',
    description: 'Stating a market outcome as certain',
    // `(?:is|'s)` because "it's going to hit 1450" is the natural phrasing and
    // "is going to hit" almost never appears uncontracted in generated prose.
    pattern:
      /\b(?:will\s+(?:definitely|certainly|surely)|guaranteed\s+to|(?:is|'s)\s+going\s+to\s+(?:hit|reach|touch)|no\s+doubt\s+it\s+will|100%\s+(?:sure|certain))\b/i,
  },
];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate assistant-authored text against the advice boundary.
 *
 * Never throws — an internal failure is the caller's cue to fail closed, and
 * `compliance.gate.ts` converts a thrown error into a `block` verdict. This
 * function returning `allow` therefore always means "the rules ran and found
 * nothing", never "the rules could not run".
 */
export function evaluateCompliance(text: string): ComplianceVerdict {
  const findings: ComplianceFinding[] = [];
  const normalized = normalize(text ?? '');

  for (const clause of clauses(normalized)) {
    if (isExempt(clause)) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(clause)) {
        findings.push({ ruleId: rule.id, excerpt: clause.slice(0, 160) });
      }
    }
  }

  return {
    decision: findings.length > 0 ? 'block' : 'allow',
    findings,
    gateVersion: GATE_VERSION,
    evaluatedAt: new Date().toISOString(),
  };
}
