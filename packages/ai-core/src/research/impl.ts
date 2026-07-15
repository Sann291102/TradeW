import { MemoryRecord } from '../domain/knowledge';
import { LearningEngine } from '../brain/interfaces';
import { ProviderManager } from '../providers/provider-manager';
import { ResearchResult } from '../providers/types';
import { ResearchEngine, ResearchRunRequest, ResearchRunResult } from './interfaces';

/**
 * Default Research Engine: provider search → validate → summarize (LLM) →
 * learn (embed + store + connect, via the LearningEngine).
 * Event-driven only — this class never schedules or crawls on its own.
 */
export class DefaultResearchEngine implements ResearchEngine {
  constructor(
    private providers: ProviderManager,
    private learning: LearningEngine,
  ) {}

  async run(request: ResearchRunRequest): Promise<ResearchRunResult> {
    const provider = this.providers.getResearch();
    const results = await provider.search({
      query: request.query,
      maxResults: request.maxResults ?? 5,
      recencyDays: request.recencyDays,
      includeDomains: request.includeDomains,
    });

    // validate: require a real URL + non-empty content, dedupe by URL
    const rejected: { result: ResearchResult; reason: string }[] = [];
    const seen = new Set<string>();
    const valid: ResearchResult[] = [];
    for (const r of results) {
      if (!r.url || !/^https?:\/\//.test(r.url)) {
        rejected.push({ result: r, reason: 'invalid_url' });
      } else if (!(r.snippet || r.content)) {
        rejected.push({ result: r, reason: 'empty_content' });
      } else if (seen.has(r.url)) {
        rejected.push({ result: r, reason: 'duplicate_url' });
      } else {
        seen.add(r.url);
        valid.push(r);
      }
    }

    const learned: MemoryRecord[] = [];
    if (request.learn !== false && valid.length > 0) {
      const summary = await this.summarize(request.query, valid);
      const records = await this.learning.ingest({
        kind: 'research_result',
        content: `Research question: ${request.query}\n\nFindings:\n${summary}\n\nSources:\n${valid
          .map((v) => `- ${v.title} (${v.url})`)
          .join('\n')}`,
        userId: request.userId,
        namespace: request.namespace,
        sourceReference: valid[0].url,
        tags: ['research'],
      });
      learned.push(...records);
    }

    return { results: valid, learned, rejected };
  }

  private async summarize(query: string, results: ResearchResult[]): Promise<string> {
    const llm = this.providers.getLlm();
    const material = results
      .map((r, i) => `[${i + 1}] ${r.title}\n${(r.content ?? r.snippet).slice(0, 1500)}`)
      .join('\n\n');
    const response = await llm.complete({
      tier: 'fast',
      maxTokens: 500,
      messages: [
        {
          role: 'system',
          content:
            'Summarize the research material into 3-6 factual bullet points answering the question. Cite source numbers like [1]. No advice, no recommendations — facts and observations only.',
        },
        { role: 'user', content: `Question: ${query}\n\nMaterial:\n${material}` },
      ],
    });
    return response.text.trim();
  }
}
