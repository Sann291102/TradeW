import { Injectable } from '@nestjs/common';
import { Concept } from '../../brain/ontology/concept.schema';
import { StrategyRegistryService } from '../strategy-registry.service';
import { ConceptSourceService } from './concept-source.service';
import { COURSE_CATALOG, CourseSpec, courseSpec } from './course-catalog';
import { Course, LessonStub } from './types';

/**
 * Course Generator — builds every learning path from the knowledge graph and
 * the strategy registry. Lesson counts are the number of concepts (or
 * strategies) resolved for a course; nothing is hardcoded.
 *
 * A course whose domains contain no concepts yet is still returned, with a
 * lessonCount of 0 and an honest "coming soon as the knowledge base grows"
 * summary — the catalogue never lies about how much material exists.
 */
@Injectable()
export class CourseGeneratorService {
  constructor(
    private readonly concepts: ConceptSourceService,
    private readonly strategies: StrategyRegistryService,
  ) {}

  /** All courses, ordered, with generated lesson stubs and counts. */
  listCourses(): Course[] {
    return COURSE_CATALOG.slice()
      .sort((a, b) => a.order - b.order)
      .map((spec) => this.buildCourse(spec));
  }

  getCourse(courseId: string): Course | null {
    const spec = courseSpec(courseId);
    return spec ? this.buildCourse(spec) : null;
  }

  /** The lesson stubs for a course — used by the lesson generator to resolve neighbours. */
  lessonStubs(courseId: string): LessonStub[] {
    const spec = courseSpec(courseId);
    return spec ? this.buildStubs(spec) : [];
  }

  private buildCourse(spec: CourseSpec): Course {
    const stubs = this.buildStubs(spec);
    const domains = spec.fromStrategyRegistry
      ? ['strategy']
      : spec.fromExamples
        ? ['mixed']
        : spec.domains;
    return {
      id: spec.id,
      name: spec.name,
      tier: spec.tier,
      free: spec.free,
      lessonCount: stubs.length,
      summary: this.summarise(spec, stubs.length),
      lessons: stubs,
      source: {
        kind: spec.fromStrategyRegistry ? 'strategy' : spec.fromExamples ? 'mixed' : 'domain',
        domains,
      },
    };
  }

  private buildStubs(spec: CourseSpec): LessonStub[] {
    if (spec.fromStrategyRegistry) {
      return this.strategies
        .list()
        .sort((a, b) => a.order - b.order)
        .map((s, i) => ({ id: `${spec.id}::${s.id}`, title: s.name, conceptId: s.id, order: i + 1 }));
    }
    const source: Concept[] = spec.fromExamples
      ? this.concepts.withExamples()
      : this.concepts.inDomains(spec.domains);
    return source.map((c, i) => ({ id: `${spec.id}::${c.id}`, title: c.name, conceptId: c.id, order: i + 1 }));
  }

  private summarise(spec: CourseSpec, count: number): string {
    if (count === 0) {
      return `${spec.name} lessons are generated from the knowledge base as concepts are added. None are available yet.`;
    }
    if (spec.fromStrategyRegistry) {
      return `${count} strategy lessons, each generated from the Strategy Registry with its confirmations, failure modes and market fit.`;
    }
    if (spec.fromExamples) {
      return `${count} case-study lessons built from documented market examples across the knowledge graph.`;
    }
    const domainList = spec.domains.join(', ');
    return `${count} lessons generated from the ${domainList} knowledge — definitions, examples and how each concept is read in the market.`;
  }
}
