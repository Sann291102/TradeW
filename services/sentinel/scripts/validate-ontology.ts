/**
 * Validates `knowledge-base/` without touching the database.
 *
 * Deliberately DB-free so it can run in CI, in a fresh clone, or as a
 * pre-commit check — the ontology is a source artefact and its correctness
 * should not depend on Postgres being up.
 *
 *   npm run ontology:validate
 *
 * Exits non-zero if any concept fails validation, so it can gate a build.
 */
import { OntologyLoaderService, resolveKnowledgeBaseDir } from '../src/brain/ontology/ontology-loader.service';

function main(): void {
  const root = resolveKnowledgeBaseDir();
  const loader = new OntologyLoaderService(root);
  const result = loader.load();
  const summary = OntologyLoaderService.summarise(result);

  console.log(`knowledge-base: ${root}`);
  console.log(`scanned ${result.filesScanned} file(s) -> ${summary.conceptCount} concept(s), ${summary.edgeCount} relation(s)\n`);

  console.log('concepts by domain');
  for (const [domain, count] of Object.entries(summary.byDomain).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${domain.padEnd(24)} ${count}`);
  }

  console.log('\nrelations by type');
  for (const [relation, count] of Object.entries(summary.byRelation).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${relation.padEnd(24)} ${count}`);
  }

  if (result.issues.length === 0) {
    console.log('\nOK — no validation issues.');
    return;
  }

  console.error(`\n${result.issues.length} validation issue(s):\n`);
  for (const issue of result.issues) {
    console.error(`  [${issue.subject}] ${issue.field}: ${issue.message}`);
  }
  process.exitCode = 1;
}

main();
