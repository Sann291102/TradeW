import { Injectable } from '@nestjs/common';
import { Chunk, ExtractedConcept, RelationshipProposal } from './types';

interface CuePattern {
  regex: RegExp;
  relation: string;
  confidence: number;
}

/**
 * Cue phrases that suggest a specific relation type between two co-occurring
 * concepts. The vocabulary is the same 13 relation types the Brain's concept
 * graph uses. Confidence is deliberately below 1 — every proposal is
 * suggested, never asserted.
 */
const CUE_PATTERNS: CuePattern[] = [
  { regex: /\b(?:causes?|leads?\s+to|results?\s+in|produces?)\b/i, relation: 'causes', confidence: 0.75 },
  { regex: /\b(?:precedes?|typically\s+followed\s+by|usually\s+comes\s+before)\b/i, relation: 'precedes', confidence: 0.7 },
  { regex: /\b(?:confirms?|corroborat(?:es|ing))\b/i, relation: 'confirms', confidence: 0.72 },
  { regex: /\b(?:contradicts?|conflicts?\s+with)\b/i, relation: 'contradicts', confidence: 0.72 },
  { regex: /\b(?:invalidates?|negates?|cancels?)\b/i, relation: 'invalidates', confidence: 0.75 },
  { regex: /\b(?:depends?\s+on|requires?|needs?)\b/i, relation: 'depends_on', confidence: 0.7 },
  { regex: /\b(?:similar\s+to|analogous\s+to|resembles?)\b/i, relation: 'similar_to', confidence: 0.6 },
  { regex: /\b(?:measured\s+by|quantifi(?:es|ed)\s+by)\b/i, relation: 'measured_by', confidence: 0.72 },
  { regex: /\b(?:mitigates?|reduces?\s+the\s+impact|hedges?)\b/i, relation: 'mitigates', confidence: 0.7 },
  { regex: /\b(?:amplifies?|magnifies?|reinforces?)\b/i, relation: 'amplifies', confidence: 0.68 },
  { regex: /\b(?:is\s+a\s+kind\s+of|is\s+a\s+type\s+of|is\s+an?\s+example\s+of)\b/i, relation: 'is_a', confidence: 0.7 },
  { regex: /\b(?:is\s+part\s+of|belongs?\s+to|contains?)\b/i, relation: 'part_of', confidence: 0.65 },
];

/**
 * Relationship Extraction Service — proposes concept-to-concept relations
 * based on co-occurrence within a chunk plus in-sentence cue-phrase evidence.
 *
 * Every output is a *proposal*: reviewers see them, but nothing is written
 * to the concept graph without a human promotion step. This mirrors the
 * repository's standing rule that new relations require review, not runtime
 * autoedits. Co-occurrence-only pairs receive the lowest confidence and are
 * emitted with the neutral `co_occurs_with` relation (the same edge the
 * Brain's ConceptLearningEngine already writes structurally).
 */
@Injectable()
export class RelationshipExtractionService {
  extract(chunk: Chunk, concepts: ExtractedConcept[]): RelationshipProposal[] {
    if (concepts.length < 2) return [];
    const sentences = splitSentences(chunk.text);
    const proposals: RelationshipProposal[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < concepts.length; i++) {
      for (let j = i + 1; j < concepts.length; j++) {
        const a = concepts[i];
        const b = concepts[j];
        const pair = orderedPair(a.conceptId, b.conceptId);
        const evidenceSentence = findCoOccurringSentence(sentences, a, b);

        if (evidenceSentence) {
          const cue = findFirstCue(evidenceSentence);
          if (cue) {
            const key = `${pair.from}::${pair.to}::${cue.relation}`;
            if (!seen.has(key)) {
              seen.add(key);
              proposals.push({
                fromConceptId: pair.from,
                toConceptId: pair.to,
                relation: cue.relation,
                confidence: cue.confidence,
                evidence: evidenceSentence.trim().slice(0, 400),
                chunkId: chunk.id,
              });
            }
            continue;
          }
        }

        // Fallback: co-occurrence within the chunk without a cue. Emit only
        // when both concepts appear with meaningful confidence, so we don't
        // manufacture a graph of noise.
        if (a.confidence >= 0.3 && b.confidence >= 0.3) {
          const key = `${pair.from}::${pair.to}::co_occurs_with`;
          if (!seen.has(key)) {
            seen.add(key);
            proposals.push({
              fromConceptId: pair.from,
              toConceptId: pair.to,
              relation: 'co_occurs_with',
              confidence: Math.min(0.5, (a.confidence + b.confidence) / 4),
              evidence: `both concepts appear in chunk ${chunk.id}`,
              chunkId: chunk.id,
            });
          }
        }
      }
    }

    return proposals;
  }
}

function orderedPair(a: string, b: string): { from: string; to: string } {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

function findCoOccurringSentence(
  sentences: { text: string; start: number; end: number }[],
  a: ExtractedConcept,
  b: ExtractedConcept,
): string | null {
  for (const s of sentences) {
    const hasA = a.matches.some((m) => m.offset >= s.start && m.offset < s.end);
    const hasB = b.matches.some((m) => m.offset >= s.start && m.offset < s.end);
    if (hasA && hasB) return s.text;
  }
  return null;
}

function findFirstCue(sentence: string): CuePattern | null {
  for (const cue of CUE_PATTERNS) {
    if (cue.regex.test(sentence)) return cue;
  }
  return null;
}

export function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /[^.!?]+[.!?]+(?:\s+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    out.push({ text: m[0], start, end });
  }
  if (out.length === 0 && text.length > 0) out.push({ text, start: 0, end: text.length });
  return out;
}
