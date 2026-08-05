import type { HistoricalSimilarityResult } from '../brain/historical-similarity.service';
import type { Signal } from '../domain';
import type { OptionChainRead } from '../intelligence/market-intelligence.service';

/**
 * Institutional cross-validation — Phase 6.
 *
 * Sentinel had cross-validation of exactly one kind: whether the second
 * reasoning engine agreed with the first (`buildCrossValidation`). That is a
 * check between two *readers of the same data*, and it is genuinely useful,
 * but it is not what an institutional desk means by cross-validation.
 *
 * A desk asks a different question: do the independent *evidence dimensions*
 * agree? Technicals can say one thing while option positioning says another,
 * historical outcomes say a third, and the newswire disagrees with all of
 * them. That disagreement is the single most valuable thing to show a trader,
 * and until now nothing in Sentinel computed it.
 *
 * This module scores each dimension's stance independently, then reports
 * consensus, dissent and abstention. It changes nothing about what publishes —
 * the four-condition publication gate remains the only authority on that. This
 * is transparency, not a sixth gate.
 *
 * ## Abstention is not neutrality
 *
 * A dimension with no data ABSTAINS; it does not vote neutral. The difference
 * is load-bearing. Option chain and news currently return empty for every
 * symbol (`getOptionChain`/`getNews` return `[]`), and counting them as
 * "neutral" would report five dimensions in mild agreement when only three
 * actually looked. Consensus is computed over dimensions that voted, and the
 * abstentions are named so a trader can see how much of the picture is missing.
 */

export type DimensionId = 'technical' | 'structure' | 'option-chain' | 'historical' | 'news';

export type DimensionStance = 'bullish' | 'bearish' | 'neutral' | 'abstain';

export interface DimensionRead {
  id: DimensionId;
  label: string;
  stance: DimensionStance;
  /** 0..1 — how strongly this dimension holds its stance. 0 when abstaining. */
  strength: number;
  /** Always populated, including when abstaining — the reason for the abstention. */
  evidence: string;
}

export interface InstitutionalCrossValidation {
  dimensions: DimensionRead[];
  /** The stance the voting dimensions most support, or null when none voted. */
  consensus: 'bullish' | 'bearish' | 'neutral' | null;
  /** How many dimensions actually voted (did not abstain). */
  voting: number;
  /** Of those, how many agreed with the consensus. */
  agreeing: number;
  /** Dimensions that voted against the consensus — the most informative field. */
  dissenting: DimensionId[];
  /** Dimensions with no data, and therefore no vote. */
  abstaining: DimensionId[];
  /** 0..1 — agreement among voting dimensions, weighted by their strength. */
  agreementScore: number;
  /** Trader-facing summary. Non-directive. */
  summary: string;
}

export interface CrossValidationInput {
  leadingBias: 'bullish' | 'bearish' | 'neutral';
  signals: Signal[];
  optionChain: OptionChainRead | null;
  historical: HistoricalSimilarityResult | null;
  behaviour: {
    read: 'continuation' | 'reversal-risk' | 'indecision' | 'undefined';
    direction: 'bullish' | 'bearish' | 'neutral';
    strength: number;
  } | null;
  /**
   * Spot, for judging option positioning against price.
   *
   * NOTE: an `engineTwo` field was removed here. It was declared and passed in
   * but never read — implying a cross-engine input this matrix does not
   * actually take. SentinelIntelligence's verdict is a second READER of the
   * same evidence, not a sixth evidence dimension; folding it in would count
   * technicals and structure twice, once directly and once through the agents
   * that read them. Engine agreement is reported separately as
   * `ObserveResponse.crossValidation`.
   */
  lastPrice: number;
}

/**
 * Score every dimension and summarise their agreement.
 *
 * Pure and synchronous — every input is resolved by the caller, so the whole
 * matrix is verifiable from plain objects.
 */
export function buildInstitutionalCrossValidation(input: CrossValidationInput): InstitutionalCrossValidation {
  const dimensions: DimensionRead[] = [
    technicalDimension(input),
    structureDimension(input),
    optionChainDimension(input),
    historicalDimension(input),
    newsDimension(input),
  ];

  const voters = dimensions.filter((d) => d.stance !== 'abstain');
  const abstaining = dimensions.filter((d) => d.stance === 'abstain').map((d) => d.id);

  if (voters.length === 0) {
    return {
      dimensions,
      consensus: null,
      voting: 0,
      agreeing: 0,
      dissenting: [],
      abstaining,
      agreementScore: 0,
      summary: 'No evidence dimension has enough data to form a read. Nothing is being cross-validated.',
    };
  }

  // Weighted vote: a dimension holding its stance strongly counts for more
  // than one barely holding it. Ties resolve to neutral, which is the honest
  // answer when the evidence genuinely splits.
  const tally: Record<'bullish' | 'bearish' | 'neutral', number> = { bullish: 0, bearish: 0, neutral: 0 };
  for (const d of voters) tally[d.stance as 'bullish' | 'bearish' | 'neutral'] += d.strength;

  const ranked = (Object.entries(tally) as ['bullish' | 'bearish' | 'neutral', number][]).sort((a, b) => b[1] - a[1]);
  const consensus = ranked[0][1] === ranked[1][1] ? 'neutral' : ranked[0][0];

  const agreeingReads = voters.filter((d) => d.stance === consensus);
  const dissenting = voters.filter((d) => d.stance !== consensus).map((d) => d.id);

  const totalStrength = voters.reduce((s, d) => s + d.strength, 0) || 1;
  const agreementScore = agreeingReads.reduce((s, d) => s + d.strength, 0) / totalStrength;

  return {
    dimensions,
    consensus,
    voting: voters.length,
    agreeing: agreeingReads.length,
    dissenting,
    abstaining,
    agreementScore: Number(agreementScore.toFixed(3)),
    summary: summarise(consensus, voters.length, agreeingReads.length, dissenting, abstaining, agreementScore),
  };
}

/** Signal names that are emitted under the technical agent but are NOT technicals. */
const NON_TECHNICAL_SIGNALS = ['news_driven_volatility'];

function technicalDimension(input: CrossValidationInput): DimensionRead {
  // `NewsIntelligenceService` emits under `agent: 'market-technical'` (there is
  // no 'news' member of `SignalAgent`), so filtering on the agent alone would
  // count the news signal as technical corroboration AND as its own dimension
  // — one piece of evidence voting twice. Excluded by name.
  const technical = input.signals.filter(
    (s) => s.agent === 'market-technical' && s.triggered && !NON_TECHNICAL_SIGNALS.includes(s.name),
  );
  if (technical.length === 0) {
    return {
      id: 'technical',
      label: 'Technicals',
      stance: 'abstain',
      strength: 0,
      evidence: 'No technical signal is currently triggered.',
    };
  }
  const strength = Math.min(1, technical.reduce((s, t) => s + t.weight, 0));
  return {
    id: 'technical',
    label: 'Technicals',
    stance: input.leadingBias,
    strength,
    evidence: `${technical.length} triggered technical signal(s): ${technical.map((t) => t.name.replace(/_/g, ' ')).join(', ')}.`,
  };
}

function structureDimension(input: CrossValidationInput): DimensionRead {
  const b = input.behaviour;
  if (!b || b.read === 'undefined') {
    return {
      id: 'structure',
      label: 'Market structure',
      stance: 'abstain',
      strength: 0,
      evidence: 'Not enough confirmed structure to form a read.',
    };
  }
  if (b.read === 'indecision' || b.direction === 'neutral') {
    return {
      id: 'structure',
      label: 'Market structure',
      stance: 'neutral',
      strength: Math.max(0.2, b.strength),
      evidence: 'Structure shows no directional sequence.',
    };
  }
  // A reversal-risk read votes AGAINST the direction it is reversing from —
  // which is the direction field itself, since `readBehaviour` already sets
  // `direction` to where the character changed TO.
  return {
    id: 'structure',
    label: 'Market structure',
    stance: b.direction,
    strength: b.strength,
    evidence:
      b.read === 'reversal-risk'
        ? `Structure shows ${b.direction} reversal risk at ${(b.strength * 100).toFixed(0)}% supporting evidence.`
        : `Structure is continuing ${b.direction} at ${(b.strength * 100).toFixed(0)}% supporting evidence.`,
  };
}

function optionChainDimension(input: CrossValidationInput): DimensionRead {
  const chain = input.optionChain;
  if (!chain) {
    return {
      id: 'option-chain',
      label: 'Option positioning',
      stance: 'abstain',
      strength: 0,
      // Named explicitly: this is currently true for every symbol, and a
      // trader should know that a fifth of the matrix is dark.
      evidence: 'No option chain is published for this instrument, so positioning cannot be read.',
    };
  }
  // PCR above 1 means put writers dominate, which sits with the upside.
  const bullish = chain.pcr >= 1;
  const distance = Math.abs(chain.pcr - 1);
  const pinned = input.lastPrice > 0 && Math.abs(input.lastPrice - chain.maxPain) / input.lastPrice < 0.003;
  if (pinned) {
    return {
      id: 'option-chain',
      label: 'Option positioning',
      stance: 'neutral',
      strength: 0.6,
      evidence: `Spot is pinned to max pain ${chain.maxPain.toFixed(0)}, where directional follow-through is historically suppressed.`,
    };
  }
  return {
    id: 'option-chain',
    label: 'Option positioning',
    stance: bullish ? 'bullish' : 'bearish',
    strength: Math.min(1, 0.35 + distance),
    evidence: `Put-call OI ratio ${chain.pcr.toFixed(2)} across ${chain.strikesAnalysed} strikes — ${bullish ? 'put' : 'call'} writers dominate.`,
  };
}

function historicalDimension(input: CrossValidationInput): DimensionRead {
  const h = input.historical;
  if (!h || h.occurrences === 0) {
    return {
      id: 'historical',
      label: 'Historical outcomes',
      stance: 'abstain',
      strength: 0,
      evidence: 'No prior recorded occurrences of this pattern on this symbol.',
    };
  }
  if (h.sampleTooSmall) {
    return {
      id: 'historical',
      label: 'Historical outcomes',
      stance: 'abstain',
      strength: 0,
      evidence: `${h.occurrences} prior occurrence(s) but only ${h.withKnownOutcome} with a known outcome — too few to vote.`,
    };
  }
  const total = Object.values(h.outcomeCounts).reduce((a, b) => a + b, 0) || 1;
  const ranked = Object.entries(h.outcomeCounts).sort((a, b) => b[1] - a[1]);
  const [topOutcome, topCount] = ranked[0];
  const share = topCount / total;

  // A dominant "unclear" is the opposite of signal and must never be read as
  // a success rate — the same trap the confidence engine's historical factor
  // guards against.
  if (topOutcome === 'unclear') {
    return {
      id: 'historical',
      label: 'Historical outcomes',
      stance: 'neutral',
      strength: 0.4,
      evidence: `Most prior occurrences resolved unclear (${Math.round(share * 100)}% of ${total}).`,
    };
  }

  const worked = ['followed_through', 'target_reached', 'success'].includes(topOutcome);
  return {
    id: 'historical',
    label: 'Historical outcomes',
    stance: worked ? input.leadingBias : oppose(input.leadingBias),
    strength: Math.min(1, share),
    evidence: `${Math.round(share * 100)}% of ${total} outcome-tagged occurrences resolved as ${topOutcome.replace(/_/g, ' ')}.`,
  };
}

function newsDimension(input: CrossValidationInput): DimensionRead {
  const news = input.signals.find((s) => s.name === 'news_driven_volatility');
  if (!news) {
    return {
      id: 'news',
      label: 'News environment',
      stance: 'abstain',
      strength: 0,
      evidence: 'News intelligence did not report for this symbol.',
    };
  }
  if (!news.triggered) {
    return {
      id: 'news',
      label: 'News environment',
      stance: 'neutral',
      strength: 0.5,
      evidence: 'No high-impact news flow — a quiet tape neither supports nor opposes the structural read.',
    };
  }
  // Live high-impact flow can override any amount of structure, so it votes
  // neutral with high strength: it actively dilutes a directional consensus
  // rather than taking a side it has no basis to take.
  return {
    id: 'news',
    label: 'News environment',
    stance: 'neutral',
    strength: 0.85,
    evidence: `High-impact news flow is live: ${news.evidence[0] ?? 'see news signals'}.`,
  };
}

function oppose(bias: 'bullish' | 'bearish' | 'neutral'): 'bullish' | 'bearish' | 'neutral' {
  if (bias === 'bullish') return 'bearish';
  if (bias === 'bearish') return 'bullish';
  return 'neutral';
}

function summarise(
  consensus: 'bullish' | 'bearish' | 'neutral',
  voting: number,
  agreeing: number,
  dissenting: DimensionId[],
  abstaining: DimensionId[],
  agreementScore: number,
): string {
  const parts: string[] = [
    `${agreeing} of ${voting} evidence dimensions support a ${consensus} read (${(agreementScore * 100).toFixed(0)}% weighted agreement).`,
  ];
  if (dissenting.length > 0) {
    parts.push(`Dissenting: ${dissenting.join(', ')} — the disagreement is itself worth reading.`);
  }
  if (abstaining.length > 0) {
    parts.push(`No data from: ${abstaining.join(', ')}, so ${abstaining.length} dimension(s) are not represented.`);
  }
  return parts.join(' ');
}
