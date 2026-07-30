/**
 * Learning module test suite.
 *
 * Deterministic, DB-free tests for every pure service in
 * `src/learning/`. Follows the repo convention of ts-node runnable
 * "smoke/test" scripts (there is no jest configured for this service).
 *
 *   npm run learning:test
 *
 * Exits non-zero on any assertion failure so CI can gate on it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OntologyLoaderService, resolveKnowledgeBaseDir } from '../src/brain/ontology/ontology-loader.service';
import { BookScannerService } from '../src/learning/book-scanner.service';
import { ChunkingService, nearestSection, splitParagraphs } from '../src/learning/chunking.service';
import { ConceptExtractionService } from '../src/learning/concept-extraction.service';
import { LearningConfig, loadLearningConfig } from '../src/learning/learning.config';
import { MetadataExtractionService } from '../src/learning/metadata-extraction.service';
import { RelationshipExtractionService, splitSentences } from '../src/learning/relationship-extraction.service';
import { detectSectionsFromText, normaliseWhitespace } from '../src/learning/parsers/pdf.parser';
import { extractMarkdownHeadings } from '../src/learning/parsers/text.parser';
import { IngestionStateStore } from '../src/learning/ingestion-state.store';
import { BookFile, EMPTY_METRICS, IngestionJob, ParsedDocument } from '../src/learning/types';

let failures = 0;
let passes = 0;
let currentSuite = '';

function suite(name: string, run: () => void | Promise<void>): Promise<void> {
  currentSuite = name;
  console.log(`\n== ${name} ==`);
  const result = run();
  if (result && typeof (result as Promise<void>).then === 'function') return result as Promise<void>;
  return Promise.resolve();
}

function test(name: string, body: () => void): void {
  try {
    body();
    passes += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function makeConfig(overrides: Partial<LearningConfig> = {}): LearningConfig {
  return { ...loadLearningConfig(), ...overrides };
}

function makeBook(overrides: Partial<BookFile> = {}): BookFile {
  return {
    absolutePath: '/tmp/fake.pdf',
    relativePath: 'fake.pdf',
    title: 'fake',
    extension: 'pdf',
    kind: 'pdf',
    sizeBytes: 0,
    mtimeMs: 0,
    checksum: 'a'.repeat(64),
    ...overrides,
  };
}

async function main(): Promise<void> {
  await suite('normaliseWhitespace', () => {
    test('collapses CR/LF and non-breaking spaces', () => {
      const out = normaliseWhitespace('a\r\n\r\n\r\nb \n c');
      assertEq(out, 'a\n\nb\n c');
    });
    test('trims trailing whitespace before newlines', () => {
      const out = normaliseWhitespace('line1   \nline2');
      assertEq(out, 'line1\nline2');
    });
  });

  await suite('detectSectionsFromText', () => {
    test('finds chapter-style headings', () => {
      const text = ['Intro paragraph here.', '', 'Chapter 1', '', 'body body body.'].join('\n');
      const sections = detectSectionsFromText(text);
      assert(sections.length >= 1, 'expected at least one section');
      assert(sections.some((s) => /^chapter\s+1/i.test(s.title)), 'chapter heading missed');
    });
    test('rejects sentences that end with punctuation', () => {
      const text = ['This is a sentence.', '', 'This is another sentence.', ''].join('\n');
      const sections = detectSectionsFromText(text);
      assertEq(sections.length, 0);
    });
  });

  await suite('extractMarkdownHeadings', () => {
    test('extracts levels from # count', () => {
      const md = '# Big\n\n## Medium\n\n### Small\n\nbody';
      const sections = extractMarkdownHeadings(md);
      assertEq(sections.length, 3);
      assertEq(sections[0].level, 1);
      assertEq(sections[1].level, 2);
      assertEq(sections[2].level, 3);
      assertEq(sections[0].title, 'Big');
    });
  });

  await suite('splitParagraphs / splitSentences', () => {
    test('splitParagraphs splits on double newline', () => {
      const paras = splitParagraphs('first para\n\nsecond para\n\nthird');
      assertEq(paras.length, 3);
      assertEq(paras[0].text, 'first para');
    });
    test('splitSentences respects terminal punctuation', () => {
      const sents = splitSentences('One sentence. Two sentence? Three sentence!');
      assertEq(sents.length, 3);
    });
    test('splitSentences handles single unterminated sentence', () => {
      const sents = splitSentences('no punctuation here');
      assertEq(sents.length, 1);
    });
  });

  await suite('nearestSection', () => {
    test('picks the last section preceding the offset', () => {
      const sections = [
        { offset: 0, level: 1, title: 'A' },
        { offset: 100, level: 1, title: 'B' },
        { offset: 500, level: 1, title: 'C' },
      ];
      assertEq(nearestSection(sections, 250)?.title, 'B');
      assertEq(nearestSection(sections, 600)?.title, 'C');
      assertEq(nearestSection(sections, 50)?.title, 'A');
    });
  });

  await suite('ChunkingService', () => {
    const config = makeConfig({ chunkChars: 200, chunkOverlapChars: 30, minChunkChars: 50, maxChunksPerJob: 0 });
    const chunker = new ChunkingService(config);
    const paragraph = 'x'.repeat(150);
    const doc: ParsedDocument = {
      book: makeBook(),
      text: [paragraph, paragraph, paragraph, paragraph].join('\n\n'),
      pageCount: 1,
      meta: {},
    };

    test('produces multiple chunks when text exceeds target', () => {
      const chunks = chunker.chunk(doc);
      assert(chunks.length >= 2, `expected >=2 chunks, got ${chunks.length}`);
    });
    test('every chunk has a stable id and non-empty text', () => {
      const chunks = chunker.chunk(doc);
      for (const c of chunks) {
        assert(c.id.length > 0, 'empty id');
        assert(c.text.length > 0, 'empty text');
        assert(c.checksum.length === 64, `expected sha256 checksum, got ${c.checksum.length} chars`);
      }
    });
    test('respects minChunkChars filter', () => {
      const smallDoc: ParsedDocument = { book: makeBook(), text: 'tiny.', pageCount: 1, meta: {} };
      const chunks = chunker.chunk(smallDoc);
      assertEq(chunks.length, 0);
    });
    test('respects maxChunksPerJob cap', () => {
      const capped = new ChunkingService(makeConfig({ chunkChars: 100, chunkOverlapChars: 10, minChunkChars: 10, maxChunksPerJob: 2 }));
      const bigDoc: ParsedDocument = {
        book: makeBook(),
        text: Array(10).fill('x'.repeat(120)).join('\n\n'),
        pageCount: 1,
        meta: {},
      };
      const chunks = capped.chunk(bigDoc);
      assert(chunks.length <= 2, `expected <=2 chunks with cap=2, got ${chunks.length}`);
    });
  });

  await suite('MetadataExtractionService', () => {
    const svc = new MetadataExtractionService();
    test('flags trading content by title', () => {
      const doc: ParsedDocument = {
        book: makeBook({ title: 'Mastering Trading Psychology' }),
        text: 'body text here',
        pageCount: 1,
        meta: {},
      };
      const meta = svc.extract(doc);
      assert(meta.isTradingContent, 'expected isTradingContent=true');
      assert(meta.derivedTags.includes('topic:psychology'), 'expected topic:psychology tag');
    });
    test('detects English by common-word density', () => {
      const doc: ParsedDocument = {
        book: makeBook(),
        text: 'the quick brown fox jumps over the lazy dog and then the dog jumps to the fox of the field to the tree of the forest.',
        pageCount: 1,
        meta: {},
      };
      const meta = svc.extract(doc);
      assertEq(meta.language, 'en');
    });
    test('reports zero words on empty text', () => {
      const doc: ParsedDocument = { book: makeBook(), text: '', pageCount: 0, meta: {} };
      const meta = svc.extract(doc);
      assertEq(meta.hasText, false);
      assertEq(meta.wordCount, 0);
    });
  });

  await suite('ConceptExtractionService (against real knowledge-base)', () => {
    const loader = new OntologyLoaderService(resolveKnowledgeBaseDir());
    const svc = new ConceptExtractionService(loader);
    svc.rebuildIndex();

    test('index loads at least one concept from the real knowledge-base', () => {
      assert(svc.size() > 0, `expected concept index size > 0, got ${svc.size()}`);
    });

    test('matches canonical concept name', () => {
      const chunk = {
        id: 'test:0',
        book: makeBook(),
        index: 0,
        approxTokens: 10,
        charStart: 0,
        charEnd: 100,
        section: null,
        text: 'When price sweeps below the prior swing low then reclaims it, we call this a liquidity sweep.',
        checksum: 'x'.repeat(64),
      };
      const found = svc.extract(chunk);
      assert(found.some((c) => c.conceptId === 'liquidity-sweep'), `expected liquidity-sweep, got ${found.map((c) => c.conceptId).join(',')}`);
    });

    test('confidence is between 0 and 1', () => {
      const chunk = {
        id: 'test:1',
        book: makeBook(),
        index: 0,
        approxTokens: 10,
        charStart: 0,
        charEnd: 100,
        section: null,
        text: 'FOMO and revenge trading are behavioral patterns. FOMO is fear of missing out.',
        checksum: 'y'.repeat(64),
      };
      const found = svc.extract(chunk);
      for (const c of found) {
        assert(c.confidence >= 0 && c.confidence <= 1, `confidence out of range: ${c.confidence}`);
      }
    });

    test('does not match inside a longer word (word boundary)', () => {
      const chunk = {
        id: 'test:2',
        book: makeBook(),
        index: 0,
        approxTokens: 10,
        charStart: 0,
        charEnd: 100,
        section: null,
        text: 'This is capitalization, not capital markets.',
        checksum: 'z'.repeat(64),
      };
      const found = svc.extract(chunk);
      // 'capital' if present as a concept must be matched on standalone word,
      // not inside 'capitalization'. If no such concept exists, this passes trivially.
      for (const c of found) {
        for (const m of c.matches) {
          const before = chunk.text.charAt(m.offset - 1);
          const after = chunk.text.charAt(m.offset + m.matchedText.length);
          if (before && /[a-z0-9]/i.test(before)) {
            throw new Error(`word-boundary violation before match: ...${chunk.text.slice(m.offset - 5, m.offset + 10)}...`);
          }
          if (after && /[a-z0-9]/i.test(after)) {
            throw new Error(`word-boundary violation after match: ...${chunk.text.slice(m.offset, m.offset + m.matchedText.length + 5)}...`);
          }
        }
      }
    });

    test('detectDomains identifies trading-psychology from psychology terms', () => {
      const domains = svc.detectDomains('Fear and greed drive FOMO. Discipline and patience are learned behaviors.');
      assert(domains.some((d) => d.domain === 'trading-psychology'), `expected trading-psychology, got ${JSON.stringify(domains)}`);
    });
  });

  await suite('RelationshipExtractionService', () => {
    const svc = new RelationshipExtractionService();
    test('emits nothing when fewer than 2 concepts', () => {
      const chunk = {
        id: 'r:0',
        book: makeBook(),
        index: 0,
        approxTokens: 10,
        charStart: 0,
        charEnd: 100,
        section: null,
        text: 'only one thing here',
        checksum: 'a'.repeat(64),
      };
      const proposals = svc.extract(chunk, [
        { conceptId: 'a', name: 'A', domain: 'x', confidence: 0.9, matches: [{ offset: 0, matchedText: 'A', isCanonicalName: true }] },
      ]);
      assertEq(proposals.length, 0);
    });

    test('detects a causes-cue between two concepts in one sentence', () => {
      const text = 'The liquidity sweep causes a squeeze in short covering.';
      const chunk = {
        id: 'r:1',
        book: makeBook(),
        index: 0,
        approxTokens: 10,
        charStart: 0,
        charEnd: text.length,
        section: null,
        text,
        checksum: 'b'.repeat(64),
      };
      const sweepIdx = text.indexOf('liquidity sweep');
      const squeezeIdx = text.indexOf('squeeze');
      const proposals = svc.extract(chunk, [
        { conceptId: 'liquidity-sweep', name: 'Liquidity Sweep', domain: 'price-action', confidence: 0.9, matches: [{ offset: sweepIdx, matchedText: 'liquidity sweep', isCanonicalName: true }] },
        { conceptId: 'squeeze', name: 'Squeeze', domain: 'price-action', confidence: 0.9, matches: [{ offset: squeezeIdx, matchedText: 'squeeze', isCanonicalName: true }] },
      ]);
      assert(proposals.some((p) => p.relation === 'causes'), `expected 'causes' proposal, got ${proposals.map((p) => p.relation).join(',')}`);
    });

    test('falls back to co_occurs_with when no cue is present', () => {
      const text = 'Two concepts appear here: alpha and beta and nothing else linking them.';
      const chunk = {
        id: 'r:2',
        book: makeBook(),
        index: 0,
        approxTokens: 10,
        charStart: 0,
        charEnd: text.length,
        section: null,
        text,
        checksum: 'c'.repeat(64),
      };
      const proposals = svc.extract(chunk, [
        { conceptId: 'alpha', name: 'Alpha', domain: 'x', confidence: 0.5, matches: [{ offset: text.indexOf('alpha'), matchedText: 'alpha', isCanonicalName: true }] },
        { conceptId: 'beta', name: 'Beta', domain: 'x', confidence: 0.5, matches: [{ offset: text.indexOf('beta'), matchedText: 'beta', isCanonicalName: true }] },
      ]);
      assert(proposals.some((p) => p.relation === 'co_occurs_with'), `expected co_occurs_with fallback, got ${proposals.map((p) => p.relation).join(',')}`);
    });
  });

  await suite('BookScannerService', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'sentinel-books-'));
    writeFileSync(join(tempRoot, 'a.txt'), 'plain text book content', 'utf8');
    writeFileSync(join(tempRoot, 'b.md'), '# Heading\n\nbody', 'utf8');
    writeFileSync(join(tempRoot, 'c.unknown'), 'ignored', 'utf8');
    const config = makeConfig({ booksDir: tempRoot });
    const scanner = new BookScannerService(config);

    test('scans known extensions and skips unknown', () => {
      const found = scanner.scan();
      assertEq(found.length, 2);
      assert(found.some((f) => f.relativePath === 'a.txt' && f.kind === 'text'));
      assert(found.some((f) => f.relativePath === 'b.md' && f.kind === 'markdown'));
    });
    test('computes sha256 checksums', () => {
      const found = scanner.scan();
      for (const f of found) assertEq(f.checksum.length, 64);
    });
    test('find() returns null for unknown files', () => {
      assertEq(scanner.find('does-not-exist.txt'), null);
    });

    rmSync(tempRoot, { recursive: true, force: true });
  });

  await suite('IngestionStateStore', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sentinel-state-'));
    const stateFile = join(tempDir, 'state.json');
    const config = makeConfig({ stateFile });
    const store = new IngestionStateStore(config);
    store.load();

    const job: IngestionJob = {
      jobId: 'job_test_1',
      bookRelativePath: 'test.pdf',
      bookChecksum: 'a'.repeat(64),
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      metrics: { ...EMPTY_METRICS },
    };

    test('upsert + get roundtrip', () => {
      store.upsert(job);
      const got = store.get(job.jobId);
      assert(got !== null, 'expected job to be retrievable');
      assertEq(got!.jobId, job.jobId);
      assertEq(got!.status, 'queued');
    });

    test('upsert updates existing job', () => {
      const updated: IngestionJob = { ...job, status: 'done' };
      store.upsert(updated);
      const got = store.get(job.jobId);
      assertEq(got!.status, 'done');
    });

    test('findByBook works on relativePath + checksum pair', () => {
      const found = store.findByBook(job.bookRelativePath, job.bookChecksum);
      assert(found !== null, 'expected findByBook to hit');
    });

    test('clearFinished removes done/failed jobs', () => {
      const removed = store.clearFinished();
      assert(removed >= 1, `expected at least 1 finished job removed, got ${removed}`);
      assertEq(store.get(job.jobId), null);
    });

    test('persistence survives a fresh instance', () => {
      store.upsert({ ...job, status: 'queued', jobId: 'job_test_2' });
      const fresh = new IngestionStateStore(config);
      fresh.load();
      const got = fresh.get('job_test_2');
      assert(got !== null, 'expected job to be reloaded from disk');
    });

    rmSync(tempDir, { recursive: true, force: true });
  });

  await suite('LearningConfig', () => {
    test('positive ints override defaults', () => {
      const cfg = loadLearningConfig({
        SENTINEL_LEARNING_CHUNK_CHARS: '1500',
        SENTINEL_LEARNING_MAX_CONCURRENT: '4',
      } as unknown as NodeJS.ProcessEnv);
      assertEq(cfg.chunkChars, 1500);
      assertEq(cfg.maxConcurrentJobs, 4);
    });
    test('invalid values fall back to defaults', () => {
      const cfg = loadLearningConfig({
        SENTINEL_LEARNING_CHUNK_CHARS: 'not-a-number',
      } as unknown as NodeJS.ProcessEnv);
      assert(cfg.chunkChars > 0, 'expected default fallback');
    });
    test('namespace defaults to sentinel-learning', () => {
      const cfg = loadLearningConfig({} as NodeJS.ProcessEnv);
      assertEq(cfg.namespace, 'sentinel-learning');
    });
  });

  console.log(`\n---`);
  console.log(`Results: ${passes} passed, ${failures} failed`);
  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`test runner crashed in suite "${currentSuite}": ${(err as Error).stack ?? err}`);
  process.exit(2);
});
