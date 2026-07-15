import { MemoryRecord } from '../domain/knowledge';
import { RetrievalResult } from '../rag/interfaces';

/**
 * Neural Brain — the shared intelligence pipeline every TradeW AI consumes.
 *
 * Locked pipeline (Q2 / user spec):
 *   search memory → if found, use it
 *                 → if missing: research → learn → store → connect → answer
 *
 * The Brain never executes trades and never produces Buy/Sell/Entry/Exit/Target
 * language — guardrails are enforced by consumers (agents) AND by prompt
 * contracts in the Prompt Library.
 */

export interface BrainAskRequest {
  question: string;
  userId?: string | null;
  namespace?: string;
  /** allow a research run on memory miss (entitlement-gated upstream) */
  allowResearch?: boolean;
  /** extra context the caller already has (e.g. current market snapshot) */
  inlineContext?: string;
  /** logical model tier for the answering completion */
  tier?: 'fast' | 'balanced' | 'deep';
}

export interface BrainAskResponse {
  answer: string;
  /** how the answer was produced, for audit + UI transparency */
  path: 'memory' | 'memory+research' | 'research' | 'model_only';
  retrieval: RetrievalResult | null;
  /** new knowledge created while answering (research learnings, the Q&A itself) */
  learned: MemoryRecord[];
  confidence: number;
}

export interface NeuralBrain {
  ask(request: BrainAskRequest): Promise<BrainAskResponse>;
  /** push knowledge in without a question (documents, task outputs, observations) */
  learn(input: LearnInput): Promise<MemoryRecord[]>;
}

/** Learning Engine — event-driven ingestion; every completed task makes the Brain smarter. */
export type LearnEventKind =
  | 'task_completed'
  | 'document_imported'
  | 'research_result'
  | 'conversation_turn'
  | 'observation_recorded'
  | 'journal_entry'
  | 'report_generated';

export interface LearnInput {
  kind: LearnEventKind;
  /** raw content to be summarized/embedded/connected/stored */
  content: string;
  userId?: string | null;
  namespace?: string;
  sourceReference?: string;
  tags?: string[];
}

export interface LearningEngine {
  ingest(input: LearnInput): Promise<MemoryRecord[]>;
}
