import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { extname, join, relative, resolve, sep } from 'path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SI_CONFIG, SentinelIntelligenceConfig, CorpusRoot } from '../si.config';
import type { KnowledgeSourceKind } from '../types';
import type { DocumentKind } from '../../learning/types';

/**
 * One source document discovered on disk.
 *
 * Structurally a superset of `learning/types.ts`'s `BookFile`, so the existing
 * `DocumentParserService` accepts it unchanged — that parser is reused rather
 * than reimplemented, and this module adds only the corpus-tier field it needs
 * for citation authority.
 */
export interface CorpusDocument {
  absolutePath: string;
  relativePath: string;
  title: string;
  extension: string;
  kind: DocumentKind;
  sizeBytes: number;
  mtimeMs: number;
  checksum: string;
  /** Corpus tier — drives citation authority during ranking. */
  sourceKind: KnowledgeSourceKind;
}

export interface ScanReport {
  documents: CorpusDocument[];
  /** Files seen but deliberately not indexed, with the reason. */
  skipped: { path: string; reason: string }[];
  /** Configured roots that do not exist on disk. */
  missingRoots: string[];
  durationMs: number;
}

/** Directories never worth walking — build output, deps, VCS internals. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.claude',
  '__pycache__',
  '.venv',
  'venv',
  'archive',
]);

const EXTENSION_KIND: Record<string, DocumentKind> = {
  pdf: 'pdf',
  docx: 'docx',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  text: 'text',
  yaml: 'text',
  yml: 'text',
  json: 'text',
  epub: 'text',
};

/**
 * Walks the configured corpus roots and returns every indexable document.
 *
 * Deliberately checksum-based rather than mtime-based: a `git checkout` or a
 * fresh clone rewrites mtimes on files whose content never changed, and an
 * mtime-keyed index would then re-parse and re-embed the entire book corpus
 * for nothing. Content hashing makes re-indexing genuinely incremental.
 *
 * `archive/` is excluded by name because CLAUDE.md Rule 1 makes it the
 * repository's graveyard for superseded code — indexing it would teach the
 * reasoning engine from designs that were explicitly abandoned.
 */
@Injectable()
export class CorpusScannerService {
  private readonly logger = new Logger(CorpusScannerService.name);

  constructor(@Inject(SI_CONFIG) private readonly config: SentinelIntelligenceConfig) {}

  async scan(): Promise<ScanReport> {
    const started = Date.now();
    const documents: CorpusDocument[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const missingRoots: string[] = [];
    // A document reachable from two roots (e.g. `knowledge/sentinel-learning`
    // is nested inside `knowledge/`) must be indexed once, under the HIGHER
    // authority tier. Roots are ordered by authority in the config, so first
    // writer wins and later, weaker roots skip the path.
    const claimed = new Set<string>();

    for (const root of this.config.corpusRoots) {
      const absoluteRoot = resolve(this.config.repoRoot, root.path);
      if (!existsSync(absoluteRoot)) {
        missingRoots.push(root.path);
        continue;
      }
      await this.walk(absoluteRoot, root, documents, skipped, claimed);
    }

    const durationMs = Date.now() - started;
    this.logger.log(
      `corpus scan: ${documents.length} documents across ${this.config.corpusRoots.length - missingRoots.length} roots ` +
        `(${skipped.length} skipped, ${missingRoots.length} roots absent) in ${durationMs}ms`,
    );
    return { documents, skipped, missingRoots, durationMs };
  }

  private async walk(
    dir: string,
    root: CorpusRoot,
    out: CorpusDocument[],
    skipped: { path: string; reason: string }[],
    claimed: Set<string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: dir, reason: `unreadable directory: ${(err as Error).message}` });
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (!root.recursive) continue;
        await this.walk(full, root, out, skipped, claimed);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = extname(entry.name).slice(1).toLowerCase();
      if (!root.extensions.includes(extension)) continue;

      const relativePath = relative(this.config.repoRoot, full).split(sep).join('/');
      if (claimed.has(relativePath)) continue;

      try {
        const stats = await stat(full);
        if (stats.size === 0) {
          skipped.push({ path: relativePath, reason: 'empty file' });
          continue;
        }
        if (stats.size > this.config.maxFileBytes) {
          skipped.push({
            path: relativePath,
            reason: `exceeds SI_MAX_FILE_BYTES (${stats.size} > ${this.config.maxFileBytes})`,
          });
          continue;
        }

        const checksum = await checksumOf(full);
        claimed.add(relativePath);
        out.push({
          absolutePath: full,
          relativePath,
          title: entry.name.replace(/\.[^.]+$/, ''),
          extension,
          kind: EXTENSION_KIND[extension] ?? 'text',
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          checksum,
          sourceKind: root.kind,
        });
      } catch (err) {
        skipped.push({ path: relativePath, reason: `stat/hash failed: ${(err as Error).message}` });
      }
    }
  }
}

/**
 * sha256 of file contents.
 *
 * Read in full rather than streamed: the largest corpus member is a trading
 * book measured in tens of megabytes, well inside a single buffer, and the
 * scan runs off the request path.
 */
export async function checksumOf(path: string): Promise<string> {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}
