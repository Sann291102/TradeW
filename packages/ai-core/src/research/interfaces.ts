import { MemoryRecord } from '../domain/knowledge';
import { ResearchQuery, ResearchResult } from '../providers/types';

/**
 * Research Engine — sits above the raw ResearchProvider(s).
 *
 * Pipeline contract (from the Sentinel spec): results are
 *   validated → summarized → embedded → connected → stored → indexed.
 * No continuous/uncontrolled crawling — research runs are event-driven
 * (a Brain miss, an explicit request, or a future scheduled refresh).
 */

export interface ResearchRunRequest extends ResearchQuery {
  /** who triggered it (for provenance + entitlement checks upstream) */
  userId?: string | null;
  namespace?: string;
  /** store learned knowledge into memory (default true) */
  learn?: boolean;
}

export interface ResearchRunResult {
  results: ResearchResult[];
  /** memory records created from validated+summarized results (empty if learn=false) */
  learned: MemoryRecord[];
  /** results dropped by validation and why */
  rejected: { result: ResearchResult; reason: string }[];
}

export interface ResearchEngine {
  run(request: ResearchRunRequest): Promise<ResearchRunResult>;
}
