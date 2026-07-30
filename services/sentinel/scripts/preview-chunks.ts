/**
 * Parse and chunk a single book without touching the Brain. Prints the chunk
 * count and the first chunk's preview so operators can tune SENTINEL_LEARNING_CHUNK_CHARS
 * before running the full ingestion.
 *
 *   npm run learning:preview -- "The Day Trader's Bible.pdf"
 */
import { BookScannerService } from '../src/learning/book-scanner.service';
import { ChunkingService } from '../src/learning/chunking.service';
import { DocumentParserService } from '../src/learning/document-parser.service';
import { MetadataExtractionService } from '../src/learning/metadata-extraction.service';
import { loadLearningConfig } from '../src/learning/learning.config';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: npm run learning:preview -- "<book relative path>"');
    process.exit(2);
  }

  const config = loadLearningConfig();
  const scanner = new BookScannerService(config);
  const parser = new DocumentParserService();
  const chunker = new ChunkingService(config);
  const metaSvc = new MetadataExtractionService();

  const book = scanner.find(target);
  if (!book) {
    console.error(`book not found under ${config.booksDir}: ${target}`);
    process.exit(1);
  }

  const doc = await parser.parse(book);
  const meta = metaSvc.extract(doc);
  const chunks = chunker.chunk(doc);

  console.log(`book:         ${book.relativePath}`);
  console.log(`kind:         ${book.kind}`);
  console.log(`pages:        ${doc.pageCount ?? '(unknown)'}`);
  console.log(`chars:        ${doc.text.length}`);
  console.log(`words:        ${meta.wordCount}`);
  console.log(`language:     ${meta.language}`);
  console.log(`trading:      ${meta.isTradingContent}`);
  console.log(`chunks:       ${chunks.length}`);
  console.log(`chunk target: ${config.chunkChars} chars (overlap ${config.chunkOverlapChars})`);
  console.log(`derived tags: ${meta.derivedTags.join(', ')}`);

  if (chunks.length > 0) {
    const first = chunks[0];
    console.log(`\n--- first chunk (${first.id}) ---`);
    console.log(`section: ${first.section?.title ?? '(none)'}`);
    console.log(`chars:   ${first.text.length}`);
    console.log(`tokens:  ~${first.approxTokens}`);
    console.log(`\n${first.text.slice(0, 600)}${first.text.length > 600 ? '\n…' : ''}`);
  }
}

main().catch((err) => {
  console.error((err as Error).stack ?? err);
  process.exit(1);
});
