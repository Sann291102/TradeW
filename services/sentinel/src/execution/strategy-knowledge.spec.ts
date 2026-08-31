import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { load as parseYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_READERS } from './evidence';
import { StrategyEngineService } from '../intelligence/strategy-engine.service';
import { isKnownRule } from '../intelligence/strategy-rules';

/**
 * The provenance chain, asserted rather than asserted-about.
 *
 *     knowledge-base/<domain>/<concept>.yaml
 *       → StrategyDefinition.knowledgeConcepts
 *         → StrategyDefinition.evidenceKeys → EVIDENCE_READERS[key].concept
 *           → the decision
 *
 * Every claim this feature makes about being "connected to the repository's
 * knowledge" is only true if these ids resolve. A concept renamed in
 * `knowledge-base/` while a strategy still cites the old id is a broken chain
 * that nothing else in the system would notice — the strategy would keep
 * trading and its provenance would keep pointing at nothing. So it fails here.
 */

/** Read every concept id the repository actually defines. */
function loadConceptIds(): Set<string> {
  const root = resolveKnowledgeBase();
  const ids = new Set<string>();
  if (!existsSync(root)) return ids;
  for (const domain of readdirSync(root)) {
    const domainDir = join(root, domain);
    if (!statSync(domainDir).isDirectory()) continue;
    for (const file of readdirSync(domainDir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const body = parseYaml(readFileSync(join(domainDir, file), 'utf8')) as { id?: unknown } | null;
      if (body && typeof body.id === 'string') ids.add(body.id);
    }
  }
  return ids;
}

/** Mirrors `ontology-loader.service.ts`'s own resolution, deliberately. */
function resolveKnowledgeBase(): string {
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
  return resolve(__dirname, '../../../../knowledge-base');
}

const engine = new StrategyEngineService();
const agentStrategies = engine.agentStrategies();
const conceptIds = loadConceptIds();

describe('agent strategy roster', () => {
  it('exposes exactly four agent-tradable strategies', () => {
    expect(agentStrategies.map((s) => s.id).sort()).toEqual([
      'agent-exhaustion-reversal',
      'agent-opening-range-expansion',
      'agent-smc-structure-shift',
      'agent-trend-momentum',
    ]);
  });

  it('marks none of the eight observation strategies agent-tradable', () => {
    const observation = engine.getStrategies().filter((s) => !s.agentTradable);
    // The eight that shipped before autonomous execution existed. If this
    // number changes, someone either added an observation strategy (fine —
    // update it) or made one of them agent-tradable (not fine — an
    // observation strategy has no exit rules and several are bullish-only).
    expect(observation).toHaveLength(8);
    for (const s of observation) {
      expect(s.exitRules).toBeUndefined();
    }
  });

  it('finds the knowledge base on disk', () => {
    // Guards the tests below: an empty concept set would make every provenance
    // assertion vacuously pass.
    expect(conceptIds.size).toBeGreaterThan(50);
  });
});

describe.each(agentStrategies)('$id', (strategy) => {
  it('declares a version, a purpose and a regime list', () => {
    expect(strategy.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(strategy.purpose && strategy.purpose.length).toBeGreaterThan(20);
    expect(strategy.regimes?.length).toBeGreaterThan(0);
  });

  it('only references rules the engine can resolve', () => {
    for (const rule of [...strategy.rules, ...strategy.invalidations, ...(strategy.exitRules ?? [])]) {
      expect(isKnownRule(rule), `unknown rule ${rule}`).toBe(true);
    }
  });

  it('declares exit rules — what ends the position, not just the setup', () => {
    expect(strategy.exitRules?.length ?? 0).toBeGreaterThan(0);
  });

  it('cites only knowledge-base concepts that exist', () => {
    expect(strategy.knowledgeConcepts?.length ?? 0).toBeGreaterThan(0);
    for (const concept of strategy.knowledgeConcepts ?? []) {
      expect(conceptIds.has(concept), `${strategy.id} cites unknown concept "${concept}"`).toBe(true);
    }
  });

  it('declares only evidence keys that have a reader', () => {
    expect(strategy.evidenceKeys?.length ?? 0).toBeGreaterThan(0);
    for (const key of strategy.evidenceKeys ?? []) {
      expect(EVIDENCE_READERS[key], `${strategy.id} declares unknown evidence key "${key}"`).toBeDefined();
    }
  });

  it('weights only evidence it actually declares', () => {
    for (const key of Object.keys(strategy.evidenceWeights ?? {})) {
      expect(strategy.evidenceKeys).toContain(key);
    }
  });
});

describe('evidence readers', () => {
  it('every reader cites a concept the knowledge base defines', () => {
    for (const [key, reader] of Object.entries(EVIDENCE_READERS)) {
      expect(conceptIds.has(reader.concept), `evidence "${key}" cites unknown concept "${reader.concept}"`).toBe(true);
    }
  });
});
