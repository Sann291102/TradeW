import { readFile } from 'fs/promises';
import { DocumentMetadata, ParsedDocument, BookFile, SectionMarker } from '../types';

/**
 * PDF text extraction using `pdf-parse`.
 *
 * pdf-parse is a text-layer extractor — it does NOT OCR scanned images.
 * A book that is a pure image scan will return empty text, and the caller
 * should record `charactersExtracted: 0` and move on rather than blow up.
 *
 * The library is required lazily so a monorepo build never fails when the
 * dep is absent in an unrelated package.
 */
export async function parsePdf(book: BookFile): Promise<ParsedDocument> {
  const pdfParse = await loadPdfParse();
  const buffer = await readFile(book.absolutePath);
  const result = await pdfParse(buffer);

  const rawText: string = typeof result?.text === 'string' ? result.text : '';
  const text = normaliseWhitespace(rawText);

  const meta: DocumentMetadata = {
    title: pickString(result?.info?.Title),
    author: pickString(result?.info?.Author),
    subject: pickString(result?.info?.Subject),
    producer: pickString(result?.info?.Producer),
    creator: pickString(result?.info?.Creator),
    creationDate: pickString(result?.info?.CreationDate),
    keywords: splitKeywords(pickString(result?.info?.Keywords)),
    sections: detectSectionsFromText(text),
  };

  return {
    book,
    text,
    pageCount: typeof result?.numpages === 'number' ? result.numpages : null,
    meta,
  };
}

async function loadPdfParse(): Promise<(data: Buffer) => Promise<{ text: string; numpages: number; info: Record<string, unknown> }>> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('pdf-parse');
  return (mod && (mod.default ?? mod)) as (data: Buffer) => Promise<{ text: string; numpages: number; info: Record<string, unknown> }>;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function splitKeywords(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(/[;,]/).map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

export function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
}

/**
 * Heuristic section detection for text that has no explicit heading markup.
 * Lines that are short, capitalised, and preceded by a blank line are treated
 * as titles. Deliberately loose: false positives are cheap, they just add
 * more anchor points; false negatives cost readability of ingested chunks.
 */
export function detectSectionsFromText(text: string): SectionMarker[] {
  const markers: SectionMarker[] = [];
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (isLikelyHeading(trimmed, lines[i - 1], lines[i + 1])) {
      markers.push({ offset, level: guessHeadingLevel(trimmed), title: trimmed });
    }
    offset += line.length + 1;
  }
  return markers;
}

function isLikelyHeading(line: string, prev: string | undefined, next: string | undefined): boolean {
  if (line.length === 0 || line.length > 100) return false;
  if (/[.!?]$/.test(line)) return false;
  const prevBlank = !prev || prev.trim().length === 0;
  const nextBlank = !next || next.trim().length === 0;
  if (!prevBlank && !nextBlank) return false;
  const chapterMatch = /^(chapter|part|section|book|module|lesson)\s+\d+/i.test(line);
  const numberedMatch = /^\d+(?:\.\d+)*\s+\S/.test(line);
  const allCaps = line === line.toUpperCase() && /[A-Z]/.test(line) && line.length >= 4;
  const titleCase = /^([A-Z][A-Za-z0-9'&,-]*)(\s+[A-Z][A-Za-z0-9'&,-]*)+$/.test(line);
  return chapterMatch || numberedMatch || allCaps || titleCase;
}

function guessHeadingLevel(line: string): number {
  if (/^(chapter|part|book)\s+\d+/i.test(line)) return 1;
  if (/^\d+\.\d+\.\d+/.test(line)) return 3;
  if (/^\d+\.\d+/.test(line)) return 2;
  if (/^\d+\s/.test(line)) return 1;
  if (line === line.toUpperCase()) return 1;
  return 2;
}
