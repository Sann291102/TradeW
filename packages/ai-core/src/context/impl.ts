import { ChatMessage } from '../providers/types';
import { ContextAssemblyRequest, ContextAssemblyResult, ContextManager } from './interfaces';

/**
 * Deterministic, dependency-free context assembly.
 * Priority when trimming: system+guardrails and the user message are never
 * dropped; history is trimmed oldest-first, then retrieval, then inline data.
 */
export class SimpleContextManager implements ContextManager {
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  assemble(request: ContextAssemblyRequest): ContextAssemblyResult {
    const trimmed: { section: string; droppedTokens: number }[] = [];
    const budget = request.budget.maxInputTokens - request.budget.reservedOutputTokens;

    const systemText =
      request.systemPrompt +
      (request.guardrails.length
        ? '\n\nNon-negotiable rules:\n' + request.guardrails.map((g) => `- ${g}`).join('\n')
        : '');

    const fixedTokens = this.estimateTokens(systemText) + this.estimateTokens(request.userMessage) + 16;
    let remaining = Math.max(0, budget - fixedTokens);

    // retrieval context
    let retrievalText = request.retrieval?.contextText ?? '';
    const retrievalTokens = this.estimateTokens(retrievalText);
    if (retrievalTokens > remaining * 0.5) {
      const allowedChars = Math.floor(remaining * 0.5) * 4;
      trimmed.push({ section: 'retrieval', droppedTokens: retrievalTokens - Math.ceil(allowedChars / 4) });
      retrievalText = retrievalText.slice(0, allowedChars);
    }
    remaining -= this.estimateTokens(retrievalText);

    // inline data
    let inlineText = request.inlineContext ?? '';
    const inlineTokens = this.estimateTokens(inlineText);
    if (inlineTokens > remaining * 0.6) {
      const allowedChars = Math.floor(remaining * 0.6) * 4;
      trimmed.push({ section: 'inline', droppedTokens: inlineTokens - Math.ceil(allowedChars / 4) });
      inlineText = inlineText.slice(0, allowedChars);
    }
    remaining -= this.estimateTokens(inlineText);

    // history — keep most recent turns that fit
    const history: ChatMessage[] = [];
    let historyDropped = 0;
    for (const msg of [...(request.history ?? [])].reverse()) {
      const t = this.estimateTokens(msg.content);
      if (t <= remaining) {
        history.unshift(msg);
        remaining -= t;
      } else {
        historyDropped += t;
      }
    }
    if (historyDropped > 0) trimmed.push({ section: 'history', droppedTokens: historyDropped });

    const userContent = [
      retrievalText ? `Relevant knowledge from memory:\n${retrievalText}` : '',
      inlineText ? `Current data:\n${inlineText}` : '',
      request.userMessage,
    ]
      .filter(Boolean)
      .join('\n\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: systemText },
      ...history,
      { role: 'user', content: userContent },
    ];

    return {
      messages,
      estimatedInputTokens: messages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0),
      trimmed,
    };
  }
}
