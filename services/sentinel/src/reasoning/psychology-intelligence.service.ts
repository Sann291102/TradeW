import { Injectable } from '@nestjs/common';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { RankedKnowledge } from './types';

interface PsychologyCue {
  key: string;
  label: string;
  patterns: RegExp[];
}

/**
 * Vocabulary of behavioural cues Sentinel can recognise from a short
 * description of user action or market context. Each cue maps to one or
 * more `trading-psychology` concepts in the Brain/ontology. Deliberately
 * conservative — a false positive would attach the wrong educational
 * framing to a benign moment; better to detect fewer, correctly.
 */
const CUES: PsychologyCue[] = [
  { key: 'fear', label: 'Fear', patterns: [/\bafraid\b/i, /\bpanic(ked|king)?\b/i, /\banxious\b/i, /\bnervous\b/i, /\bworri(ed|es|ing)\b/i, /\bfear\b/i] },
  { key: 'greed', label: 'Greed', patterns: [/\bgreedy?\b/i, /\bhoping\s+for\s+more\b/i, /\brefused\s+to\s+book\b/i, /\bhold\s+for\s+more\b/i] },
  { key: 'fomo', label: 'FOMO', patterns: [/\bfomo\b/i, /\bmissing\s+out\b/i, /\bchasing\b/i, /\bafraid\s+to\s+miss\b/i, /\bran(?:g)?\s+in\b/i] },
  { key: 'revenge-trading', label: 'Revenge trading', patterns: [/\brevenge\b/i, /\bmake\s+it\s+back\b/i, /\bget\s+even\b/i, /\brecoup\s+the\s+loss\b/i, /\bgot\s+back\s+in\s+quick\b/i] },
  { key: 'overconfidence', label: 'Overconfidence', patterns: [/\bcan(?:'|no)t\s+lose\b/i, /\beasy\s+money\b/i, /\bsure\s+thing\b/i, /\bover(?:sized|leveraged)\b/i, /\bcertain\b/i] },
  { key: 'loss-aversion', label: 'Loss aversion', patterns: [/\bcan(?:'|no)t\s+cut\b/i, /\bhoping\s+it\s+comes?\s+back\b/i, /\brefused\s+to\s+take\s+the\s+loss\b/i, /\bmoved\s+the\s+stop\b/i, /\bwiden(?:ed|ing)?\s+the\s+stop\b/i] },
  { key: 'confirmation-bias', label: 'Confirmation bias', patterns: [/\bignor(?:ed|ing)\s+.*(signal|evidence)\b/i, /\bcherry[- ]?pick/i, /\bonly\s+look(?:ed|ing)\s+for\b/i] },
  { key: 'impatience', label: 'Impatience', patterns: [/\bcouldn(?:'|no)t\s+wait\b/i, /\bjumped?\s+in\s+early\b/i, /\bimpatien(t|ce)\b/i, /\brushed\b/i] },
  { key: 'overtrading', label: 'Overtrading', patterns: [/\bovertrad/i, /\btoo\s+many\s+(trades|positions|entries)\b/i, /\btraded\s+all\s+day\b/i] },
  { key: 'discipline', label: 'Discipline', patterns: [/\bstuck\s+to\s+the\s+plan\b/i, /\bfollow(?:ed)?\s+the\s+rules\b/i, /\bwaited\s+for\s+the\s+setup\b/i, /\bdisciplin/i] },
  { key: 'patience', label: 'Patience', patterns: [/\bwaited\s+patiently\b/i, /\bpatience\b/i, /\bheld\s+off\b/i] },
];

export interface PsychologyDetection {
  cue: string;
  label: string;
  evidence: string[];
}

/**
 * Psychology Intelligence — surfaces which of the vault's psychology
 * concepts are relevant to a given piece of user or market context, and
 * pulls the ranked Brain memories that explain them.
 *
 * Two-stage design:
 *   1. deterministic cue detection over the text (regex, no LLM)
 *   2. for each detected cue, fetch the top-K ranked concept memories
 *
 * The detector is intentionally text-only so this service is safe to call
 * with any string — a journal snippet, an orchestrator note, or a
 * ContextBuilder synthesis — without contaminating the ranking with
 * unstructured context.
 *
 * Never diagnoses. The output is always "these patterns are relevant to
 * discuss," not "you have this bias."
 */
@Injectable()
export class PsychologyIntelligenceService {
  constructor(private readonly retrieval: KnowledgeRetrievalService) {}

  detect(text: string): PsychologyDetection[] {
    if (!text) return [];
    const detections: PsychologyDetection[] = [];
    for (const cue of CUES) {
      const evidence: string[] = [];
      for (const p of cue.patterns) {
        const m = p.exec(text);
        if (m) evidence.push(m[0]);
      }
      if (evidence.length > 0) detections.push({ cue: cue.key, label: cue.label, evidence });
    }
    return detections;
  }

  async knowledgeFor(cues: string[], opts: { limit?: number } = {}): Promise<RankedKnowledge[]> {
    if (cues.length === 0) return [];
    // Compose a semantic query from the cue labels so the retriever can
    // still match related concepts even when the exact concept id doesn't
    // exist yet in the Brain.
    const query = cues.map((c) => c.replace(/-/g, ' ')).join(' ');
    const boostTags = ['domain:trading-psychology', ...cues.map((c) => `concept:${c}`)];
    const result = await this.retrieval.retrieve({
      query: `trading psychology: ${query}`,
      hints: { boostTags },
      limit: opts.limit ?? 6,
    });
    return result.items;
  }

  /**
   * Convenience: run the detector on `text` and immediately fetch the
   * matching knowledge in one call.
   */
  async detectAndFetch(text: string, opts: { limit?: number } = {}): Promise<{
    detections: PsychologyDetection[];
    knowledge: RankedKnowledge[];
  }> {
    const detections = this.detect(text);
    const knowledge = detections.length === 0 ? [] : await this.knowledgeFor(detections.map((d) => d.cue), opts);
    return { detections, knowledge };
  }
}
