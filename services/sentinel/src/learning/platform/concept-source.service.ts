import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OntologyLoaderService } from '../../brain/ontology/ontology-loader.service';
import { Concept } from '../../brain/ontology/concept.schema';
import { Domain } from '../../brain/ontology/domains';

/**
 * Concept Source — the single, cached read of the concept ontology for the
 * Learning Platform.
 *
 * The generators (course, lesson, quiz, flashcard) all need full Concept
 * objects grouped by domain. OntologyLoaderService reads and validates the
 * knowledge-base from disk on every `load()`, so calling it per-generator
 * per-request would re-parse ~66 YAML files many times over. This service
 * loads it ONCE at boot and exposes indexed queries, which is the
 * "reuse, don't duplicate extraction" requirement made concrete.
 *
 * It reuses OntologyLoaderService verbatim — it does not re-implement parsing
 * or validation. Only canonical, non-deprecated concepts are surfaced to
 * learners (a deprecated concept is retained in the graph for provenance but
 * must not become a lesson).
 */
@Injectable()
export class ConceptSourceService implements OnModuleInit {
  private readonly logger = new Logger(ConceptSourceService.name);
  private byId = new Map<string, Concept>();
  private byDomain = new Map<string, Concept[]>();
  private loadedAt = 0;

  constructor(private readonly loader: OntologyLoaderService) {}

  onModuleInit(): void {
    this.reload();
  }

  /** Re-read the ontology from disk (used by the admin "Refresh Knowledge" action). */
  reload(): { concepts: number; domains: number } {
    const result = this.loader.load();
    const byId = new Map<string, Concept>();
    const byDomain = new Map<string, Concept[]>();
    for (const { concept } of result.concepts) {
      if (concept.status === 'deprecated') continue; // provenance only, never a lesson
      byId.set(concept.id, concept);
      const list = byDomain.get(concept.domain) ?? [];
      list.push(concept);
      byDomain.set(concept.domain, list);
    }
    // Stable ordering inside a domain: canonical established concepts first,
    // then by confidence, then alphabetically — deterministic across reloads.
    for (const [domain, list] of byDomain) {
      list.sort(
        (a, b) =>
          maturityRank(a.maturity) - maturityRank(b.maturity) ||
          b.confidence - a.confidence ||
          a.name.localeCompare(b.name),
      );
      byDomain.set(domain, list);
    }
    this.byId = byId;
    this.byDomain = byDomain;
    this.loadedAt = Date.now();
    this.logger.log(`concept source: ${byId.size} concepts across ${byDomain.size} domains`);
    return { concepts: byId.size, domains: byDomain.size };
  }

  get(id: string): Concept | null {
    return this.byId.get(id) ?? null;
  }

  inDomain(domain: Domain | string): Concept[] {
    return [...(this.byDomain.get(domain) ?? [])];
  }

  inDomains(domains: (Domain | string)[]): Concept[] {
    const seen = new Set<string>();
    const out: Concept[] = [];
    for (const d of domains) {
      for (const c of this.inDomain(d)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
      }
    }
    return out;
  }

  all(): Concept[] {
    return [...this.byId.values()];
  }

  /** Concepts that carry at least one dated example — the source for case studies. */
  withExamples(): Concept[] {
    return this.all().filter((c) => c.examples.length > 0);
  }

  size(): number {
    return this.byId.size;
  }

  lastLoadedAt(): number {
    return this.loadedAt;
  }
}

function maturityRank(m: Concept['maturity']): number {
  return m === 'established' ? 0 : m === 'emerging' ? 1 : 2;
}
