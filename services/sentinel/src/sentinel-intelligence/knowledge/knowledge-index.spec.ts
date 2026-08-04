import { describe, expect, it } from 'vitest';
import {
  KnowledgeIndexService,
  bestQuote,
  termFrequencies,
  tokenize,
  type IndexedChunk,
} from './knowledge-index.service';
import type { KnowledgeSourceKind } from '../types';

/**
 * The citation guarantee rests entirely on this index, so these tests care
 * about two things: that retrieval finds the right passage, and that a
 * citation built from a hit points at real, verbatim text.
 */

function chunk(
  id: string,
  sourceId: string,
  text: string,
  sourceKind: KnowledgeSourceKind = 'book',
  section: string | null = null,
): IndexedChunk {
  const tokens = tokenize(text);
  return {
    chunkId: id,
    sourceId,
    sourceTitle: `Title ${sourceId}`,
    sourcePath: `docs/Trading Books/${sourceId}.pdf`,
    sourceKind,
    index: Number(id.split(':')[1] ?? 0),
    charStart: 0,
    charEnd: text.length,
    section,
    page: null,
    text,
    termFreq: termFrequencies(tokens),
    length: tokens.length,
  };
}

function indexWith(chunks: IndexedChunk[]): KnowledgeIndexService {
  const index = new KnowledgeIndexService();
  index.replaceAll(chunks, new Date().toISOString());
  return index;
}

describe('tokenize', () => {
  it('keeps numbers, which are meaningful in a trading corpus', () => {
    expect(tokenize('RSI above 70')).toContain('70');
    expect(tokenize('the 61.8% retracement')).toContain('61.8');
  });

  it('emits hyphenated compounds both joined and split', () => {
    const tokens = tokenize('supply-demand imbalance');
    expect(tokens).toContain('supply-demand');
    expect(tokens).toContain('supply');
    expect(tokens).toContain('demand');
  });

  it('drops stopwords but keeps directional words that carry meaning here', () => {
    const tokens = tokenize('price is above the high and below the low');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).toContain('above');
    expect(tokens).toContain('high');
  });
});

describe('search', () => {
  it('ranks the passage that actually discusses the query first', () => {
    const index = indexWith([
      chunk('a:0', 'a', 'A liquidity sweep occurs when price pierces a swing high and closes back below it, taking resting stop orders.'),
      chunk('b:0', 'b', 'Position sizing determines survival through a losing sequence more than entry accuracy does.'),
      chunk('c:0', 'c', 'Moving averages smooth price to reveal the underlying trend direction over a chosen period.'),
    ]);

    const hits = index.search('liquidity sweep stop orders', { limit: 3 });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.sourceId).toBe('a');
  });

  it('returns nothing rather than a weak guess when no term matches', () => {
    const index = indexWith([chunk('a:0', 'a', 'A liquidity sweep pierces a swing high and closes back below.')]);
    expect(index.search('quarterly dividend reinvestment policy')).toEqual([]);
  });

  it('caps how many chunks one document contributes so corroboration means something', () => {
    // Eight passages from one book is one author repeated, not eight sources.
    const chunks = [
      ...Array.from({ length: 8 }, (_, i) =>
        chunk(`hog:${i}`, 'hog', 'liquidity sweep stop hunt swing high pierced and reclaimed'),
      ),
      chunk('other:0', 'other', 'liquidity sweep taking resting stop orders above the swing high'),
    ];
    const index = indexWith(chunks);

    const hits = index.search('liquidity sweep stop', { limit: 6 });
    const fromHog = hits.filter((h) => h.chunk.sourceId === 'hog').length;

    expect(fromHog).toBeLessThan(hits.length);
    expect(hits.some((h) => h.chunk.sourceId === 'other')).toBe(true);
  });

  it('weights a user rule above a book on equal textual merit', () => {
    const text = 'liquidity sweep above the swing high then reclaim';
    const index = indexWith([
      chunk('book:0', 'book', text, 'book'),
      chunk('rule:0', 'rule', text, 'user-rule'),
    ]);

    const hits = index.search('liquidity sweep reclaim', { limit: 2 });

    expect(hits[0].chunk.sourceKind).toBe('user-rule');
  });

  it('respects a preferred corpus tier without hard-filtering the others', () => {
    const index = indexWith([
      chunk('book:0', 'book', 'liquidity sweep above the swing high then reclaim', 'book'),
      chunk('vault:0', 'vault', 'liquidity sweep above the swing high then reclaim', 'vault'),
    ]);

    const hits = index.search('liquidity sweep', { limit: 2, preferKinds: ['book'] });

    expect(hits[0].chunk.sourceKind).toBe('book');
    expect(hits).toHaveLength(2); // the vault hit still surfaces
  });
});

describe('citations', () => {
  it('quotes verbatim source text, never a paraphrase', () => {
    const text =
      'Institutions accumulate below the range. A liquidity sweep pierces the swing low and closes back above it. That reclaim is the signature.';
    const index = indexWith([chunk('a:0', 'a', text, 'book', 'Ch. 3 — Liquidity')]);

    const citation = index.cite('liquidity sweep reclaim swing low')[0];

    expect(citation).toBeDefined();
    expect(text).toContain(citation.quote.replace(/…$/, ''));
    expect(citation.locator).toBe('Ch. 3 — Liquidity');
    expect(citation.sourcePath).toBe('docs/Trading Books/a.pdf');
  });

  it('falls back to a chunk locator when the source has no headings', () => {
    const index = indexWith([chunk('a:4', 'a', 'A liquidity sweep pierces the swing low and reclaims it.')]);
    const citation = index.cite('liquidity sweep')[0];
    expect(citation.locator).toBe('chunk 5');
  });

  it('selects the sentence carrying the most query terms', () => {
    const text =
      'Trends persist longer than most expect. Volume confirmation separates a genuine breakout from a false one. Risk is managed by position size.';
    expect(bestQuote(text, ['volume', 'confirmation', 'breakout'])).toMatch(/Volume confirmation/);
  });
});

describe('incremental indexing', () => {
  it('replaces a document’s chunks without touching other documents', () => {
    const index = indexWith([
      chunk('a:0', 'a', 'A liquidity sweep pierces the swing high.'),
      chunk('b:0', 'b', 'Position sizing determines survival.'),
    ]);

    index.upsertDocument('a', [chunk('a:0', 'a', 'Completely different content about moving averages.')]);

    expect(index.stats().documents).toBe(2);
    expect(index.search('liquidity sweep')).toEqual([]);
    expect(index.search('position sizing survival').length).toBeGreaterThan(0);
    expect(index.search('moving averages').length).toBeGreaterThan(0);
  });

  it('makes a removed document uncitable', () => {
    const index = indexWith([chunk('a:0', 'a', 'A liquidity sweep pierces the swing high.')]);

    expect(index.removeDocument('a')).toBe(1);
    expect(index.search('liquidity sweep')).toEqual([]);
    expect(index.stats().documents).toBe(0);
  });
});
