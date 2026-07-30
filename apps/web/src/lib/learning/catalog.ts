import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseFrontmatter, splitFrontmatter, type ParsedValue } from './frontmatter';
import type { LegAction, LegExpiry, LegKind, Lesson, NetFlow, Strategy, StrategyLeg, Tier } from './types';

/**
 * Reads `docs/learning/` and returns the typed lesson catalog.
 *
 * Server-only, and read at build time — the learning and trade routes are
 * statically generated, so the markdown is inlined into the build output and
 * `docs/` is never needed at runtime. This keeps one source of truth (the
 * markdown) instead of a generated TS module that can drift from it.
 *
 * The `node:fs` import is what keeps this off the client: pulling this module
 * into a client component fails the build rather than shipping the whole
 * catalog to the browser. (The `server-only` package would state that intent
 * more clearly, but it is not a dependency of this app.)
 *
 * Every validation failure throws. A malformed lesson fails the build rather
 * than disappearing from the catalog, because a strategy that silently
 * vanishes is far harder to notice than one that breaks the page.
 */

/** `docs/learning`, resolved from the Next.js app root (`apps/web`). */
const LEARNING_ROOT = join(process.cwd(), '..', '..', 'docs', 'learning');

/** Index/meta documents that carry no frontmatter and are not lessons. */
const NON_LESSON = new Set(['README.md', 'TAXONOMY.md']);

const LEG_ACTIONS = new Set<LegAction>(['BUY', 'SELL']);
const LEG_KINDS = new Set<LegKind>(['CE', 'PE', 'FUT', 'EQ']);
const LEG_EXPIRIES = new Set<LegExpiry>(['near', 'next', 'far']);
const NET_FLOWS = new Set<NetFlow>(['debit', 'credit', 'zero']);
const TIERS = new Set<Tier>(['beginner', 'intermediate', 'advanced']);

const STRIKE_RE = /^ATM(?:([+-])(\d+))?$/;

function fail(file: string, message: string): never {
  throw new Error(`Learning catalog — ${file}: ${message}`);
}

function str(value: ParsedValue | undefined, file: string, key: string): string {
  if (typeof value !== 'string') fail(file, `"${key}" must be a string`);
  const trimmed = value.trim();
  if (!trimmed) fail(file, `"${key}" is empty`);
  return trimmed;
}

function optionalStr(value: ParsedValue | undefined, file: string, key: string): string | undefined {
  if (value === undefined) return undefined;
  return str(value, file, key);
}

/** "ATM" -> 0, "ATM+2" -> 2, "ATM-3" -> -3. Anything else throws. */
function parseStrikeOffset(raw: string, file: string): number {
  const match = STRIKE_RE.exec(raw);
  if (!match) fail(file, `strike "${raw}" must be ATM, ATM+n or ATM-n`);
  if (!match[1]) return 0;
  return match[1] === '-' ? -Number(match[2]) : Number(match[2]);
}

function parseLegs(value: ParsedValue | undefined, file: string): StrategyLeg[] {
  if (!Array.isArray(value)) fail(file, '"legs" must be a list');
  if (!value.length) fail(file, '"legs" is empty');

  return value.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(file, `leg ${i + 1} must be a map`);
    const leg = entry as Record<string, ParsedValue>;
    const where = `leg ${i + 1}`;

    const action = str(leg.action, file, `${where} action`) as LegAction;
    if (!LEG_ACTIONS.has(action)) fail(file, `${where} action "${action}" must be BUY or SELL`);

    const kind = str(leg.kind, file, `${where} kind`) as LegKind;
    if (!LEG_KINDS.has(kind)) fail(file, `${where} kind "${kind}" must be CE, PE, FUT or EQ`);

    const strike = str(leg.strike, file, `${where} strike`);
    const strikeOffset = parseStrikeOffset(strike, file);

    const ratioRaw = str(leg.ratio, file, `${where} ratio`);
    const ratio = Number(ratioRaw);
    if (!Number.isFinite(ratio) || ratio <= 0) fail(file, `${where} ratio "${ratioRaw}" must be a positive number`);

    const expiry = (optionalStr(leg.expiry, file, `${where} expiry`) ?? 'near') as LegExpiry;
    if (!LEG_EXPIRIES.has(expiry)) fail(file, `${where} expiry "${expiry}" must be near, next or far`);

    return { action, kind, strike, strikeOffset, ratio, expiry };
  });
}

function parseGreeks(value: ParsedValue | undefined, file: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(file, '"greeks" must be a map');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, ParsedValue>)) out[k] = str(v, file, `greeks.${k}`);
  return out;
}

function markdownFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFilesIn(full));
    else if (entry.endsWith('.md') && !NON_LESSON.has(entry)) out.push(full);
  }
  return out;
}

interface Catalog {
  strategies: Strategy[];
  lessons: Lesson[];
}

function build(): Catalog {
  const strategies: Strategy[] = [];
  const lessons: Lesson[] = [];
  const seen = new Map<string, string>();

  for (const absolute of markdownFilesIn(LEARNING_ROOT).sort()) {
    // Posix-style, repo-relative, so it reads the same on any platform.
    const path = join('docs', 'learning', relative(LEARNING_ROOT, absolute)).split(sep).join('/');
    const split = splitFrontmatter(readFileSync(absolute, 'utf8'));
    if (!split) fail(path, 'missing frontmatter');

    const fm = parseFrontmatter(split.frontmatter, path);

    const id = str(fm.id, path, 'id');
    const expectedId = path.split('/').pop()!.replace(/\.md$/, '');
    if (id !== expectedId) fail(path, `id "${id}" must match the filename "${expectedId}"`);
    if (seen.has(id)) fail(path, `duplicate id "${id}", already used by ${seen.get(id)}`);
    seen.set(id, path);

    const tier = str(fm.tier, path, 'tier') as Tier;
    if (!TIERS.has(tier)) fail(path, `tier "${tier}" must be beginner, intermediate or advanced`);

    const common = {
      id,
      name: str(fm.name, path, 'name'),
      category: str(fm.category, path, 'category'),
      tier,
      summary: str(fm.summary, path, 'summary'),
      concept: optionalStr(fm.concept, path, 'concept'),
      path,
      // The lesson prose itself. Without this the app can show a strategy's
      // shape but never explain it, which is the whole point of the Hub.
      body: split.body.trim(),
    };

    if (fm.legs === undefined) {
      lessons.push(common);
      continue;
    }

    const net = str(fm.net, path, 'net') as NetFlow;
    if (!NET_FLOWS.has(net)) fail(path, `net "${net}" must be debit, credit or zero`);

    strategies.push({
      ...common,
      legs: parseLegs(fm.legs, path),
      net,
      outlook: str(fm.outlook, path, 'outlook'),
      maxProfit: str(fm.maxProfit, path, 'maxProfit'),
      maxLoss: str(fm.maxLoss, path, 'maxLoss'),
      breakeven: str(fm.breakeven, path, 'breakeven'),
      greeks: parseGreeks(fm.greeks, path),
      chartNote: str(fm.chartNote, path, 'chartNote'),
    });
  }

  return { strategies, lessons };
}

/**
 * Memoised in production, re-read every call in development.
 *
 * The markdown lives outside Next's module graph, so nothing invalidates this
 * when a lesson is edited — with an unconditional cache the dev server served
 * the copy it read at boot and a lesson edit only appeared after a restart,
 * which makes authoring miserable. Re-reading in dev costs a few milliseconds
 * on a route that is statically generated in production anyway.
 *
 * A plain module-level cache rather than React's `cache()`, which only exists
 * in the react-server bundle and would make this module unloadable from a
 * plain Node script (it is covered by a standalone test).
 */
let catalog: Catalog | null = null;

export function getCatalog(): Catalog {
  if (process.env.NODE_ENV !== 'production') return build();
  if (!catalog) catalog = build();
  return catalog;
}

export function getStrategies(): Strategy[] {
  return getCatalog().strategies;
}

export function getStrategy(id: string): Strategy | undefined {
  return getCatalog().strategies.find((s) => s.id === id);
}

export function getLessons(): Lesson[] {
  return getCatalog().lessons;
}

/** Any lesson by id, strategy or not — what the `/learning/[id]` route needs. */
export function getEntry(id: string): Strategy | Lesson | undefined {
  const { strategies, lessons } = getCatalog();
  return strategies.find((s) => s.id === id) ?? lessons.find((l) => l.id === id);
}

/** Every id, for static generation of the lesson routes. */
export function getAllIds(): string[] {
  const { strategies, lessons } = getCatalog();
  return [...strategies.map((s) => s.id), ...lessons.map((l) => l.id)];
}
