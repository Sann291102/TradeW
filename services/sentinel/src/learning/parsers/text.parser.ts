import { readFile } from 'fs/promises';
import { BookFile, DocumentMetadata, ParsedDocument, SectionMarker } from '../types';
import { normaliseWhitespace } from './pdf.parser';

/**
 * Plain-text and Markdown extraction. Markdown headings become explicit
 * SectionMarkers (level from the number of `#`s), which yields much better
 * chunk anchors than heading heuristics do.
 */
export async function parseText(book: BookFile): Promise<ParsedDocument> {
  const raw = await readFile(book.absolutePath, 'utf8');
  const text = normaliseWhitespace(raw);

  const sections = book.kind === 'markdown' ? extractMarkdownHeadings(text) : detectPlainSections(text);
  const meta: DocumentMetadata = { sections };

  return { book, text, pageCount: null, meta };
}

export function extractMarkdownHeadings(text: string): SectionMarker[] {
  const markers: SectionMarker[] = [];
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      markers.push({
        offset,
        level: match[1].length,
        title: match[2].trim(),
      });
    }
    offset += line.length + 1;
  }
  return markers;
}

function detectPlainSections(text: string): SectionMarker[] {
  // Reuse the PDF heuristic — a plain-text file has the same shape.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { detectSectionsFromText } = require('./pdf.parser') as typeof import('./pdf.parser');
  return detectSectionsFromText(text);
}
