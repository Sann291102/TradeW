import type { AnnotationKind } from '../types';

/**
 * The declarative language a learned TradingView strategy is expressed in.
 *
 * The governing constraint, inherited from `intelligence/strategy-rules.ts`:
 * **a learned strategy is DATA, never code.** A user-supplied spec composes
 * predicates from the closed vocabulary below; it can never introduce
 * arbitrary logic into the drawing or observation path. That is what makes it
 * safe to accept a strategy definition over HTTP and replay it against live
 * charts — the worst a malformed spec can do is fail validation.
 *
 * Everything here is JSON-serialisable so a spec round-trips through storage,
 * the API and the UI without a parser.
 */

// ---------------------------------------------------------------------------
// Operands — the values a condition can compare
// ---------------------------------------------------------------------------

/** Named quantities resolvable from a live market context. */
export const OPERAND_REFS = [
  'price',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'volume.avg20',
  'ema20',
  'ema50',
  'ema200',
  'vwap',
  'rsi14',
  'macd.histogram',
  'atr14',
  'cpr.pivot',
  'cpr.tc',
  'cpr.bc',
  'support',
  'resistance',
  'openingRange.high',
  'openingRange.low',
  'priorDay.high',
  'priorDay.low',
  'priorDay.close',
  'vix',
] as const;

export type OperandRef = (typeof OPERAND_REFS)[number];

/** A value: either a named market quantity or a literal number. */
export type Operand = { ref: OperandRef } | { value: number };

export const COMPARISONS = ['>', '>=', '<', '<=', 'crosses-above', 'crosses-below', 'within-pct'] as const;
export type Comparison = (typeof COMPARISONS)[number];

/** Structural patterns the geometry engine can detect. */
export const STRUCTURE_PATTERNS = [
  'liquidity-sweep',
  'fair-value-gap',
  'order-block',
  'swing-high-break',
  'swing-low-break',
  'equal-highs',
  'equal-lows',
  'demand-zone-touch',
  'supply-zone-touch',
  'inside-bar',
  'engulfing',
] as const;

export type StructurePattern = (typeof STRUCTURE_PATTERNS)[number];

export const SESSION_PHASES = ['pre-open', 'opening-range', 'first-hour', 'mid-session', 'final-hour'] as const;
export type SessionPhase = (typeof SESSION_PHASES)[number];

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export type RuleCondition =
  | {
      kind: 'compare';
      left: Operand;
      op: Comparison;
      right: Operand;
      /** Required for `within-pct`; the tolerance band. */
      tolerancePct?: number;
      /** Human-readable restatement of this condition, from the user's spec. */
      label?: string;
    }
  | { kind: 'structure'; pattern: StructurePattern; label?: string }
  | { kind: 'session'; phase: SessionPhase; label?: string }
  | {
      kind: 'multiple-of';
      left: Operand;
      /** e.g. volume >= 1.5 × volume.avg20 */
      multiplier: number;
      right: Operand;
      op: '>' | '>=' | '<' | '<=';
      label?: string;
    };

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

/** Where a drawing attaches itself on the chart. */
export const ANCHORS = [
  'recent-swing-lows',
  'recent-swing-highs',
  'nearest-level-above',
  'nearest-level-below',
  'strongest-level',
  'last-swing-leg',
  'nearest-demand-zone',
  'nearest-supply-zone',
  'unswept-liquidity',
  'latest-fair-value-gap',
  'current-close',
  'opening-range',
  'cpr',
  'indicator-series',
] as const;

export type Anchor = (typeof ANCHORS)[number];

export interface DrawingSpec {
  kind: AnnotationKind;
  anchor: Anchor;
  /** Display label. Supports `{price}`, `{level}`, `{ratio}` placeholders. */
  label: string;
  /**
   * Why this drawing exists, in the user's own words. Surfaced verbatim on the
   * annotation as part of its explanation — the strategy author's reasoning is
   * more useful to them than anything the system would generate.
   */
  rationale: string;
  style?: { color?: string; width?: number; dash?: 'solid' | 'dashed' | 'dotted'; opacity?: number };
  /** For projections: distance from the anchor, in ATR multiples. */
  atrMultiple?: number;
  /** For projections: which role this level plays geometrically. */
  role?: 'entry-zone' | 'invalidation' | 'objective';
  /** For objectives: reward multiple of the invalidation distance. */
  rMultiple?: number;
  /** For indicator drawings: which series. */
  indicator?: 'ema' | 'vwap' | 'rsi' | 'macd' | 'cpr';
  /** Indicator period, where applicable. */
  period?: number;
}

// ---------------------------------------------------------------------------
// The learned strategy
// ---------------------------------------------------------------------------

export interface TradingViewStrategySpec {
  /** Stable slug, e.g. `my-orb-retest`. */
  id: string;
  name: string;
  /** What the strategy is, in the author's words. */
  description: string;
  /** Instruments this applies to. Empty means all. */
  symbols: string[];
  /** Timeframes this applies to. Empty means all. */
  timeframes: string[];
  /** ALL conditions must hold for the strategy to be considered matched. */
  conditions: RuleCondition[];
  /** Conditions that, if any hold, invalidate the setup. */
  invalidations: RuleCondition[];
  /** What to draw when the conditions match. */
  drawings: DrawingSpec[];
  /** Directional bias the setup implies. Described, never prescribed. */
  bias: 'bullish' | 'bearish' | 'neutral';
  /** The original text the user supplied, retained verbatim for citation. */
  rawSpec: string;
  version: number;
  learnedAt: string;
  updatedAt: string;
}

export interface SpecValidationIssue {
  field: string;
  message: string;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPERAND_SET = new Set<string>(OPERAND_REFS);
const COMPARISON_SET = new Set<string>(COMPARISONS);
const STRUCTURE_SET = new Set<string>(STRUCTURE_PATTERNS);
const SESSION_SET = new Set<string>(SESSION_PHASES);
const ANCHOR_SET = new Set<string>(ANCHORS);
const ANNOTATION_SET = new Set<string>([
  'trendline', 'support', 'resistance', 'supply-zone', 'demand-zone', 'liquidity-pool',
  'fair-value-gap', 'order-block', 'fibonacci', 'ema', 'vwap', 'rsi', 'macd', 'cpr',
  'opening-range', 'projected-entry', 'projected-invalidation', 'projected-objective', 'marker',
]);

/**
 * Validate a user-supplied spec.
 *
 * Collects every issue rather than throwing on the first, so an author fixing
 * a spec sees the whole list in one response instead of discovering problems
 * one round-trip at a time.
 */
export function validateSpec(raw: unknown): { spec: TradingViewStrategySpec | null; issues: SpecValidationIssue[] } {
  const issues: SpecValidationIssue[] = [];
  const fail = (field: string, message: string) => issues.push({ field, message });

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { spec: null, issues: [{ field: '(root)', message: 'spec must be an object' }] };
  }
  const doc = raw as Record<string, unknown>;

  const id = typeof doc.id === 'string' ? doc.id.trim() : '';
  if (!id) fail('id', 'required');
  else if (!ID_PATTERN.test(id)) fail('id', `must be a kebab-case slug, got "${id}"`);

  const name = typeof doc.name === 'string' ? doc.name.trim() : '';
  if (!name) fail('name', 'required');

  const conditions = validateConditions(doc.conditions, 'conditions', issues);
  const invalidations = validateConditions(doc.invalidations, 'invalidations', issues);

  if (conditions.length === 0) {
    fail('conditions', 'a strategy with no conditions would match every bar — at least one is required');
  }

  const drawings: DrawingSpec[] = [];
  const rawDrawings = Array.isArray(doc.drawings) ? doc.drawings : [];
  if (!Array.isArray(doc.drawings)) fail('drawings', 'must be a list');

  for (const [i, entry] of rawDrawings.entries()) {
    const field = `drawings[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(field, 'must be an object');
      continue;
    }
    const d = entry as Record<string, unknown>;
    if (typeof d.kind !== 'string' || !ANNOTATION_SET.has(d.kind)) {
      fail(`${field}.kind`, `must be one of: ${[...ANNOTATION_SET].join(', ')}`);
      continue;
    }
    if (typeof d.anchor !== 'string' || !ANCHOR_SET.has(d.anchor)) {
      fail(`${field}.anchor`, `must be one of: ${ANCHORS.join(', ')}`);
      continue;
    }
    // The rationale is what makes an annotation auditable. A drawing with no
    // stated reason cannot satisfy "every annotation explains why it is there",
    // so it is rejected rather than defaulted to a generated placeholder.
    const rationale = typeof d.rationale === 'string' ? d.rationale.trim() : '';
    if (!rationale) {
      fail(`${field}.rationale`, 'required — every drawing must state why it is placed');
      continue;
    }

    drawings.push({
      kind: d.kind as AnnotationKind,
      anchor: d.anchor as Anchor,
      label: typeof d.label === 'string' && d.label.trim() ? d.label.trim() : String(d.kind),
      rationale,
      style: typeof d.style === 'object' && d.style !== null ? (d.style as DrawingSpec['style']) : undefined,
      atrMultiple: typeof d.atrMultiple === 'number' ? d.atrMultiple : undefined,
      role: typeof d.role === 'string' ? (d.role as DrawingSpec['role']) : undefined,
      rMultiple: typeof d.rMultiple === 'number' ? d.rMultiple : undefined,
      indicator: typeof d.indicator === 'string' ? (d.indicator as DrawingSpec['indicator']) : undefined,
      period: typeof d.period === 'number' ? d.period : undefined,
    });
  }

  if (drawings.length === 0) {
    fail('drawings', 'a learned drawing spec with no drawings has nothing to reproduce');
  }

  if (issues.length > 0) return { spec: null, issues };

  const now = new Date().toISOString();
  return {
    spec: {
      id,
      name,
      description: typeof doc.description === 'string' ? doc.description.trim() : '',
      symbols: asStringArray(doc.symbols).map((s) => s.toUpperCase()),
      timeframes: asStringArray(doc.timeframes),
      conditions,
      invalidations,
      drawings,
      bias: doc.bias === 'bullish' || doc.bias === 'bearish' ? doc.bias : 'neutral',
      rawSpec: typeof doc.rawSpec === 'string' ? doc.rawSpec : JSON.stringify(raw, null, 2),
      version: typeof doc.version === 'number' ? doc.version : 1,
      learnedAt: typeof doc.learnedAt === 'string' ? doc.learnedAt : now,
      updatedAt: now,
    },
    issues,
  };
}

function validateConditions(raw: unknown, field: string, issues: SpecValidationIssue[]): RuleCondition[] {
  const out: RuleCondition[] = [];
  const list = Array.isArray(raw) ? raw : [];
  if (raw !== undefined && !Array.isArray(raw)) {
    issues.push({ field, message: 'must be a list' });
    return out;
  }

  for (const [i, entry] of list.entries()) {
    const at = `${field}[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ field: at, message: 'must be an object' });
      continue;
    }
    const c = entry as Record<string, unknown>;
    const label = typeof c.label === 'string' ? c.label : undefined;

    switch (c.kind) {
      case 'compare': {
        const left = validateOperand(c.left, `${at}.left`, issues);
        const right = validateOperand(c.right, `${at}.right`, issues);
        if (typeof c.op !== 'string' || !COMPARISON_SET.has(c.op)) {
          issues.push({ field: `${at}.op`, message: `must be one of: ${COMPARISONS.join(', ')}` });
          break;
        }
        if (c.op === 'within-pct' && typeof c.tolerancePct !== 'number') {
          issues.push({ field: `${at}.tolerancePct`, message: 'required when op is "within-pct"' });
          break;
        }
        if (left && right) {
          out.push({
            kind: 'compare',
            left,
            right,
            op: c.op as Comparison,
            tolerancePct: typeof c.tolerancePct === 'number' ? c.tolerancePct : undefined,
            label,
          });
        }
        break;
      }
      case 'structure': {
        if (typeof c.pattern !== 'string' || !STRUCTURE_SET.has(c.pattern)) {
          issues.push({ field: `${at}.pattern`, message: `must be one of: ${STRUCTURE_PATTERNS.join(', ')}` });
          break;
        }
        out.push({ kind: 'structure', pattern: c.pattern as StructurePattern, label });
        break;
      }
      case 'session': {
        if (typeof c.phase !== 'string' || !SESSION_SET.has(c.phase)) {
          issues.push({ field: `${at}.phase`, message: `must be one of: ${SESSION_PHASES.join(', ')}` });
          break;
        }
        out.push({ kind: 'session', phase: c.phase as SessionPhase, label });
        break;
      }
      case 'multiple-of': {
        const left = validateOperand(c.left, `${at}.left`, issues);
        const right = validateOperand(c.right, `${at}.right`, issues);
        if (typeof c.multiplier !== 'number' || !Number.isFinite(c.multiplier)) {
          issues.push({ field: `${at}.multiplier`, message: 'must be a number' });
          break;
        }
        if (typeof c.op !== 'string' || !['>', '>=', '<', '<='].includes(c.op)) {
          issues.push({ field: `${at}.op`, message: 'must be one of: >, >=, <, <=' });
          break;
        }
        if (left && right) {
          out.push({
            kind: 'multiple-of',
            left,
            right,
            multiplier: c.multiplier,
            op: c.op as '>' | '>=' | '<' | '<=',
            label,
          });
        }
        break;
      }
      default:
        issues.push({
          field: `${at}.kind`,
          message: 'must be one of: compare, structure, session, multiple-of',
        });
    }
  }
  return out;
}

function validateOperand(raw: unknown, field: string, issues: SpecValidationIssue[]): Operand | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ field, message: 'must be {ref: "..."} or {value: number}' });
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.ref === 'string') {
    if (!OPERAND_SET.has(o.ref)) {
      issues.push({ field: `${field}.ref`, message: `unknown reference "${o.ref}". Known: ${OPERAND_REFS.join(', ')}` });
      return null;
    }
    return { ref: o.ref as OperandRef };
  }
  if (typeof o.value === 'number' && Number.isFinite(o.value)) return { value: o.value };
  issues.push({ field, message: 'must be {ref: "..."} or {value: number}' });
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0);
}

/** Restate a condition in plain English, for the annotation explanation. */
export function describeCondition(condition: RuleCondition): string {
  if (condition.label) return condition.label;
  switch (condition.kind) {
    case 'compare':
      return `${describeOperand(condition.left)} ${describeComparison(condition.op)} ${describeOperand(condition.right)}` +
        (condition.op === 'within-pct' ? ` (±${condition.tolerancePct}%)` : '');
    case 'structure':
      return `${condition.pattern.replace(/-/g, ' ')} is present`;
    case 'session':
      return `the session is in its ${condition.phase.replace(/-/g, ' ')} phase`;
    case 'multiple-of':
      return `${describeOperand(condition.left)} ${describeComparison(condition.op)} ${condition.multiplier}× ${describeOperand(condition.right)}`;
  }
}

export function describeOperand(operand: Operand): string {
  return 'ref' in operand ? operand.ref.replace(/\./g, ' ') : String(operand.value);
}

function describeComparison(op: Comparison | '>' | '>=' | '<' | '<='): string {
  switch (op) {
    case '>': return 'is above';
    case '>=': return 'is at or above';
    case '<': return 'is below';
    case '<=': return 'is at or below';
    case 'crosses-above': return 'crosses above';
    case 'crosses-below': return 'crosses below';
    case 'within-pct': return 'is within';
    default: return String(op);
  }
}
