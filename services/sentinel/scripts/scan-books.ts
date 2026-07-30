/**
 * List every book the scanner sees under SENTINEL_BOOKS_DIR (default
 * docs/Trading Books/), with size and checksum. Useful for verifying the
 * books folder is wired correctly before running an ingestion.
 *
 *   npm run learning:scan
 */
import { BookScannerService } from '../src/learning/book-scanner.service';
import { loadLearningConfig } from '../src/learning/learning.config';

function main(): void {
  const config = loadLearningConfig();
  const scanner = new BookScannerService(config);
  const books = scanner.scan();

  console.log(`books directory: ${config.booksDir}`);
  console.log(`found ${books.length} book(s)\n`);
  for (const b of books) {
    const sizeMb = (b.sizeBytes / 1024 / 1024).toFixed(2);
    console.log(`  [${b.kind.padEnd(8)}] ${b.relativePath}`);
    console.log(`             ${sizeMb} MB, sha256 ${b.checksum.slice(0, 16)}…`);
  }
}

main();
