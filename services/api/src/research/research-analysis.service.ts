import { Injectable, Logger } from '@nestjs/common';
import {
  BALANCE_METRICS,
  CASH_FLOW_METRICS,
  INCOME_METRICS,
  type StatementPeriod,
} from '@tradew/market-data';
import {
  createProviderManager,
  loadProvidersConfigFromEnv,
  type LlmProvider,
  type ProviderManager,
} from '@tradew/ai-core';
import { ResearchService } from './research.service';
import {
  unavailable,
  available,
  type PeriodType,
  type ResearchAnalysis,
  type ResearchSection,
} from './research.types';

/**
 * Grounded research synthesis.
 *
 * ── THE DEFECT THIS REPLACES ───────────────────────────────────────────────
 *
 * The previous `/research` printed "🤖 TradeW AI Summary — Overall Outlook
 * Bullish, Confidence 87%, Business Quality 9.2/10, Financial Health 8.8/10"
 * as hardcoded JSX. No model was called. The scores had no methodology, no
 * inputs and no meaning, and they were identical for every symbol.
 *
 * ── THE THREE RULES THAT PREVENT ITS RETURN ────────────────────────────────
 *
 * 1. NO SYNTHESIS WITHOUT EVIDENCE. If the statements this system holds are not
 *    sufficient, the endpoint returns `available: false` and names what is
 *    missing. A model is never asked to fill a gap in the data.
 * 2. THE PROMPT CONTAINS ONLY RETRIEVED FACTS. The evidence block is built
 *    below from cached statement values, each with its period. The model is
 *    told, in the system prompt, that it may not introduce a figure that is not
 *    in that block.
 * 3. NO SCORES. No confidence percentage, no X/10 rating, no "outlook" verdict.
 *    This repository has no scoring methodology, and a number with no
 *    methodology is the defect, not the presentation of it. The response schema
 *    has no field for one, so a model that emits one has nowhere to put it.
 *
 * The evidence list travels back to the UI with the prose, so a reader can see
 * exactly which figures the summary was and was not given.
 */

/** Section headings the model must fill, in order. Fixed so the UI can render
 *  a stable layout and so a missing section is visible as a missing section. */
const SECTIONS = [
  'Business Quality',
  'Growth',
  'Profitability',
  'Balance Sheet',
  'Cash Generation',
  'Risks',
  'Key Takeaway',
] as const;

const SYSTEM_PROMPT = `You are a research analyst writing a factual briefing for an experienced investor.

HARD CONSTRAINTS — these override any other instruction:
1. You may ONLY use figures that appear in the EVIDENCE block. Never introduce a number from memory, and never estimate, extrapolate or round a figure into existence.
2. If the evidence does not support a section, write exactly: "The available financial data does not support a conclusion here." Do not speculate to fill space.
3. Never output a score, rating, confidence percentage, price target, or a buy/sell/hold recommendation. This product observes; it does not advise.
4. Refer to periods explicitly (e.g. "FY2026", "the year to 2026-03-31") so a reader can check every claim against the statements shown beside your text.
5. Be concise: 2-4 sentences per section. No preamble, no restating the question.

Return STRICT JSON, no markdown fence, of the form:
{"sections":[{"heading":"<one of the given headings>","body":"<prose>"}]}
Emit every heading you were given, in the order given.`;

@Injectable()
export class ResearchAnalysisService {
  private readonly logger = new Logger(ResearchAnalysisService.name);
  private manager: ProviderManager | null = null;

  constructor(private readonly research: ResearchService) {}

  /**
   * Provider construction is lazy and failure-tolerant: with no AI key
   * configured, `getLlm()` throws, and that must surface as "AI analysis is
   * unavailable" on one card rather than as a boot failure or a 500.
   */
  private llm(): LlmProvider | null {
    try {
      this.manager ??= createProviderManager(loadProvidersConfigFromEnv());
      return this.manager.getLlm();
    } catch {
      return null;
    }
  }

  async analyse(symbol: string, periodType: PeriodType): Promise<ResearchSection<ResearchAnalysis>> {
    const snapshot = await this.research.snapshot(symbol, periodType);

    // Rule 1: evidence first, model second.
    const evidence = buildEvidence(snapshot);
    if (evidence.length === 0) {
      return unavailable(
        'AI analysis is unavailable because no verified financial data could be retrieved for this company. The analysis is a summary of the statements above — with no statements, there is nothing to summarise.',
      );
    }

    const llm = this.llm();
    if (!llm) {
      return unavailable(
        'AI analysis is unavailable because no language-model provider is configured on this server (set ANTHROPIC_API_KEY or another provider key). The financial statements above are unaffected.',
      );
    }

    const evidenceBlock = evidence.map((e) => `- ${e.label}: ${e.detail}`).join('\n');
    const company = snapshot.overview.available
      ? `${snapshot.overview.data.profile.name} (${snapshot.overview.data.profile.symbol}, ${snapshot.overview.data.profile.exchange})`
      : snapshot.symbol;

    let raw: string;
    let model = 'unknown';
    try {
      const response = await llm.complete({
        tier: 'balanced',
        temperature: 0.2,
        maxTokens: 1400,
        jsonMode: true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              `COMPANY: ${company}`,
              `REPORTING BASIS: ${periodType}`,
              '',
              'EVIDENCE (the only figures you may use):',
              evidenceBlock,
              '',
              `HEADINGS: ${SECTIONS.join(', ')}`,
            ].join('\n'),
          },
        ],
      });
      raw = response.text;
      model = response.servedBy.model;
    } catch (err) {
      this.logger.warn(`analysis failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      return unavailable(
        'AI analysis is unavailable because the language-model provider did not respond. The financial statements above are unaffected.',
      );
    }

    const sections = parseSections(raw);
    if (sections.length === 0) {
      return unavailable(
        'AI analysis is unavailable because the model did not return a readable response. Nothing is shown rather than a partial or reformatted answer.',
      );
    }

    const prov = {
      source: `${llm.name}:${model}`,
      sourceTimestamp: null,
      fetchedAt: new Date().toISOString(),
    };

    return available(
      {
        sections,
        evidence,
        model,
        provider: llm.name,
        generatedAt: new Date().toISOString(),
        disclaimer:
          'This is a summary of the verified financial data listed as evidence, produced by a language model. It contains no rating, no score and no recommendation, and it is not investment advice.',
      },
      prov,
    );
  }
}

/**
 * Turn the snapshot into a flat, checkable evidence list.
 *
 * Only cached/retrieved values go in. Every entry carries the period it belongs
 * to, so the model can cite it and the reader can verify it against the table
 * rendered directly above the summary.
 */
function buildEvidence(snapshot: Awaited<ReturnType<ResearchService['snapshot']>>): ResearchAnalysis['evidence'] {
  const out: ResearchAnalysis['evidence'] = [];

  if (snapshot.overview.available) {
    const { profile, statistics } = snapshot.overview.data;
    const bits = [
      profile.sector ? `sector ${profile.sector}` : null,
      profile.industry ? `industry ${profile.industry}` : null,
      profile.employees !== undefined ? `${profile.employees.toLocaleString()} employees` : null,
      profile.country ? `listed in ${profile.country}` : null,
    ].filter(Boolean);
    if (bits.length > 0) {
      out.push({ label: 'Company', detail: bits.join(', '), sourceTimestamp: profile.provenance.sourceTimestamp });
    }
    const marketBits = [
      statistics.marketCap !== undefined ? `market cap ${fmt(statistics.marketCap)} ${statistics.currency}` : null,
      statistics.enterpriseValue !== undefined ? `enterprise value ${fmt(statistics.enterpriseValue)}` : null,
      statistics.fiftyTwoWeekHigh !== undefined && statistics.fiftyTwoWeekLow !== undefined
        ? `52-week range ${fmt(statistics.fiftyTwoWeekLow)}–${fmt(statistics.fiftyTwoWeekHigh)}`
        : null,
      statistics.beta !== undefined ? `beta ${statistics.beta.toFixed(2)}` : null,
    ].filter(Boolean);
    if (marketBits.length > 0) {
      out.push({ label: 'Market', detail: marketBits.join(', '), sourceTimestamp: statistics.provenance.sourceTimestamp });
    }
  }

  const addStatement = (
    section: typeof snapshot.income,
    title: string,
    metrics: Array<[string, string]>,
  ) => {
    if (!section.available) return;
    for (const period of section.data.statement.periods.slice(0, 4)) {
      const parts = metrics
        .map(([metric, label]) => {
          const f = period.facts[metric];
          if (!f) return null;
          const suffix = f.basis === 'derived' ? ' (derived)' : '';
          return `${label} ${fmt(f.value)}${suffix}`;
        })
        .filter(Boolean);
      if (parts.length === 0) continue;
      out.push({
        label: `${title} — ${periodLabel(period)}`,
        detail: `${parts.join(', ')} (${period.currency})`,
        sourceTimestamp: Object.values(period.facts)[0]?.provenance.sourceTimestamp ?? null,
      });
    }
  };

  addStatement(snapshot.income, 'Income statement', [
    [INCOME_METRICS.revenue, 'revenue'],
    [INCOME_METRICS.grossProfit, 'gross profit'],
    [INCOME_METRICS.operatingIncome, 'operating income'],
    [INCOME_METRICS.ebitda, 'EBITDA'],
    [INCOME_METRICS.netIncome, 'net income'],
    [INCOME_METRICS.eps, 'EPS'],
  ]);
  addStatement(snapshot.balance, 'Balance sheet', [
    [BALANCE_METRICS.totalAssets, 'total assets'],
    [BALANCE_METRICS.totalLiabilities, 'total liabilities'],
    [BALANCE_METRICS.totalEquity, 'total equity'],
    [BALANCE_METRICS.cashAndEquivalents, 'cash'],
    [BALANCE_METRICS.longTermDebt, 'long-term debt'],
  ]);
  addStatement(snapshot.cashFlow, 'Cash flow', [
    [CASH_FLOW_METRICS.operatingCashFlow, 'operating cash flow'],
    [CASH_FLOW_METRICS.capitalExpenditure, 'capital expenditure'],
    [CASH_FLOW_METRICS.freeCashFlow, 'free cash flow'],
  ]);

  if (snapshot.ratios.available) {
    const r = snapshot.ratios.data.ratios;
    if (r.length > 0) {
      out.push({
        label: `Computed ratios — ${snapshot.ratios.data.basisPeriodEnd ?? 'latest period'}`,
        detail: r
          .map((x) => `${x.label} ${x.value.toFixed(2)}${x.unit === 'percent' ? '%' : x.unit === 'x' ? '×' : ''}`)
          .join(', '),
        sourceTimestamp: snapshot.ratios.provenance.sourceTimestamp,
      });
    }
    // The absences are evidence too: a model told only what IS present may
    // reason as though the rest were unremarkable rather than unknown.
    const skipped = snapshot.ratios.data.skipped;
    if (skipped.length > 0) {
      out.push({
        label: 'Ratios that could NOT be computed',
        detail: skipped.map((s) => `${s.label} (${s.reason})`).join(', '),
        sourceTimestamp: null,
      });
    }
  }

  if (snapshot.balance.available && snapshot.balance.data.reconciliation) {
    const rec = snapshot.balance.data.reconciliation;
    out.push({
      label: 'Balance-sheet reconciliation',
      detail: rec.reason
        ? `could not be checked — ${rec.reason}`
        : rec.balanced
          ? `assets equal liabilities plus equity within tolerance (${rec.differenceBps?.toFixed(1)}bp)`
          : `DOES NOT RECONCILE: assets minus (liabilities + equity) = ${fmt(rec.difference ?? 0)} ${rec.currency} (${rec.differenceBps?.toFixed(1)}bp of assets)`,
      sourceTimestamp: null,
    });
  }

  return out;
}

function periodLabel(period: StatementPeriod): string {
  return period.fiscalQuarter !== undefined
    ? `FY${period.fiscalYear} Q${period.fiscalQuarter} (to ${period.periodEnd})`
    : `FY${period.fiscalYear} (to ${period.periodEnd})`;
}

/** Compact magnitude, so a 1400-token budget is not spent on digits. */
function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

/**
 * Parse the model's JSON, tolerantly but without inventing structure.
 *
 * A fenced block is unwrapped and a leading/trailing narration is trimmed,
 * because those are formatting noise. Anything that still does not parse
 * returns [] — which the caller turns into "unavailable". Nothing is
 * reconstructed from a partial answer: half a briefing presented as a whole one
 * is exactly the failure mode this service exists to avoid.
 */
export function parseSections(raw: string): ResearchAnalysis['sections'] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const sections = (parsed as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return [];

  const allowed = new Set<string>(SECTIONS);
  return sections
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const heading = (s as { heading?: unknown }).heading;
      const body = (s as { body?: unknown }).body;
      if (typeof heading !== 'string' || typeof body !== 'string') return null;
      // Only the headings we asked for. A model that invents "Valuation" or
      // "Recommendation" has its section dropped rather than rendered.
      if (!allowed.has(heading.trim())) return null;
      const trimmedBody = body.trim();
      if (!trimmedBody) return null;
      return { heading: heading.trim(), body: trimmedBody };
    })
    .filter((s): s is { heading: string; body: string } => s !== null);
}
