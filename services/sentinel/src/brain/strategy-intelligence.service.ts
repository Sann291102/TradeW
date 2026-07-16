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
    try {
      const rows = await this.prisma.memoryRecord.findMany({
        where: { tags: { has: 'pattern_occurrence' }, namespace: 'sentinel' },
        select: { metadata: true },
      });
      const distribution: Record<string, number> = {};
      let sample = 0;
      for (const row of rows) {
        const meta = row.metadata as { pattern?: string; outcome?: string | null } | null;
        if (!meta || meta.pattern !== patternName || !meta.outcome) continue;
        sample++;
        distribution[meta.outcome] = (distribution[meta.outcome] ?? 0) + 1;
      }
      return { pattern: patternName, sample, distribution, reliable: sample >= MIN_SAMPLE };
    } catch (err) {
      this.logger.warn(`base rate lookup failed for ${patternName}: ${err}`);
      return { pattern: patternName, sample: 0, distribution: {}, reliable: false };
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
