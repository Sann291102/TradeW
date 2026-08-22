import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface BaseRateResult {
  pattern: string;
  sample: number;
  distribution: Record<string, number>;
  reliable: boolean;
}

const MIN_SAMPLE = 8;

/**
 * ⚠️ NAME COLLISION: this is the **Brain**, not the agent.
 *
 * `StrategyIntelligenceAgent`
 * (`../sentinel-intelligence/agents/strategy-intelligence.agent.ts`) is an
 * unrelated component that reads `context.detections` and reports whether a
 * named setup is confirming right now. This service owns outcome-tagged base
 * rates, reads Postgres, and says nothing about the present. The two are
 * injected in the same file more than once; check which one you want.
 *
 * Rule of thumb across the whole boundary: a `…Service` computes, a `…Agent`
 * reads what was computed and forms a verdict. See
 * `docs/product-architecture/AGENT-LAYERS.md` §3 for the full table.
 *
 * Strategy Intelligence Framework — cross-symbol base rates for a pattern
 * type, computed from Continuous Learning's outcome-tagged occurrences.
 * Historical frequency reporting only ("across N past occurrences of this
 * pattern, here's the outcome distribution") — never a directional call
 * on the current instance, and explicitly withheld below a sample-size
 * floor to avoid manufacturing false precision from a handful of events.
 */
@Injectable()
export class StrategyIntelligenceService {
  private readonly logger = new Logger(StrategyIntelligenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async baseRateFor(patternName: string): Promise<BaseRateResult> {
    const [result] = await this.baseRatesFor([patternName]);
    return result;
  }

  /**
   * Base rates for several patterns in ONE pass over the occurrence store.
   *
   * `baseRateFor` scans every `pattern_occurrence` row and discards all but one
   * pattern's, so resolving N patterns the obvious way costs N full scans of
   * the same table for N-1 wasted reads each. A run that wants a base rate per
   * live detection wants exactly that, and doing it per-pattern would have made
   * a shared read into a per-agent one — the thing `AgentContext` exists to
   * prevent.
   *
   * Every requested pattern comes back, including ones with no occurrences at
   * all. A caller must not have to distinguish "absent from the result" from
   * "zero occurrences"; those are the same fact and it should be stated once.
   *
   * A failure degrades every requested pattern to "no live record" rather than
   * throwing. Failing closed is the correct direction here: a database outage
   * must not be the reason an unvalidated setup reads as proven.
   */
  async baseRatesFor(patternNames: string[]): Promise<BaseRateResult[]> {
    const wanted = [...new Set(patternNames)];
    const empty = (pattern: string): BaseRateResult => ({
      pattern,
      sample: 0,
      distribution: {},
      reliable: false,
    });
    if (wanted.length === 0) return [];

    try {
      const rows = await this.prisma.memoryRecord.findMany({
        where: { tags: { has: 'pattern_occurrence' }, namespace: 'sentinel' },
        select: { metadata: true },
      });

      const byPattern = new Map<string, BaseRateResult>(wanted.map((p) => [p, empty(p)]));
      for (const row of rows) {
        const meta = row.metadata as { pattern?: string; outcome?: string | null } | null;
        if (!meta?.pattern || !meta.outcome) continue;
        const result = byPattern.get(meta.pattern);
        // Not a pattern this call asked about — skip rather than accumulate,
        // so the single scan stays bounded by the request, not by the table.
        if (!result) continue;
        result.sample++;
        result.distribution[meta.outcome] = (result.distribution[meta.outcome] ?? 0) + 1;
      }

      for (const result of byPattern.values()) result.reliable = result.sample >= MIN_SAMPLE;
      return wanted.map((p) => byPattern.get(p)!);
    } catch (err) {
      this.logger.warn(`base rate lookup failed for ${wanted.join(', ')}: ${err}`);
      return wanted.map(empty);
    }
  }

  describe(result: BaseRateResult): string {
    const label = result.pattern.replace(/_/g, ' ');
    if (result.sample === 0) return `No outcome-tagged occurrences of ${label} in Sentinel's memory yet.`;
    if (!result.reliable) {
      return `${result.sample} outcome-tagged occurrence(s) of ${label} so far — too few to report a reliable base rate (need ${MIN_SAMPLE}+).`;
    }
    const total = Object.values(result.distribution).reduce((a, b) => a + b, 0);
    const parts = Object.entries(result.distribution)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k.replace(/_/g, ' ')} ${Math.round((v / total) * 100)}%`);
    return `Across ${total} historical occurrences of ${label} (all symbols): ${parts.join(', ')}. Historical base rate, not a prediction for any specific setup.`;
  }
}
