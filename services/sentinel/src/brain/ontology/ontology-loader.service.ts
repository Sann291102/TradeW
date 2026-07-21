import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join, resolve } from 'path';
import { Concept, parseConcept, ValidationIssue } from './concept.schema';
import { DOMAINS, isDomain } from './domains';
import { RELATIONS } from './relations';

export interface LoadedConcept {
  concept: Concept;
  /** Repo-relative path, stored on the node so a row traces back to its source file. */
  sourcePath: string;
  /** sha256 of the raw file, used to skip untouched rows on reseed. */
  checksum: string;
}

export interface OntologyLoadResult {
  concepts: LoadedConcept[];
  issues: ValidationIssue[];
  /** Files found and parsed, including ones that failed validation. */
  filesScanned: number;
}

/**
 * Reads `knowledge-base/` from disk, validates every concept, and resolves
 * relations across the whole set.
 *
 * Cross-file checks (dangling relation targets, orphan concepts) can only
 * happen once everything is loaded, which is why this collects issues across
 * the entire corpus and reports them together rather than throwing on the
 * first bad file. At thousands of concepts, fail-fast would turn one fix into
 * many round trips.
 */
@Injectable()
export class OntologyLoaderService {
  private readonly logger = new Logger(OntologyLoaderService.name);

  constructor(private readonly rootDir: string = resolveKnowledgeBaseDir()) {}

  load(): OntologyLoadResult {
    const issues: ValidationIssue[] = [];
    const concepts: LoadedConcept[] = [];
    let filesScanned = 0;

    if (!existsSync(this.rootDir)) {
      return {
        concepts: [],
        filesScanned: 0,
        issues: [{ subject: this.rootDir, field: '(root)', message: 'knowledge-base directory not found' }],
      };
    }

    const byId = new Map<string, LoadedConcept>();

    for (const domain of DOMAINS) {
      const domainDir = join(this.rootDir, domain);
      if (!existsSync(domainDir)) continue;

      for (const file of readdirSync(domainDir)) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
        const fullPath = join(domainDir, file);
        if (!statSync(fullPath).isFile()) continue;
        filesScanned++;

        const sourcePath = `knowledge-base/${domain}/${file}`;
        const rawText = readFileSync(fullPath, 'utf8');

        let doc: unknown;
        try {
          doc = parseYaml(rawText);
        } catch (err) {
          issues.push({ subject: sourcePath, field: '(yaml)', message: `unparseable YAML: ${(err as Error).message}` });
          continue;
        }

        const { concept, issues: fileIssues } = parseConcept(doc, sourcePath);
        issues.push(...fileIssues);
        if (!concept) continue;

        // filename and declared domain must agree with location on disk —
        // otherwise a concept silently lives in one domain and reports another
        const expectedFile = `${concept.id}.yaml`;
        if (file !== expectedFile && file !== `${concept.id}.yml`) {
          issues.push({ subject: concept.id, field: 'id', message: `id must match filename — expected ${expectedFile}, found ${file}` });
        }
        if (concept.domain !== domain) {
          issues.push({ subject: concept.id, field: 'domain', message: `declares domain "${concept.domain}" but lives in ${domain}/` });
        }
        if (byId.has(concept.id)) {
          issues.push({ subject: concept.id, field: 'id', message: `duplicate id, also defined in ${byId.get(concept.id)!.sourcePath}` });
          continue;
        }

        const loaded: LoadedConcept = {
          concept,
          sourcePath,
          checksum: createHash('sha256').update(rawText).digest('hex'),
        };
        byId.set(concept.id, loaded);
        concepts.push(loaded);
      }
    }

    issues.push(...this.crossCheck(byId));
    return { concepts, issues, filesScanned };
  }

  /** Checks that can only run with the full corpus in hand. */
  private crossCheck(byId: Map<string, LoadedConcept>): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    // A concept with no edge in either direction cannot be reasoned over —
    // it would sit in the graph as an unreachable island. SENTINEL-KNOWLEDGE-GRAPH.md §4.
    const hasInboundEdge = new Set<string>();

    for (const { concept, sourcePath } of byId.values()) {
      for (const rel of concept.relations) {
        if (!byId.has(rel.to)) {
          issues.push({
            subject: concept.id,
            field: `relations -> ${rel.to}`,
            message: `dangling relation target "${rel.to}" (${sourcePath}) — no concept with that id exists`,
          });
          continue;
        }
        hasInboundEdge.add(rel.to);

        // A symmetric relation declared from both sides produces two edges for
        // one fact, which then double-reports in every explanation that walks
        // it. Declare it once; traversal reads edges in both directions.
        if (RELATIONS[rel.type].symmetric) {
          const other = byId.get(rel.to)!;
          const mirrored = other.concept.relations.some((r) => r.to === concept.id && r.type === rel.type);
          // Report once, on the alphabetically-first id, so the pair yields one issue not two.
          if (mirrored && concept.id < rel.to) {
            issues.push({
              subject: concept.id,
              field: `relations -> ${rel.to}`,
              message:
                `"${rel.type}" is symmetric and is declared on both sides (also in ${other.sourcePath}). ` +
                'Remove one — two edges for one fact double-report in explanations.',
            });
          }
        }
      }
      if (concept.supersededBy && !byId.has(concept.supersededBy)) {
        issues.push({ subject: concept.id, field: 'superseded_by', message: `points at unknown concept "${concept.supersededBy}"` });
      }
    }

    for (const { concept } of byId.values()) {
      if (concept.relations.length === 0 && !hasInboundEdge.has(concept.id)) {
        issues.push({
          subject: concept.id,
          field: 'relations',
          message: 'orphan — no outbound relations and nothing links to it; unreachable by any reasoning path',
        });
      }
    }
    return issues;
  }

  /** Summary counts for the validation CLI and the seeding report. */
  static summarise(result: OntologyLoadResult) {
    const byDomain: Record<string, number> = {};
    const byRelation: Record<string, number> = {};
    let edgeCount = 0;
    for (const { concept } of result.concepts) {
      byDomain[concept.domain] = (byDomain[concept.domain] ?? 0) + 1;
      for (const rel of concept.relations) {
        byRelation[rel.type] = (byRelation[rel.type] ?? 0) + 1;
        edgeCount++;
      }
    }
    return { byDomain, byRelation, edgeCount, conceptCount: result.concepts.length };
  }
}

/**
 * Resolves `knowledge-base/` by walking up from this file. Works from
 * `src/` under ts-node and from `dist/` after a build, without either needing
 * to know how deep it is. `KNOWLEDGE_BASE_DIR` overrides for deployments where
 * the ontology ships separately from the service.
 */
export function resolveKnowledgeBaseDir(): string {
  const override = process.env.KNOWLEDGE_BASE_DIR;
  if (override) return resolve(override);

  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'knowledge-base');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the conventional monorepo location so the error message names
  // a real path rather than wherever the walk happened to stop.
  return resolve(__dirname, '../../../../../knowledge-base');
}

/** Guard used by the validator to keep the docs table and the code in sync. */
export function knownRelationTypes(): string[] {
  return Object.keys(RELATIONS);
}

export { isDomain };
