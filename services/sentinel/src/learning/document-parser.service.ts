import { Injectable, Logger } from '@nestjs/common';
import { parseDocx } from './parsers/docx.parser';
import { parsePdf } from './parsers/pdf.parser';
import { parseText } from './parsers/text.parser';
import { BookFile, ParsedDocument } from './types';

/**
 * Dispatches to the appropriate parser by document kind.
 *
 * A parser failure is surfaced as an exception so the queue can mark the job
 * `failed` with a concrete reason. Empty-text (e.g. image-only PDF) is a
 * *successful* parse with `charactersExtracted: 0` — the queue then still
 * produces zero chunks and completes the job so operators see it as "nothing
 * to ingest" rather than a hard error.
 */
@Injectable()
export class DocumentParserService {
  private readonly logger = new Logger(DocumentParserService.name);

  async parse(book: BookFile): Promise<ParsedDocument> {
    switch (book.kind) {
      case 'pdf':
        return parsePdf(book);
      case 'docx':
        return parseDocx(book);
      case 'markdown':
      case 'text':
        return parseText(book);
      default: {
        // Exhaustiveness check — a new DocumentKind added to types.ts without
        // a parser here should fail the build, not silently return no text.
        const exhaustive: never = book.kind;
        throw new Error(`no parser registered for document kind: ${exhaustive as string}`);
      }
    }
  }
}
