import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SI_CONFIG, SentinelIntelligenceConfig } from '../si.config';
import { KnowledgeIndexService, termFrequencies, tokenize } from '../knowledge/knowledge-index.service';
import { evaluateCondition, type ChartContext, type ConditionResult } from './chart-context';
import { describeCondition, validateSpec, type SpecValidationIssue, type TradingViewStrategySpec } from './drawing-spec';

export interface RuleMatch {
  spec: TradingViewStrategySpec;
  /** True when every condition held and no invalidation fired. */
  matched: boolean;
  conditions: ConditionResult[];
  invalidations: ConditionResult[];
  /** 0..1 — share of conditions met, zeroed by any invalidation. */
  score: number;
  /** Conditions met, restated with live numbers. */
  metNotes: string[];
  /** Conditions not met, restated with live numbers. */
  unmetNotes: string[];
}

export interface LearnResult {
  spec: TradingViewStrategySpec | null;
  issues: SpecValidationIssue[];
  /** True when the spec replaced an existing one with the same id. */
  replaced: boolean;
  /** Chunks written into the corpus so the rule becomes citable. */
  chunksIndexed: number;
}

/**
 * Learns, stores and replays user-supplied TradingView strategy specifications.
 *
 * Two things happen when a strategy is learned, and both matter:
 *
 * 1. **It becomes executable.** The spec's conditions are evaluated against
 *    live chart context, so the same structure is recognised on future charts
 *    and the same drawings are reproduced — with the live numbers that made
 *    each condition true.
 *
 * 2. **It becomes citable.** The spec is chunked into the corpus at the
 *    `user-rule` tier, which outranks published books in
 *    `SOURCE_AUTHORITY`. That ordering is deliberate: for this trader, their
 *    own stated method is more authoritative than a general text, and an
 *    annotation placed by their rule should cite their rule.
 *
 * Specs are data, never code — see `drawing-spec.ts`. A malformed spec fails
 * validation with a field-level issue list; it can never inject logic into the
 * drawing path.
 */
@Injectable()
export class TradingViewRuleService implements OnModuleInit {
  private readonly logger = new Logger(TradingViewRuleService.name);
  private specs = new Map<string, TradingViewStrategySpec>();

  constructor(
    @Inject(SI_CONFIG) private readonly config: SentinelIntelligenceConfig,
    private readonly index: KnowledgeIndexService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  /**
   * Learn a strategy from a structured spec.
   *
   * Re-learning an existing id bumps its version rather than creating a
   * duplicate — a trader refining their rules is editing one strategy, not
   * accumulating near-identical copies that would then all fire at once.
   */
  async learn(raw: unknown): Promise<LearnResult> {
    const { spec, issues } = validateSpec(raw);
    if (!spec) return { spec: null, issues, replaced: false, chunksIndexed: 0 };

    const existing = this.specs.get(spec.id);
    if (existing) {
      spec.version = existing.version + 1;
      spec.learnedAt = existing.learnedAt;
    }

    this.specs.set(spec.id, spec);
    const chunksIndexed = this.indexSpec(spec);
    await this.persist();

    this.logger.log(
      `learned TradingView strategy "${spec.name}" (${spec.id} v${spec.version}): ` +
        `${spec.conditions.length} condition(s), ${spec.drawings.length} drawing(s), ${chunksIndexed} chunk(s) indexed`,
    );
    return { spec, issues: [], replaced: Boolean(existing), chunksIndexed };
  }

  list(): TradingViewStrategySpec[] {
    return [...this.specs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): TradingViewStrategySpec | null {
    return this.specs.get(id) ?? null;
  }

  /**
   * Remove a learned strategy from the active set.
   *
   * The spec file is rewritten without it, but nothing is deleted from disk
   * beyond that (CLAUDE.md Rule 1) — the strategy is archived into the
   * `retired` list so it stays recoverable and its past annotations remain
   * explicable.
   */
  async retire(id: string): Promise<boolean> {
    const spec = this.specs.get(id);
    if (!spec) return false;
    this.specs.delete(id);
    this.index.removeDocument(specSourceId(spec.id));
    await this.persist([spec]);
    return true;
  }

  /**
   * Evaluate every applicable learned strategy against live chart context.
   *
   * Applicability is filtered on symbol and timeframe first: a strategy the
   * author scoped to BANKNIFTY 5m must not fire on a NIFTY daily chart just
   * because its conditions happen to hold there.
   */
  evaluate(context: ChartContext, symbol: string, timeframe: string): RuleMatch[] {
    const applicable = [...this.specs.values()].filter(
      (spec) =>
        (spec.symbols.length === 0 || spec.symbols.includes(symbol.toUpperCase())) &&
        (spec.timeframes.length === 0 || spec.timeframes.includes(timeframe)),
    );

    return applicable
      .map((spec) => {
        const conditions = spec.conditions.map((c) => evaluateCondition(c, context));
        const invalidations = spec.invalidations.map((c) => evaluateCondition(c, context));
        const metCount = conditions.filter((c) => c.met).length;
        const invalidated = invalidations.some((i) => i.met);

        return {
          spec,
          matched: metCount === conditions.length && conditions.length > 0 && !invalidated,
          conditions,
          invalidations,
          // An invalidated setup scores zero, not "mostly there" — the whole
          // point of an invalidation is that it overrides partial confirmation.
          score: invalidated ? 0 : conditions.length > 0 ? metCount / conditions.length : 0,
          metNotes: conditions.filter((c) => c.met).map((c) => c.note),
          unmetNotes: conditions.filter((c) => !c.met).map((c) => c.note),
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Chunk a spec into the corpus so it can be cited.
   *
   * Written as prose rather than JSON: the retrieval index is lexical, and
   * `{"kind":"compare","op":">"}` tokenizes into nothing a trader would ever
   * search for. The English restatement produced by `describeCondition` is
   * what makes the rule findable — and it is the same text shown on the
   * annotation, so the citation and the explanation cannot drift apart.
   */
  private indexSpec(spec: TradingViewStrategySpec): number {
    const sourceId = specSourceId(spec.id);
    const sourcePath = `learned-rules/${spec.id}.json`;

    const sections: { title: string; body: string }[] = [
      {
        title: `${spec.name} — description`,
        body: [
          spec.description,
          spec.symbols.length > 0 ? `Applies to ${spec.symbols.join(', ')}.` : 'Applies to all instruments.',
          spec.timeframes.length > 0 ? `Timeframes: ${spec.timeframes.join(', ')}.` : '',
          `Directional bias: ${spec.bias}.`,
        ]
          .filter(Boolean)
          .join(' '),
      },
      {
        title: `${spec.name} — entry conditions`,
        body: `The setup is considered confirmed when ${spec.conditions.map(describeCondition).join(', and ')}.`,
      },
      ...(spec.invalidations.length > 0
        ? [{
            title: `${spec.name} — invalidations`,
            body: `The setup is invalidated when ${spec.invalidations.map(describeCondition).join(', or ')}.`,
          }]
        : []),
      {
        title: `${spec.name} — drawings`,
        body: spec.drawings
          .map((d) => `${d.label} (${d.kind}, anchored to ${d.anchor.replace(/-/g, ' ')}): ${d.rationale}`)
          .join(' '),
      },
      ...(spec.rawSpec.trim().length > 0 && !spec.rawSpec.trim().startsWith('{')
        ? [{ title: `${spec.name} — author's notes`, body: spec.rawSpec }]
        : []),
    ];

    let offset = 0;
    const chunks = sections
      .filter((s) => s.body.trim().length > 0)
      .map((section, i) => {
        const text = `${section.title}\n${section.body}`.trim();
        const tokens = tokenize(text);
        const chunk = {
          chunkId: `${sourceId}:${i}`,
          sourceId,
          sourceTitle: spec.name,
          sourcePath,
          sourceKind: 'user-rule' as const,
          index: i,
          charStart: offset,
          charEnd: offset + text.length,
          section: section.title,
          page: null,
          text,
          termFreq: termFrequencies(tokens),
          length: tokens.length,
        };
        offset += text.length + 1;
        return chunk;
      });

    this.index.upsertDocument(sourceId, chunks);
    return chunks.length;
  }

  // ------------------------------------------------------------- persistence

  private async persist(newlyRetired: TradingViewStrategySpec[] = []): Promise<void> {
    try {
      const existing = await this.readFile();
      const retired = [...(existing?.retired ?? []), ...newlyRetired];
      await mkdir(dirname(this.config.rulesFile), { recursive: true });
      await writeFile(
        this.config.rulesFile,
        JSON.stringify({ version: 1, specs: [...this.specs.values()], retired }, null, 2),
        'utf8',
      );
    } catch (err) {
      // A persistence failure must not lose the in-memory rule — the trader
      // just taught it to the system and it works for this session.
      this.logger.warn(`could not persist learned rules (non-fatal, rules remain in memory): ${(err as Error).message}`);
    }
  }

  private async load(): Promise<void> {
    const file = await this.readFile();
    if (!file) return;
    for (const raw of file.specs ?? []) {
      const { spec } = validateSpec(raw);
      if (!spec) {
        this.logger.warn(`skipping a persisted rule that no longer validates: ${(raw as { id?: string })?.id ?? '(no id)'}`);
        continue;
      }
      this.specs.set(spec.id, spec);
      this.indexSpec(spec);
    }
    if (this.specs.size > 0) {
      this.logger.log(`restored ${this.specs.size} learned TradingView strateg${this.specs.size === 1 ? 'y' : 'ies'}`);
    }
  }

  private async readFile(): Promise<{ specs: unknown[]; retired: TradingViewStrategySpec[] } | null> {
    if (!existsSync(this.config.rulesFile)) return null;
    try {
      return JSON.parse(await readFile(this.config.rulesFile, 'utf8'));
    } catch (err) {
      this.logger.warn(`learned-rules file is unreadable, starting empty: ${(err as Error).message}`);
      return null;
    }
  }
}

/** Deterministic corpus source id for a learned rule. */
export function specSourceId(specId: string): string {
  return `userrule-${createHash('sha256').update(specId).digest('hex').slice(0, 24)}`;
}
