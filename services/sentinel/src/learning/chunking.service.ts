import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { LEARNING_CONFIG, LearningConfig } from './learning.config';
import { Chunk, ParsedDocument, SectionMarker } from './types';

/**
 * Splits a parsed document into semantically coherent chunks.
 *
 * The chunker aggregates paragraphs until the accumulated character count
 * reaches the configured target. Paragraphs are never split — a paragraph
 * larger than the target becomes its own chunk (with a runtime warning
 * omitted here to keep the pure service log-free; the metrics reveal it).
 *
 * Overlap between chunks is *content* overlap, not paragraph overlap: the
 * last `chunkOverlapChars` of the previous chunk are re-included at the
 * start of the next chunk so a concept mentioned near a chunk boundary
 * still gets embedded with its surrounding context.
 */
@Injectable()
export class ChunkingService {
  constructor(@Inject(LEARNING_CONFIG) private readonly config: LearningConfig) {}

  chunk(doc: ParsedDocument): Chunk[] {
    if (!doc.text || doc.text.length === 0) return [];

    const target = this.config.chunkChars;
    const overlap = Math.min(this.config.chunkOverlapChars, Math.floor(target / 2));
    const paragraphs = splitParagraphs(doc.text);
    const sections = doc.meta.sections ?? [];

    const chunks: Chunk[] = [];
    let buffer: string[] = [];
    let bufferChars = 0;
    let chunkStart = 0;
    let cursor = 0;
    let index = 0;

    const flush = (endCursor: number) => {
      const text = buffer.join('\n\n').trim();
      if (text.length === 0) return;
      const chunk = this.buildChunk(doc, index, chunkStart, endCursor, text, sections);
      chunks.push(chunk);
      index += 1;
    };

    for (const p of paragraphs) {
      const paragraphChars = p.text.length;
      // If adding this paragraph would exceed the target *and* the buffer is
      // already non-empty, flush first so oversized paragraphs live in their
      // own chunk rather than dragging a small preceding paragraph across.
      if (bufferChars > 0 && bufferChars + paragraphChars > target) {
        flush(cursor);
        // Restart the buffer with overlap tail from what we just flushed.
        if (overlap > 0 && chunks.length > 0) {
          const previous = chunks[chunks.length - 1].text;
          const tail = previous.slice(Math.max(0, previous.length - overlap));
          buffer = [tail];
          bufferChars = tail.length;
        } else {
          buffer = [];
          bufferChars = 0;
        }
        chunkStart = p.start;
      }
      if (buffer.length === 0) chunkStart = p.start;
      buffer.push(p.text);
      bufferChars += paragraphChars + 2; // account for the joiner
      cursor = p.end;
    }
    flush(cursor);

    // Apply per-job cap if configured.
    const cap = this.config.maxChunksPerJob;
    const capped = cap > 0 && chunks.length > cap ? chunks.slice(0, cap) : chunks;

    // Filter out chunks that are shorter than the minimum — pure noise for
    // embedding cost. Do this AFTER indexing so ids stay stable across runs.
    return capped.filter((c) => c.text.length >= this.config.minChunkChars);
  }

  private buildChunk(
    doc: ParsedDocument,
    index: number,
    charStart: number,
    charEnd: number,
    text: string,
    sections: SectionMarker[],
  ): Chunk {
    const id = `${doc.book.checksum.slice(0, 12)}:${String(index).padStart(4, '0')}`;
    const checksum = createHash('sha256').update(text).digest('hex');
    return {
      id,
      book: doc.book,
      index,
      approxTokens: Math.ceil(text.length / 4),
      charStart,
      charEnd,
      section: nearestSection(sections, charStart),
      text,
      checksum,
    };
  }
}

interface Paragraph {
  text: string;
  start: number;
  end: number;
}

export function splitParagraphs(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  const re = /\n{2,}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const end = match.index;
    const slice = text.slice(last, end).trim();
    if (slice.length > 0) out.push({ text: slice, start: last, end });
    last = re.lastIndex;
  }
  const tail = text.slice(last).trim();
  if (tail.length > 0) out.push({ text: tail, start: last, end: text.length });
  return out;
}

export function nearestSection(sections: SectionMarker[], offset: number): SectionMarker | null {
  let best: SectionMarker | null = null;
  for (const s of sections) {
    if (s.offset <= offset) {
      if (!best || s.offset > best.offset) best = s;
    } else {
      break;
    }
  }
  return best;
}
