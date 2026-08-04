/* eslint-disable no-console */
import { CorpusScannerService } from '../src/sentinel-intelligence/knowledge/corpus-scanner.service';
import { CorpusIngestionService } from '../src/sentinel-intelligence/knowledge/corpus-ingestion.service';
import { KnowledgeIndexService } from '../src/sentinel-intelligence/knowledge/knowledge-index.service';
import { ReasoningGraphService } from '../src/sentinel-intelligence/knowledge/reasoning-graph.service';
import { DocumentParserService } from '../src/learning/document-parser.service';
import { OntologyLoaderService, resolveKnowledgeBaseDir } from '../src/brain/ontology/ontology-loader.service';
import { RequestParserService } from '../src/sentinel-intelligence/understanding/request-parser.service';
import { TaskDecomposerService } from '../src/sentinel-intelligence/understanding/task-decomposer.service';
import { loadSentinelIntelligenceConfig } from '../src/sentinel-intelligence/si.config';

/**
 * End-to-end smoke test for the SentinelIntelligence knowledge substrate.
 *
 * Deliberately constructs the services by hand instead of booting Nest: this
 * exercises the parts that need NO database, no market feed and no LLM — the
 * corpus scan, the parse/chunk/index pipeline, ontology grounding, retrieval
 * with real citations, request understanding and task decomposition. That is
 * the half that must work on a laptop with nothing running, and this script
 * proves it does against the real repository corpus.
 *
 *   npm run si:test          -w @tradew/sentinel
 *   npm run si:test -- --full   (re-parse every document, ignoring checksums)
 *
 * Runtime is dominated by PDF parsing on a cold index — expect a minute or two
 * for the full book corpus, then seconds on subsequent runs.
 */
async function main() {
  const force = process.argv.includes('--full');
  const config = loadSentinelIntelligenceConfig();

  console.log('SentinelIntelligence — knowledge substrate smoke test');
  console.log(`repo root: ${config.repoRoot}`);
  console.log(`corpus roots: ${config.corpusRoots.map((r) => `${r.path} (${r.kind})`).join(', ')}\n`);

  // ---- 1. scan --------------------------------------------------------
  const scanner = new CorpusScannerService(config);
  const scan = await scanner.scan();

  console.log(`[scan] ${scan.documents.length} documents in ${scan.durationMs}ms`);
  const byKind = new Map<string, number>();
  for (const doc of scan.documents) byKind.set(doc.sourceKind, (byKind.get(doc.sourceKind) ?? 0) + 1);
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`         ${String(count).padStart(4)}  ${kind}`);
  }
  if (scan.missingRoots.length > 0) console.log(`[scan] roots absent: ${scan.missingRoots.join(', ')}`);
  if (scan.skipped.length > 0) console.log(`[scan] skipped ${scan.skipped.length} file(s)`);
  if (scan.documents.length === 0) {
    console.error('\nFAIL: no documents found. Check SI_REPO_ROOT and the corpus roots above.');
    process.exit(1);
  }

  // ---- 2. ingest ------------------------------------------------------
  const index = new KnowledgeIndexService();
  const ontology = new OntologyLoaderService(resolveKnowledgeBaseDir());
  const graph = new ReasoningGraphService(ontology, index);
  const ingestion = new CorpusIngestionService(config, scanner, new DocumentParserService(), index, graph);

  console.log(`\n[ingest] parsing and indexing${force ? ' (forced full re-parse)' : ''}…`);
  const report = await ingestion.ingest({ force });

  console.log(
    `[ingest] ${report.chunksIndexed} chunks from ${report.scanned} documents ` +
      `(${report.parsed} parsed, ${report.unchanged} unchanged, ${report.failed.length} failed) in ${report.durationMs}ms`,
  );
  for (const failure of report.failed.slice(0, 5)) {
    console.log(`         FAILED ${failure.path}: ${failure.error}`);
  }

  // ---- 3. ontology grounding ------------------------------------------
  const graphStats = graph.stats();
  console.log(
    `\n[graph]  ${graphStats.concepts} canonical concepts, ${graphStats.edges} edges, ` +
      `${graphStats.grounded} grounded in the corpus`,
  );

  // ---- 4. retrieval with real citations --------------------------------
  const queries = [
    'liquidity sweep stop hunt above the swing high',
    'position sizing and risk of ruin',
    'opening range breakout first thirty minutes',
    'revenge trading after a loss',
    'open interest max pain option writers',
  ];

  console.log('\n[cite]   retrieval against the real corpus:');
  let citationsFound = 0;
  for (const query of queries) {
    const citations = index.cite(query, { limit: 2, preferKinds: ['book', 'knowledge-base'] });
    citationsFound += citations.length;
    console.log(`\n  "${query}"`);
    if (citations.length === 0) {
      console.log('    (no citation found)');
      continue;
    }
    for (const citation of citations) {
      console.log(`    ${citation.sourceTitle} — ${citation.locator}  [relevance ${citation.relevance.toFixed(3)}]`);
      console.log(`      "${citation.quote.slice(0, 150)}${citation.quote.length > 150 ? '…' : ''}"`);
      console.log(`      ${citation.sourcePath} @ ${citation.charStart}-${citation.charEnd}`);
    }
  }

  // ---- 5. understanding + decomposition -------------------------------
  const requestParser = new RequestParserService(graph);
  const decomposer = new TaskDecomposerService();

  const utterances = [
    'what is bank nifty doing on the 5 min',
    'NIFTY 50 24300 call for 21st July — does my ORB setup confirm',
    'how risky is BANKNIFTY right now for a conservative swing trader',
    'draw the chart for FINNIFTY with VWAP and fibonacci',
  ];

  console.log('\n[parse]  request understanding:');
  for (const text of utterances) {
    const understood = requestParser.parse({ userId: 'smoke', query: text });
    const plan = decomposer.decompose(understood, { userId: 'smoke', query: text });
    console.log(`\n  "${text}"`);
    console.log(
      `    -> ${understood.market.symbol} ${understood.timeframe} intent=${understood.intent} ` +
        `strike=${understood.strike ?? '-'} right=${understood.right ?? '-'} ` +
        `expiry=${understood.expiry ? understood.expiry.toISOString().slice(0, 10) : '-'} ` +
        `style=${understood.style} risk=${understood.riskProfile} confidence=${understood.parseConfidence}`,
    );
    if (understood.indicators.length) console.log(`    indicators: ${understood.indicators.join(', ')}`);
    if (understood.strategyIds.length) console.log(`    strategies: ${understood.strategyIds.join(', ')}`);
    console.log(`    plan: ${plan.subtasks.length} subtask(s) -> ${plan.subtasks.map((s) => s.agent).join(', ')}`);
    for (const skip of plan.skipped) console.log(`    skipped ${skip.agent}: ${skip.reason}`);
    for (const assumption of understood.assumptions) {
      console.log(`    assumed ${String(assumption.field)}=${assumption.value} — ${assumption.reason}`);
    }
  }

  // ---- verdict ---------------------------------------------------------
  const ok = report.chunksIndexed > 0 && citationsFound > 0 && graphStats.concepts > 0;
  console.log(
    `\n${ok ? 'PASS' : 'FAIL'}: ${report.chunksIndexed} chunks indexed, ${citationsFound} citations resolved, ` +
      `${graphStats.concepts} concepts loaded.`,
  );
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
