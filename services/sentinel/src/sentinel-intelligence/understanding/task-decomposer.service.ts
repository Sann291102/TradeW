import { Injectable } from '@nestjs/common';
import type { AgentId, DecompositionPlan, ReasonRequest, Subtask, UnderstoodRequest } from '../types';

/**
 * Splits one understood request into per-agent subtasks.
 *
 * Two rules shape this:
 *
 * 1. **An agent with nothing to work on is skipped, loudly.** Emotion
 *    Intelligence with no trade history would otherwise return a confident
 *    "no behavioural risk detected", which reads as an all-clear when it
 *    actually means "no data". Skips are recorded with a reason and shown in
 *    the audit trail, so absence of a verdict is never mistaken for absence of
 *    a problem.
 *
 * 2. **Weights follow intent, not a fixed hierarchy.** For an options question
 *    the chain agent carries more weight than the news agent; for a behaviour
 *    review the reverse. A single static weighting would make every question
 *    get answered as if it were the same question.
 *
 * Compliance and Learning always run: compliance because every surfaced
 * observation must be labelled whatever the question was, learning because a
 * run that teaches the system nothing is a wasted run.
 */
@Injectable()
export class TaskDecomposerService {
  decompose(understood: UnderstoodRequest, request: ReasonRequest): DecompositionPlan {
    const subtasks: Subtask[] = [];
    const skipped: { agent: AgentId; reason: string }[] = [];
    const weights = WEIGHTS_BY_INTENT[understood.intent] ?? WEIGHTS_BY_INTENT['market-read'];

    const symbol = understood.market.symbol;
    const tf = understood.timeframe;
    const add = (
      agent: AgentId,
      question: string,
      rationale: string,
      knowledgeQueries: string[],
      dependsOn: string[] = [],
    ) => {
      subtasks.push({
        id: `${agent}#${subtasks.length + 1}`,
        agent,
        question,
        rationale,
        knowledgeQueries,
        dependsOn,
        weight: weights[agent] ?? 0.5,
      });
    };

    // ---- always-on structural read -------------------------------------
    add(
      'market-intelligence',
      `What is the current structure and regime of ${symbol} on the ${tf} timeframe?`,
      'Every other agent reasons relative to the structural read, so it runs first and unconditionally.',
      [`${symbol} market structure ${tf}`, 'market regime classification trend range', 'price action structure'],
    );

    const marketTaskId = subtasks[0].id;

    add(
      'strategy-intelligence',
      understood.strategyIds.length > 0
        ? `Do the rules of ${understood.strategyIds.join(', ')} confirm on ${symbol} right now?`
        : `Which learned strategies currently have confirming rules on ${symbol}?`,
      understood.strategyIds.length > 0
        ? 'The request named specific strategies, so they are validated against live structure rather than re-discovered.'
        : 'No strategy was named, so the handbook is scanned for whatever currently confirms.',
      [
        ...understood.strategyIds.map((id) => `${id.replace(/-/g, ' ')} rules entry conditions`),
        ...understood.indicators.map((i) => `${i} strategy rules`),
        'strategy confirmation rules checklist',
      ],
      [marketTaskId],
    );

    // ---- options ---------------------------------------------------------
    const wantsOptions =
      understood.market.hasOptionChain &&
      (understood.strike !== null || understood.right !== null || understood.intent === 'option-context');
    if (understood.market.hasOptionChain) {
      add(
        'options-chain-intelligence',
        understood.strike !== null
          ? `What does the option chain show around the ${understood.strike}${understood.right ?? ''} strike on ${symbol}?`
          : `What does the ${symbol} option chain show about positioning and the likely pin?`,
        wantsOptions
          ? 'The request is about a specific contract, so chain positioning is primary evidence.'
          : 'The instrument has a chain, so positioning is read as supporting context even though no strike was named.',
        ['open interest positioning max pain', 'put call ratio interpretation', 'option writers pin expiry'],
        [marketTaskId],
      );
    } else {
      skipped.push({
        agent: 'options-chain-intelligence',
        reason: `${symbol} has no listed option chain, so there is no positioning data to read.`,
      });
    }

    // ---- news ------------------------------------------------------------
    add(
      'news-intelligence',
      `Is there news or an event on ${symbol} that would change how the current structure should be read?`,
      'Structure formed into an unscheduled event means something different from the same structure in a quiet tape.',
      ['news event impact volatility', 'event driven price behaviour'],
      [marketTaskId],
    );

    // ---- risk ------------------------------------------------------------
    add(
      'risk-intelligence',
      `What is the current risk environment for a ${understood.style} ${understood.riskProfile} participant in ${symbol}?`,
      'Risk is scored independently of direction so a dangerous tape is flagged even when structure looks clean.',
      ['risk management position sizing volatility', 'drawdown control risk of ruin'],
      [marketTaskId],
    );

    // ---- traps -----------------------------------------------------------
    add(
      'trap-intelligence',
      `Are there trap signatures on ${symbol} — sweeps, failed breakouts, expiry or low-participation traps?`,
      'Trap detection is composite by design and must corroborate across several signals before it means anything.',
      ['liquidity sweep stop hunt', 'false breakout trap volume', 'expiry day trap gamma'],
      [marketTaskId],
    );

    // ---- emotion ---------------------------------------------------------
    const trades = request.recentTrades ?? [];
    if (trades.length > 0) {
      add(
        'emotion-intelligence',
        `Do the last ${trades.length} trades show behavioural patterns worth reflecting on?`,
        'Trade history is present, so behaviour can be read from what the trader actually did rather than inferred.',
        ['revenge trading behaviour', 'overtrading discipline', 'FOMO entry psychology'],
      );
    } else {
      skipped.push({
        agent: 'emotion-intelligence',
        reason:
          'No recent trades were supplied. Reporting "no behavioural risk" from an empty history would read as an all-clear rather than as missing data.',
      });
    }

    // ---- historical ------------------------------------------------------
    add(
      'historical-pattern-intelligence',
      `How has ${symbol} behaved after comparable structure in the past?`,
      'A base rate turns a present-tense observation into one with a measured precedent, or shows there is none.',
      ['historical base rate pattern reliability', 'sample size statistical significance trading'],
      [marketTaskId, subtasks[1].id],
    );

    // ---- learning --------------------------------------------------------
    add(
      'learning-intelligence',
      `What does the learned corpus say a trader should understand about this situation?`,
      'Turns the run into education: the concepts and passages that explain what is happening, always.',
      [
        understood.rawText || `${symbol} ${understood.timeframe} market structure`,
        ...understood.indicators.map((i) => `${i} interpretation`),
      ],
      [marketTaskId],
    );

    // ---- compliance ------------------------------------------------------
    add(
      'compliance-intelligence',
      'Does anything produced by this run breach the observation-only boundary?',
      'Runs last and unconditionally — every surfaced observation must be labelled and checked whatever was asked.',
      ['SEBI research analyst disclosure', 'investment advice boundary'],
      subtasks.map((s) => s.id),
    );

    return { subtasks, skipped };
  }
}

/**
 * Per-intent agent weights.
 *
 * These are the priors on how much each agent's verdict should count toward
 * the aggregate confidence for a given kind of question. They are multiplied
 * by each agent's own data quality at synthesis time, so a heavily-weighted
 * agent working from thin data still cannot dominate.
 */
const WEIGHTS_BY_INTENT: Record<string, Partial<Record<AgentId, number>>> = {
  'market-read': {
    'market-intelligence': 1.0,
    'strategy-intelligence': 0.8,
    'trap-intelligence': 0.7,
    'historical-pattern-intelligence': 0.6,
    'risk-intelligence': 0.6,
    'news-intelligence': 0.5,
    'options-chain-intelligence': 0.5,
    'emotion-intelligence': 0.3,
    'learning-intelligence': 0.4,
    'compliance-intelligence': 0.2,
  },
  'strategy-check': {
    'strategy-intelligence': 1.0,
    'market-intelligence': 0.85,
    'historical-pattern-intelligence': 0.75,
    'trap-intelligence': 0.7,
    'risk-intelligence': 0.5,
    'options-chain-intelligence': 0.45,
    'news-intelligence': 0.4,
    'emotion-intelligence': 0.3,
    'learning-intelligence': 0.5,
    'compliance-intelligence': 0.2,
  },
  'option-context': {
    'options-chain-intelligence': 1.0,
    'market-intelligence': 0.8,
    'trap-intelligence': 0.7,
    'risk-intelligence': 0.7,
    'strategy-intelligence': 0.6,
    'news-intelligence': 0.5,
    'historical-pattern-intelligence': 0.5,
    'emotion-intelligence': 0.3,
    'learning-intelligence': 0.4,
    'compliance-intelligence': 0.2,
  },
  'risk-review': {
    'risk-intelligence': 1.0,
    'trap-intelligence': 0.85,
    'market-intelligence': 0.7,
    'emotion-intelligence': 0.7,
    'options-chain-intelligence': 0.5,
    'news-intelligence': 0.5,
    'strategy-intelligence': 0.4,
    'historical-pattern-intelligence': 0.4,
    'learning-intelligence': 0.4,
    'compliance-intelligence': 0.2,
  },
  'behaviour-review': {
    'emotion-intelligence': 1.0,
    'risk-intelligence': 0.8,
    'trap-intelligence': 0.6,
    'learning-intelligence': 0.6,
    'market-intelligence': 0.5,
    'historical-pattern-intelligence': 0.4,
    'strategy-intelligence': 0.3,
    'news-intelligence': 0.2,
    'options-chain-intelligence': 0.2,
    'compliance-intelligence': 0.2,
  },
  'visual-workspace': {
    'market-intelligence': 1.0,
    'strategy-intelligence': 0.9,
    'trap-intelligence': 0.6,
    'options-chain-intelligence': 0.6,
    'historical-pattern-intelligence': 0.5,
    'risk-intelligence': 0.5,
    'learning-intelligence': 0.5,
    'news-intelligence': 0.4,
    'emotion-intelligence': 0.2,
    'compliance-intelligence': 0.2,
  },
  explain: {
    'learning-intelligence': 1.0,
    'market-intelligence': 0.7,
    'strategy-intelligence': 0.7,
    'historical-pattern-intelligence': 0.6,
    'trap-intelligence': 0.5,
    'risk-intelligence': 0.5,
    'news-intelligence': 0.3,
    'options-chain-intelligence': 0.3,
    'emotion-intelligence': 0.3,
    'compliance-intelligence': 0.2,
  },
  unknown: {
    'market-intelligence': 1.0,
    'strategy-intelligence': 0.7,
    'trap-intelligence': 0.6,
    'risk-intelligence': 0.6,
    'news-intelligence': 0.5,
    'options-chain-intelligence': 0.5,
    'historical-pattern-intelligence': 0.5,
    'learning-intelligence': 0.5,
    'emotion-intelligence': 0.3,
    'compliance-intelligence': 0.2,
  },
};
