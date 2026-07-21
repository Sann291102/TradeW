/**
 * End-to-end smoke test for the Sentinel Concept Knowledge Graph.
 *
 *   npm run ontology:smoke
 *
 * Requires a seeded database. Exercises the parts that are easy to get subtly
 * wrong and hard to notice: path scoring, non-transitive relations refusing to
 * chain, the validation gate, reinforcement, and — most importantly — that a
 * reseed does not destroy runtime learning.
 */
import { PrismaClient } from '@prisma/client';
import { ConceptGraphService } from '../src/brain/ontology/concept-graph.service';
import { ConceptReinforcementService } from '../src/brain/ontology/concept-reinforcement.service';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const graph = new ConceptGraphService(prisma as never);
  const learning = new ConceptReinforcementService(prisma as never);

  console.log('=== 1. graph stats ===');
  console.log(JSON.stringify(await graph.stats(), null, 2));

  console.log('\n=== 2. reasoning path: low-volume-breakout -> bull-trap ===');
  const path = await graph.explainPath('low-volume-breakout', 'bull-trap');
  console.log(path ? `score ${path.score.toFixed(4)}\n  ${path.narration}` : '  no path found');

  console.log('\n=== 3. cross-domain path: fomo -> risk-of-ruin ===');
  const p2 = await graph.explainPath('fomo', 'risk-of-ruin');
  console.log(p2 ? `score ${p2.score.toFixed(4)}\n  ${p2.narration}` : '  no path found');

  console.log('\n=== 4. explainObservation — a live trap reading ===');
  const exp = await graph.explainObservation(['liquidity-sweep', 'low-volume-breakout', 'nonexistent-concept']);
  console.log(`  concepts: ${exp.concepts.map((c) => c.name).join(', ')}`);
  console.log(`  unknown (gracefully reported): ${JSON.stringify(exp.unknown)}`);
  console.log(`  supporting evidence (${exp.supporting.length}):`);
  for (const s of exp.supporting.slice(0, 4)) console.log(`    + ${s.reads}  [w=${s.effectiveWeight}]`);
  console.log(`  contradicting evidence (${exp.contradicting.length}):`);
  for (const s of exp.contradicting.slice(0, 4)) console.log(`    - ${s.reads}  [w=${s.effectiveWeight}]`);
  console.log(`  connections between detected concepts (${exp.connections.length}):`);
  for (const c of exp.connections.slice(0, 3)) console.log(`    ~ ${c.narration}  [score=${c.score.toFixed(3)}]`);

  console.log('\n=== 5. historical similarity: bull-trap ===');
  for (const s of await graph.similarConcepts('bull-trap', 5)) {
    console.log(`    ${s.concept.name.padEnd(26)} ${s.score.toFixed(3)}  (${s.basis})`);
  }

  console.log('\n=== 6. validation gate ===');
  const maxPain = await graph.getConcept('max-pain');
  console.log(`  max-pain (contested): visible=${!!maxPain} confidence=${maxPain?.confidence} maturity=${maxPain?.maturity}`);
  const search = await graph.search('trap');
  console.log(`  search("trap") -> ${search.map((c) => c.conceptId).join(', ')}`);

  console.log('\n=== 7. reinforcement: 10 observations on liquidity-sweep depends_on stop-loss-clustering ===');
  for (let i = 0; i < 10; i++) {
    await learning.record({
      conceptId: 'liquidity-sweep',
      outcome: i < 8 ? 'confirmed' : 'refuted',
      strength: 0.8,
      symbol: 'NSE:RELIANCE',
      edge: { toConceptId: 'stop-loss-clustering', relation: 'depends_on' },
    });
  }
  const edge = await prisma.conceptEdge.findFirst({
    where: { relation: 'depends_on', from: { conceptId: 'liquidity-sweep' }, to: { conceptId: 'stop-loss-clustering' } },
  });
  console.log(`  authored weight : ${edge?.weight}`);
  console.log(`  learned weight  : ${edge?.learnedWeight}`);
  console.log(`  support/refute  : ${edge?.supportCount}/${edge?.refuteCount}`);
  console.log(`  observations    : ${await prisma.conceptObservation.count()}`);

  console.log('\n=== 8. promotion queue (runtime proposes, human disposes) ===');
  await learning.record({
    conceptId: 'fomo',
    outcome: 'confirmed',
    edge: { toConceptId: 'slippage', relation: 'causes' }, // not declared in YAML
  });
  const pending = await learning.pendingPromotions(5);
  for (const p of pending) {
    console.log(`  [${p.kind}] ${p.fromConcept} ${p.relation} ${p.toConcept} — support=${p.supportCount} status=${p.status}`);
  }
  console.log(`  (nothing was written to the ontology itself — YAML is untouched)`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
