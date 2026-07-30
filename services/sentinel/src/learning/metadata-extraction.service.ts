import { Injectable } from '@nestjs/common';
import { BookFile, DocumentMetadata, ParsedDocument } from './types';

export interface EnrichedMetadata extends DocumentMetadata {
  /** Effective title — embedded metadata wins, otherwise filename. */
  effectiveTitle: string;
  /** Whether the document appears to contain extractable text at all. */
  hasText: boolean;
  /** Detected language, when confidently inferable — English-only heuristic here. */
  language: 'en' | 'unknown';
  /** Word count of the parsed body. */
  wordCount: number;
  /** True when the filename or metadata suggests trading-related content. */
  isTradingContent: boolean;
  /** Tags derived from filename, metadata, and content signals. */
  derivedTags: string[];
}

const TRADING_TERMS = [
  'trading',
  'trader',
  'market',
  'stocks?',
  'options?',
  'futures?',
  'swing',
  'day\\s?trad',
  'wyckoff',
  'ict',
  'smart\\s?money',
  'liquidity',
  'volatility',
  'psychology',
  'strategy',
  'strategies',
  'divergence',
  'price\\s?action',
];

const TRADING_REGEX = new RegExp(`\\b(${TRADING_TERMS.join('|')})\\b`, 'i');

/**
 * Second-pass metadata: combines parser-provided fields with filename cues
 * and coarse content signals. Used to tag every MemoryRecord written for a
 * book so the Brain can filter by e.g. `topic:psychology` even when the
 * embedded PDF metadata is empty (which it is for most trading PDFs).
 */
@Injectable()
export class MetadataExtractionService {
  extract(doc: ParsedDocument): EnrichedMetadata {
    const hasText = doc.text.length > 0;
    const effectiveTitle = doc.meta.title || cleanTitleFromFilename(doc.book);
    const wordCount = hasText ? doc.text.split(/\s+/).filter((w) => w.length > 0).length : 0;
    const language = hasText && this.looksEnglish(doc.text) ? 'en' : 'unknown';
    const isTradingContent = TRADING_REGEX.test(doc.book.title) || (hasText && TRADING_REGEX.test(doc.text.slice(0, 5000)));

    const derivedTags = new Set<string>();
    derivedTags.add(`kind:${doc.book.kind}`);
    derivedTags.add(`source:book`);
    if (isTradingContent) derivedTags.add('domain:trading');
    for (const tag of tagsFromTitle(doc.book.title)) derivedTags.add(tag);

    return {
      ...doc.meta,
      effectiveTitle,
      hasText,
      language,
      wordCount,
      isTradingContent,
      derivedTags: [...derivedTags],
    };
  }

  private looksEnglish(text: string): boolean {
    const sample = text.slice(0, 2000).toLowerCase();
    const commonHits =
      (sample.match(/\bthe\b/g)?.length ?? 0) +
      (sample.match(/\band\b/g)?.length ?? 0) +
      (sample.match(/\bof\b/g)?.length ?? 0) +
      (sample.match(/\bto\b/g)?.length ?? 0);
    return commonHits >= 10;
  }
}

function cleanTitleFromFilename(book: BookFile): string {
  return book.title.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tagsFromTitle(title: string): string[] {
  const t = title.toLowerCase();
  const tags: string[] = [];
  if (/psychology/.test(t)) tags.push('topic:psychology');
  if (/volatility/.test(t)) tags.push('topic:volatility');
  if (/swing/.test(t)) tags.push('topic:swing-trading');
  if (/day\s?trad/.test(t)) tags.push('topic:day-trading');
  if (/divergence/.test(t)) tags.push('topic:divergence');
  if (/liquidity/.test(t)) tags.push('topic:liquidity');
  if (/price\s?action/.test(t)) tags.push('topic:price-action');
  if (/strateg/.test(t)) tags.push('topic:strategies');
  if (/beginner/.test(t)) tags.push('topic:beginners');
  if (/system/.test(t)) tags.push('topic:system-development');
  return tags;
}
