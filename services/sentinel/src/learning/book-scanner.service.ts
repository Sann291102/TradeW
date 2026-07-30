import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { extname, join, relative, resolve } from 'path';
import { LEARNING_CONFIG, LearningConfig } from './learning.config';
import { BookFile, DocumentKind } from './types';

const EXTENSION_KIND: Record<string, DocumentKind> = {
  pdf: 'pdf',
  docx: 'docx',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
};

/**
 * Enumerates every ingestable file under the configured books directory.
 *
 * The scanner is content-addressed: each file's sha256 is captured so the
 * queue can dedupe unchanged books across scans and callers can bind
 * ingestion jobs to a specific file version (a re-edit of a book changes
 * its checksum and triggers a re-ingest). Files are never written or
 * modified — the scanner is read-only.
 */
@Injectable()
export class BookScannerService {
  private readonly logger = new Logger(BookScannerService.name);

  constructor(@Inject(LEARNING_CONFIG) private readonly config: LearningConfig) {}

  scan(): BookFile[] {
    const root = this.config.booksDir;
    if (!existsSync(root)) {
      this.logger.warn(`books directory not found: ${root}`);
      return [];
    }
    const stat = statSync(root);
    if (!stat.isDirectory()) {
      this.logger.warn(`books path is not a directory: ${root}`);
      return [];
    }

    const results: BookFile[] = [];
    walk(root, (absolutePath) => {
      const ext = extname(absolutePath).slice(1).toLowerCase();
      const kind = EXTENSION_KIND[ext];
      if (!kind) return;
      const s = statSync(absolutePath);
      if (!s.isFile()) return;
      const buf = readFileSync(absolutePath);
      const checksum = createHash('sha256').update(buf).digest('hex');
      const title = absolutePath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
      results.push({
        absolutePath,
        relativePath: relative(root, absolutePath).replace(/\\/g, '/'),
        title,
        extension: ext,
        kind,
        sizeBytes: s.size,
        mtimeMs: s.mtimeMs,
        checksum,
      });
    });

    return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  find(relativePath: string): BookFile | null {
    const target = resolve(this.config.booksDir, relativePath);
    if (!existsSync(target)) return null;
    const s = statSync(target);
    if (!s.isFile()) return null;
    const ext = extname(target).slice(1).toLowerCase();
    const kind = EXTENSION_KIND[ext];
    if (!kind) return null;
    const buf = readFileSync(target);
    const checksum = createHash('sha256').update(buf).digest('hex');
    const title = target.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
    return {
      absolutePath: target,
      relativePath: relativePath.replace(/\\/g, '/'),
      title,
      extension: ext,
      kind,
      sizeBytes: s.size,
      mtimeMs: s.mtimeMs,
      checksum,
    };
  }
}

function walk(dir: string, visit: (fullPath: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, visit);
    } else if (s.isFile()) {
      visit(full);
    }
  }
}
