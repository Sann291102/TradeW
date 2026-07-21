import { Domain, DOMAINS, isDomain } from './domains';
import { isRelationType, RelationType, RELATION_TYPES } from './relations';

/**
 * The shape of one `knowledge-base/<domain>/<id>.yaml` file, plus the
 * validator that guards it.
 *
 * YAML is the canonical source of truth; Postgres is a projection of it (see
 * SENTINEL-KNOWLEDGE-GRAPH.md §3). That means every correctness guarantee has
 * to be enforced here, at parse time, before anything reaches the database —
 * once thousands of concepts exist, a dangling relation or an unknown
 * relation type is invisible in a diff but corrupts every reasoning path that
 * walks through it.
 */

/**
 * `canonical` — reviewed, merged into YAML, fully usable.
 * `proposed`  — surfaced by runtime learning, awaiting human promotion. Held
 *               in the graph and readable by internal tooling, but excluded
 *               from user-facing output until confidence clears the gate.
 * `deprecated`— superseded. Never deleted (CLAUDE.md Rule 1 applied to data),
 *               retained for provenance, excluded from all consumer queries.
 */
export const CONCEPT_STATUSES = ['canonical', 'proposed', 'deprecated'] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

/** How settled the concept is as knowledge, independent of review status. */
export const CONCEPT_MATURITIES = ['established', 'emerging', 'contested'] as const;
export type ConceptMaturity = (typeof CONCEPT_MATURITIES)[number];

export interface ConceptRelation {
  /** Target concept id. Must resolve to a real concept — checked by the loader across all files. */
  to: string;
  type: RelationType;
  /** Author's prior on the strength of this link, 0..1. Runtime learning never overwrites it. */
  weight: number;
  /** Why this link exists. Shown in the graph UI on edge hover. */
  note?: string;
}

export interface ConceptExample {
  title: string;
  context: string;
  outcome: string;
  /** ISO date or free-form period, e.g. '2024-06-04' or 'Mar 2020'. */
  date?: string;
}

export interface Concept {
  id: string;
  name: string;
  domain: Domain;
  aliases: string[];
  status: ConceptStatus;
  maturity: ConceptMaturity;
  /** Author confidence in the concept itself, 0..1. Gates user-facing exposure. */
  confidence: number;
  /** One line. Used as the graph node tooltip and in dense list views. */
  summary: string;
  /** Precise prose definition. The reference text. */
  definition: string;
  /** User-facing educational text Sentinel draws on when explaining an observation. */
  explainer: string;
  /** Observable evidence cues that suggest the concept is present. Never thresholds to act on. */
  observableWhen: string[];
  relations: ConceptRelation[];
  examples: ConceptExample[];
  sources: string[];
  tags: string[];
  /** Set on a `deprecated` concept to point at what replaced it. */
  supersededBy?: string;
  /** Set on a concept that replaced an older one. */
  supersedes?: string;
}

export interface ValidationIssue {
  /** Concept id when known, otherwise the file path. */
  subject: string;
  field: string;
  message: string;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Directive-language lint enforcing CLAUDE.md Rule 2 and ARCHITECTURE.md §1.3
 * — Sentinel is observation and education only, never Buy/Sell/Entry/Target.
 *
 * Deliberately matched on *imperative phrasing*, not on vocabulary. Terms like
 * "buy-side liquidity", "stop-loss clustering" and "target zone" are
 * legitimate analytical nouns and must not trip the lint; "you should buy" and
 * "target: 1450" must. Getting this backwards would either block honest
 * authoring or let advice reach users, so the patterns stay narrow and are
 * unit-testable in isolation.
 */
const DIRECTIVE_PATTERNS: { pattern: RegExp; why: string }[] = [
  { pattern: /\byou\s+(should|must|need\s+to|ought\s+to)\s+(buy|sell|short|enter|exit|hold|book|add|trim)\b/i, why: 'instructs the reader to trade' },
  { pattern: /\b(recommend|advise|suggest)(s|ed|ing)?\s+(buying|selling|shorting|entering|exiting|holding)\b/i, why: 'recommends a trading action' },
  { pattern: /\b(entry|exit|target|stop)\s*(price|level|zone)?\s*[:=]\s*[\d₹$]/i, why: 'states a concrete entry/exit/target level' },
  { pattern: /\bprice\s+target\s+(is|of)\s*[\d₹$]/i, why: 'states a numeric price target' },
  { pattern: /\b(our|my)\s+price\s+target\b/i, why: 'asserts a price target as the platform’s own view' },
  // Sentence-initial imperatives only. Descriptive prose about these behaviours
  // ("the urge to book profits early", "traders who go long into expiry") is
  // legitimate psychology/structure knowledge and must not trip the lint.
  { pattern: /(^|[.!?]\s+)(book|take)\s+profits?\b/i, why: 'imperative instruction to take profit' },
  { pattern: /(^|[.!?]\s+)(buy|sell|short)\s+(now|here|immediately|this\b)/i, why: 'imperative instruction to trade' },
  { pattern: /\bgo\s+(long|short)\s+(here|now)\b/i, why: 'instructs directional positioning' },
];

/** Fields whose text reaches users and therefore must pass the compliance lint. */
const USER_FACING_FIELDS: (keyof Concept)[] = ['summary', 'definition', 'explainer'];

export function lintDirectiveLanguage(subject: string, field: string, text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const { pattern, why } of DIRECTIVE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      issues.push({
        subject,
        field,
        message: `directive language (${why}): "${match[0].trim()}". Sentinel is observation/education only — describe what is observable, not what to do.`,
      });
    }
  }
  return issues;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0);
}

/**
 * Parse and validate one raw YAML document into a Concept.
 *
 * Returns the concept even when issues exist so the loader can report *all*
 * problems across the whole knowledge base in one pass rather than failing on
 * the first bad file — with hundreds of concepts, fail-fast turns a five
 * minute fix into fifty round trips.
 */
export function parseConcept(
  raw: unknown,
  filePath: string,
): { concept: Concept | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { concept: null, issues: [{ subject: filePath, field: '(root)', message: 'file is not a YAML mapping' }] };
  }
  const doc = raw as Record<string, unknown>;
  const subject = asString(doc.id) ?? filePath;

  const id = asString(doc.id);
  if (!id) {
    issues.push({ subject, field: 'id', message: 'required' });
  } else if (!ID_PATTERN.test(id)) {
    issues.push({ subject, field: 'id', message: `must be kebab-case slug, got "${id}"` });
  }

  const name = asString(doc.name);
  if (!name) issues.push({ subject, field: 'name', message: 'required' });

  const domain = doc.domain;
  if (!isDomain(domain)) {
    issues.push({ subject, field: 'domain', message: `must be one of: ${DOMAINS.join(', ')}` });
  }

  const status = (asString(doc.status) ?? 'canonical') as ConceptStatus;
  if (!CONCEPT_STATUSES.includes(status)) {
    issues.push({ subject, field: 'status', message: `must be one of: ${CONCEPT_STATUSES.join(', ')}` });
  }

  const maturity = (asString(doc.maturity) ?? 'established') as ConceptMaturity;
  if (!CONCEPT_MATURITIES.includes(maturity)) {
    issues.push({ subject, field: 'maturity', message: `must be one of: ${CONCEPT_MATURITIES.join(', ')}` });
  }

  const confidenceRaw = doc.confidence;
  const confidence = typeof confidenceRaw === 'number' ? confidenceRaw : 0.7;
  if (typeof confidenceRaw !== 'undefined' && (typeof confidenceRaw !== 'number' || confidence < 0 || confidence > 1)) {
    issues.push({ subject, field: 'confidence', message: 'must be a number between 0 and 1' });
  }

  const summary = asString(doc.summary);
  if (!summary) issues.push({ subject, field: 'summary', message: 'required' });
  else if (summary.length > 220) issues.push({ subject, field: 'summary', message: `must be <= 220 chars, got ${summary.length}` });

  const definition = asString(doc.definition);
  if (!definition) issues.push({ subject, field: 'definition', message: 'required' });

  const explainer = asString(doc.explainer);
  if (!explainer) issues.push({ subject, field: 'explainer', message: 'required — this is the text users actually read' });

  // relations
  const relations: ConceptRelation[] = [];
  const rawRelations = Array.isArray(doc.relations) ? doc.relations : [];
  if (!Array.isArray(doc.relations) && typeof doc.relations !== 'undefined') {
    issues.push({ subject, field: 'relations', message: 'must be a list' });
  }
  const seenRelations = new Set<string>();
  for (const [i, entry] of rawRelations.entries()) {
    const field = `relations[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ subject, field, message: 'must be a mapping with `to` and `type`' });
      continue;
    }
    const rel = entry as Record<string, unknown>;
    const to = asString(rel.to);
    const type = rel.type;
    if (!to) {
      issues.push({ subject, field: `${field}.to`, message: 'required' });
      continue;
    }
    if (!isRelationType(type)) {
      issues.push({ subject, field: `${field}.type`, message: `must be one of: ${RELATION_TYPES.join(', ')}` });
      continue;
    }
    if (to === id) {
      issues.push({ subject, field: `${field}.to`, message: 'a concept cannot relate to itself' });
      continue;
    }
    const key = `${type}:${to}`;
    if (seenRelations.has(key)) {
      issues.push({ subject, field, message: `duplicate relation ${type} -> ${to}` });
      continue;
    }
    seenRelations.add(key);
    const weightRaw = rel.weight;
    const weight = typeof weightRaw === 'number' ? weightRaw : 0.7;
    if (typeof weightRaw !== 'undefined' && (typeof weightRaw !== 'number' || weight < 0 || weight > 1)) {
      issues.push({ subject, field: `${field}.weight`, message: 'must be a number between 0 and 1' });
    }
    relations.push({ to, type, weight, note: asString(rel.note) ?? undefined });
  }

  // examples
  const examples: ConceptExample[] = [];
  const rawExamples = Array.isArray(doc.examples) ? doc.examples : [];
  for (const [i, entry] of rawExamples.entries()) {
    const field = `examples[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ subject, field, message: 'must be a mapping' });
      continue;
    }
    const ex = entry as Record<string, unknown>;
    const title = asString(ex.title);
    const context = asString(ex.context);
    const outcome = asString(ex.outcome);
    if (!title || !context || !outcome) {
      issues.push({ subject, field, message: 'requires title, context and outcome' });
      continue;
    }
    examples.push({ title, context, outcome, date: asString(ex.date) ?? undefined });
  }

  const concept: Concept = {
    id: id ?? '',
    name: name ?? '',
    domain: (isDomain(domain) ? domain : DOMAINS[0]) as Domain,
    aliases: asStringArray(doc.aliases),
    status,
    maturity,
    confidence,
    summary: summary ?? '',
    definition: definition ?? '',
    explainer: explainer ?? '',
    observableWhen: asStringArray(doc.observable_when ?? doc.observableWhen),
    relations,
    examples,
    sources: asStringArray(doc.sources),
    tags: asStringArray(doc.tags),
    supersededBy: asString(doc.superseded_by ?? doc.supersededBy) ?? undefined,
    supersedes: asString(doc.supersedes) ?? undefined,
  };

  // compliance lint over every field whose text can reach a user
  for (const field of USER_FACING_FIELDS) {
    const text = concept[field];
    if (typeof text === 'string' && text.length > 0) {
      issues.push(...lintDirectiveLanguage(subject, field as string, text));
    }
  }
  for (const [i, cue] of concept.observableWhen.entries()) {
    issues.push(...lintDirectiveLanguage(subject, `observable_when[${i}]`, cue));
  }

  if (concept.status === 'deprecated' && !concept.supersededBy) {
    issues.push({ subject, field: 'superseded_by', message: 'a deprecated concept must point at what replaced it' });
  }

  return { concept: id && name ? concept : null, issues };
}
