import { readFile } from 'fs/promises';
import { BookFile, DocumentMetadata, ParsedDocument, SectionMarker } from '../types';
import { detectSectionsFromText, normaliseWhitespace } from './pdf.parser';

/**
 * DOCX text extraction using `mammoth`. Books in `docs/Trading Books/` today
 * are PDFs, but the pipeline accepts DOCX so that operator-supplied
 * strategy handbooks, research notes, and OCR outputs can be ingested by the
 * same code path.
 */
export async function parseDocx(book: BookFile): Promise<ParsedDocument> {
  const mammoth = await loadMammoth();
  const buffer = await readFile(book.absolutePath);
  const result = await mammoth.extractRawText({ buffer });
  const text = normaliseWhitespace(typeof result?.value === 'string' ? result.value : '');

  const meta: DocumentMetadata = {
    sections: detectSectionsFromDocxText(text),
  };

  return {
    book,
    text,
    pageCount: null,
    meta,
  };
}

async function loadMammoth(): Promise<{
  extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string; messages: unknown[] }>;
}> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('mammoth');
  return (mod && (mod.default ?? mod)) as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string; messages: unknown[] }>;
  };
}

/**
 * Mammoth's `extractRawText` drops style information, so heading detection
 * falls back to the same text-heuristic pass used for PDFs.
 */
function detectSectionsFromDocxText(text: string): SectionMarker[] {
  return detectSectionsFromText(text);
}
