/**
 * Projects `knowledge-base/` YAML into Postgres.
 *
 *   npm run ontology:seed          # apply
 *   npm run ontology:seed -- --dry # report what would change, write nothing
 *
 * The contract this script must never break (SENTINEL-KNOWLEDGE-GRAPH.md §3):
 * it writes canonical columns only. `learnedWeight`, `supportCount`,
 * `refuteCount`, `observationCount`, `lastObservedAt` and every
 * ConceptObservation row are runtime property and are left untouched, so the
 * ontology can be reseeded any number of times without destroying what
 * Sentinel learned.
 *
 * Concepts removed from YAML are marked `deprecated`, never deleted —
 * CLAUDE.md Rule 1 applied to data. That keeps every past explanation
 * traceable to the knowledge that produced it.
 */
import { PrismaClient } from '@prisma/client';
import { OntologyLoaderService, resolveKnowledgeBaseDir } from '../src/brain/ontology/ontology-loader.service';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry');

async function main(): Promise<void> {
  const root = resolveKnowledgeBaseDir();
  const result = new OntologyLoaderService(root).load();
  const summary = OntologyLoaderService.summarise(result);

  console.log(`knowledge-base: ${root}`);
  console.log(`loaded ${summary.conceptCount} concept(s), ${summary.edgeCount} relation(s)`);

  if (result.issues.length > 0) {
    console.error(`\nrefusing to seed — ${result.issues.length} validation issue(s):\n`);
    for (const issue of result.issues) console.error(`  [${issue.subject}] ${issue.field}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }
  if (DRY_RUN) console.log('\n-- dry run: no writes will be made --');

  const stats = { created: 0, updated: 0, unchanged: 0, deprecated: 0, edgesUpserted: 0, edgesDeprecated: 0 };

  // ---- pass 1: nodes -------------------------------------------------------
  // Nodes first, in full, because edges reference node primary keys and a
  // concept may relate to one defined in a later file.
  const idToPk = new Map<string, string>();

  for (const { concept, sourcePath, checksum } of result.concepts) {
    const existing = await prisma.conceptNode.findUnique({ where: { conceptId: concept.id } });

    if (existing && existing.checksum === checksum && existing.status === concept.status) {
      idToPk.set(concept.id, existing.id);
      stats.unchanged++;
      continue;
    }

    const canonicalFields = {
      domain: concept.domain,
      name: concept.name,
      aliases: concept.aliases,
      status: concept.status,
      maturity: concept.maturity,
      confidence: concept.confidence,
      summary: concept.summary,
      definition: concept.definition,
      explainer: concept.explainer,
      observableWhen: concept.observableWhen,
      examples: concept.examples as never,
      sources: concept.sources,
      tags: concept.tags,
      supersededBy: concept.supersededBy ?? null,
      supersedes: concept.supersedes ?? null,
      origin: 'canonical',
      sourcePath,
      checksum,
    };

    if (DRY_RUN) {
      console.log(`  ${existing ? 'update' : 'create'} ${concept.id}`);
      // Map a placeholder for concepts that don't exist yet, so the edge pass
      // can still count what it would write. Without this a dry run against an
      // empty database reports zero edges, which reads as "no edges to create".
      idToPk.set(concept.id, existing?.id ?? `dry:${concept.id}`);
      existing ? stats.updated++ : stats.created++;
      continue;
    }

    const row = await prisma.conceptNode.upsert({
      where: { conceptId: concept.id },
      // NOTE: `update` deliberately omits observationCount / lastObservedAt —
      // listing them here would silently reset runtime learning on every seed.
      update: canonicalFields,
      create: { conceptId: concept.id, ...canonicalFields },
    });
    idToPk.set(concept.id, row.id);
    existing ? stats.updated++ : stats.created++;
  }

  // ---- pass 2: deprecate nodes no longer present in YAML --------------------
  const yamlIds = new Set(result.concepts.map((c) => c.concept.id));
  const orphanedNodes = await prisma.conceptNode.findMany({
    where: { origin: 'canonical', status: { not: 'deprecated' }, conceptId: { notIn: [...yamlIds] } },
  });
  for (const node of orphanedNodes) {
    console.log(`  deprecate ${node.conceptId} (no longer in knowledge-base/)`);
    if (!DRY_RUN) {
      await prisma.conceptNode.update({ where: { id: node.id }, data: { status: 'deprecated' } });
    }
    stats.deprecated++;
  }

  // ---- pass 3: edges -------------------------------------------------------
  const seenEdgeKeys = new Set<string>();

  for (const { concept } of result.concepts) {
    const fromId = idToPk.get(concept.id);
    if (!fromId) continue;

    for (const rel of concept.relations) {
      const toId = idToPk.get(rel.to);
      if (!toId) continue; // validation already guarantees this resolves
      seenEdgeKeys.add(`${fromId}|${toId}|${rel.type}`);
      if (DRY_RUN) {
        stats.edgesUpserted++;
        continue;
      }

      await prisma.conceptEdge.upsert({
        where: { fromId_toId_relation: { fromId, toId, relation: rel.type } },
        // Canonical columns only. learnedWeight / supportCount / refuteCount
        // are absent by design — see the header contract.
        update: {
          weight: rel.weight,
          note: rel.note ?? null,
          status: concept.status === 'deprecated' ? 'deprecated' : 'canonical',
          origin: 'canonical',
          confidence: concept.confidence,
        },
        create: {
          fromId,
          toId,
          relation: rel.type,
          weight: rel.weight,
          note: rel.note ?? null,
          origin: 'canonical',
          status: concept.status === 'deprecated' ? 'deprecated' : 'canonical',
          confidence: concept.confidence,
        },
      });
      stats.edgesUpserted++;
    }
  }

  // ---- pass 4: deprecate canonical edges dropped from YAML ------------------
  // Learned edges are skipped: they were never in YAML, so their absence is
  // not evidence of removal.
  const canonicalEdges = await prisma.conceptEdge.findMany({
    where: { origin: 'canonical', status: { not: 'deprecated' } },
    select: { id: true, fromId: true, toId: true, relation: true },
  });
  for (const edge of canonicalEdges) {
    if (seenEdgeKeys.has(`${edge.fromId}|${edge.toId}|${edge.relation}`)) continue;
    if (!DRY_RUN) await prisma.conceptEdge.update({ where: { id: edge.id }, data: { status: 'deprecated' } });
    stats.edgesDeprecated++;
  }

  console.log(
    `\nnodes: ${stats.created} created, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.deprecated} deprecated\n` +
      `edges: ${stats.edgesUpserted} upserted, ${stats.edgesDeprecated} deprecated`,
  );
  if (DRY_RUN) console.log('\n-- dry run complete, nothing written --');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
