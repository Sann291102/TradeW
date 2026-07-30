import { Injectable } from '@nestjs/common';
import { RELATIONS, RelationType } from '../../brain/ontology/relations';
import { Concept } from '../../brain/ontology/concept.schema';
import { EducationalStrategy, StrategyRegistryService } from '../strategy-registry.service';
import { enforceVocabulary } from '../../vocabulary/vocabulary';
import { ConceptSourceService } from './concept-source.service';
import { CourseGeneratorService } from './course-generator.service';
import { courseSpec } from './course-catalog';
import { Lesson, LessonExample, LessonStub, PracticeExercise } from './types';

/**
 * Lesson Generator — turns one concept (or one registry strategy) into a fully
 * structured lesson.
 *
 * Every string is COMPOSED from the concept's own structured fields
 * (definition, explainer, observable cues, examples, graph relations) — which
 * are themselves original educational prose in the knowledge base, never book
 * text. The generator adds framing and derives objectives / mistakes / tips
 * from the graph; it copies nothing. The output passes the same
 * `enforceVocabulary` compliance filter the rest of Sentinel uses, so a lesson
 * can never contain a buy/sell directive.
 *
 * Deterministic: identical knowledge base ⇒ identical lesson, which is what
 * makes caching sound and tests meaningful. An LLM polish layer could sit on
 * top later, but the lesson is complete and correct without one.
 */
@Injectable()
export class LessonGeneratorService {
  constructor(
    private readonly concepts: ConceptSourceService,
    private readonly strategies: StrategyRegistryService,
    private readonly courses: CourseGeneratorService,
  ) {}

  /** Generate a lesson by its composite id `courseId::conceptId`, or null if unknown. */
  generate(lessonId: string): Lesson | null {
    const parsed = parseLessonId(lessonId);
    if (!parsed) return null;
    const { courseId, conceptId } = parsed;
    const spec = courseSpec(courseId);
    if (!spec) return null;

    const stubs = this.courses.lessonStubs(courseId);
    const index = stubs.findIndex((s) => s.conceptId === conceptId);
    if (index === -1) return null;
    const stub = stubs[index];
    const next = stubs[index + 1] ?? null;

    return spec.fromStrategyRegistry
      ? this.fromStrategy(courseId, stub, next)
      : this.fromConcept(courseId, stub, next);
  }

  // --------------------------------------------------------- concept lessons
  private fromConcept(courseId: string, stub: LessonStub, next: LessonStub | null): Lesson | null {
    const c = this.concepts.get(stub.conceptId);
    if (!c) return null;

    const related = this.resolveRelations(c);
    const opposing = related.filter((r) => RELATIONS[r.relation as RelationType]?.polarity === 'opposing');
    const supporting = related.filter((r) => RELATIONS[r.relation as RelationType]?.polarity === 'supporting');

    const tradingExamples: LessonExample[] = c.examples.map((e) => ({
      title: e.title,
      context: e.context,
      outcome: e.outcome,
      date: e.date,
    }));

    const lesson: Lesson = {
      id: stub.id,
      courseId,
      conceptId: c.id,
      title: c.name,
      order: stub.order,
      introduction: clean(
        `${c.name} is a ${c.domain.replace(/-/g, ' ')} concept. ${c.summary} This lesson explains what it is, how it shows up in the market, and how it connects to related ideas.`,
      ),
      learningObjectives: this.objectives(c, related),
      aiExplanation: clean(c.explainer || c.definition),
      visualConcepts: c.observableWhen.map(clean),
      tradingExamples,
      realMarketExamples: tradingExamples
        .filter((e) => e.date)
        .map((e) => clean(`${e.title} (${e.date}): ${e.context} → ${e.outcome}`)),
      commonMistakes: this.commonMistakes(c, opposing),
      practicalTips: this.practicalTips(c, supporting),
      summary: clean(`${c.summary} It relates to ${related.length} other concept(s) in the knowledge graph.`),
      keyTakeaways: this.keyTakeaways(c, related),
      relatedConcepts: related,
      nextLesson: next,
      practice: this.practiceFor(c),
      source: { conceptId: c.id, domain: c.domain },
    };
    return lesson;
  }

  private objectives(c: Concept, related: { name: string }[]): string[] {
    const out = [
      `Define ${c.name} and explain what it measures or describes`,
      `Recognise ${c.name} from its observable cues on a chart`,
    ];
    if (related.length > 0) out.push(`Relate ${c.name} to ${related.slice(0, 2).map((r) => r.name).join(' and ')}`);
    if (c.examples.length > 0) out.push(`Interpret a real market example of ${c.name}`);
    return out.map(clean);
  }

  private commonMistakes(c: Concept, opposing: { name: string; relation: string }[]): string[] {
    const out: string[] = [];
    for (const o of opposing) {
      const verb = o.relation === 'invalidates' ? 'invalidated by' : o.relation === 'contradicts' ? 'in conflict with' : 'weakened by';
      out.push(`Treating ${c.name} as still valid when it is ${verb} ${o.name}`);
    }
    if (c.maturity === 'contested') {
      out.push(`Over-trusting ${c.name} — it is a contested concept; weigh it alongside stronger evidence`);
    }
    out.push(`Reading ${c.name} in isolation instead of confirming it with the wider market context`);
    return out.map(clean);
  }

  private practicalTips(c: Concept, supporting: { name: string; relation: string }[]): string[] {
    const out: string[] = [];
    for (const s of supporting.slice(0, 3)) {
      out.push(`Look for ${s.name} to corroborate ${c.name} before acting on it`);
    }
    if (c.observableWhen.length > 0) out.push(`Confirm the cue: ${c.observableWhen[0]}`);
    out.push('Wait for confirmation rather than anticipating — the concept describes what is observable, not what to do');
    return out.map(clean);
  }

  private keyTakeaways(c: Concept, related: { name: string; relation: string }[]): string[] {
    const out = [clean(c.summary)];
    if (c.observableWhen[0]) out.push(clean(`Spot it when: ${c.observableWhen[0]}`));
    const strongest = related[0];
    if (strongest) out.push(clean(`${c.name} ${RELATIONS[strongest.relation as RelationType]?.reads ?? 'relates to'} ${strongest.name}`));
    out.push('It is an observation to understand, never a signal to trade');
    return out;
  }

  private resolveRelations(c: Concept): { id: string; name: string; relation: string }[] {
    const out: { id: string; name: string; relation: string }[] = [];
    for (const r of c.relations) {
      const target = this.concepts.get(r.to);
      if (target) out.push({ id: target.id, name: target.name, relation: r.type });
    }
    return out;
  }

  // -------------------------------------------------------- strategy lessons
  private fromStrategy(courseId: string, stub: LessonStub, next: LessonStub | null): Lesson | null {
    const s = this.strategies.get(stub.conceptId);
    if (!s) return null;

    const tradingExamples: LessonExample[] = [
      { title: `${s.name} — ideal conditions`, context: s.marketConditions.join('; '), outcome: `Suited to ${s.regimes.join(', ')} regimes.` },
    ];

    const lesson: Lesson = {
      id: stub.id,
      courseId,
      conceptId: s.id,
      title: s.name,
      order: stub.order,
      introduction: clean(`${s.name} is an educational strategy. ${s.purpose}`),
      learningObjectives: [
        `Understand the market conditions ${s.name} is designed for`,
        `Identify the confirmations ${s.name} requires`,
        `Recognise when ${s.name} should NOT be used`,
      ].map(clean),
      aiExplanation: clean(s.educational),
      visualConcepts: s.requiredIndicators.map((i) => clean(`Read the ${i}`)),
      tradingExamples,
      realMarketExamples: [],
      commonMistakes: s.whenNotToUse.map((w) => clean(`Using it when: ${w}`)),
      practicalTips: [...s.confidenceFactors.map((f) => clean(`Confidence rises when: ${f}`)), ...s.riskConsiderations.map(clean)],
      summary: clean(`${s.purpose} Required rules: ${s.ruleMapping.length ? s.ruleMapping.map((r) => r.replace(/_/g, ' ')).join(', ') : 'discretionary confirmation'}.`),
      keyTakeaways: [
        clean(s.purpose),
        clean(`Best in ${s.regimes.join(', ')} regimes`),
        'A study framework, never an instruction to trade',
      ],
      relatedConcepts: [],
      nextLesson: next,
      practice: this.practiceForStrategy(s),
      source: { conceptId: s.id, domain: 'strategy', strategyId: s.id },
    };
    return lesson;
  }

  // ------------------------------------------------------------- practice
  private practiceFor(c: Concept): PracticeExercise | null {
    if (c.observableWhen.length === 0) return null;
    return {
      id: `practice::${c.id}`,
      conceptId: c.id,
      title: `Identify ${c.name} on a live chart`,
      task: `Open a live chart and find where ${c.name} is present right now, using its observable cues.`,
      successCriteria: c.observableWhen.map(clean),
      suggestedSymbols: ['NIFTY', 'BANKNIFTY', 'FINNIFTY'],
      disclaimer: 'Educational identification exercise only. No trade is placed and nothing here is a buy or sell signal.',
    };
  }

  private practiceForStrategy(s: EducationalStrategy): PracticeExercise | null {
    return {
      id: `practice::${s.id}`,
      conceptId: s.id,
      title: `Spot ${s.name} forming on a live chart`,
      task: `On a live chart, look for the conditions ${s.name} needs and judge whether they are present.`,
      successCriteria: s.marketConditions.map(clean),
      suggestedSymbols: ['NIFTY', 'BANKNIFTY', 'FINNIFTY'],
      disclaimer: 'Educational identification exercise only. No trade is placed and nothing here is a buy or sell signal.',
    };
  }
}

export function parseLessonId(lessonId: string): { courseId: string; conceptId: string } | null {
  const idx = lessonId.indexOf('::');
  if (idx === -1) return null;
  const courseId = lessonId.slice(0, idx);
  const conceptId = lessonId.slice(idx + 2);
  if (!courseId || !conceptId) return null;
  return { courseId, conceptId };
}

/** All user-facing lesson prose passes the shared compliance filter. */
function clean(text: string): string {
  return enforceVocabulary(text).clean;
}
