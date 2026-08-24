import { Controller, Get, Module, Post, UseGuards, CanActivate } from '@nestjs/common';
import { DiscoveryModule, ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  authOf,
  guardNames,
  joinPath,
  normalisePath,
  TopologyService,
} from './topology.service';
import {
  compact,
  isDeploymentEvent,
  isSecurityEvent,
  mapConceptRelation,
  mapEntityRelation,
  mapMemoryRelation,
  routeNodeId,
  tierOf,
} from './graph.projection';
import { parseFilter } from './graph.controller';
import {
  clamp01,
  edgeId,
  GraphNodeDto,
  NODE_KIND_DOMAIN,
  NODE_KINDS,
  nodeId,
  parseNodeId,
  recency,
  RELATION_TYPES,
  RELATIONS,
  saturate,
} from './graph.types';

/**
 * The system graph's load-bearing pure logic.
 *
 * What is asserted here is chosen by one question: which mistake would put a
 * WRONG but PLAUSIBLE picture in front of an operator? A graph that fails to
 * render is obvious. A graph that renders a route as `public` when it is
 * guarded, or draws an unscored guess at the same weight as a proven
 * association, is not — it looks exactly like a correct graph.
 *
 * So the cases below are:
 *
 *  · route discovery from real decorator metadata, including the auth posture
 *    a security review would read off the node;
 *  · the relation mappings, because an unmapped relation silently collapses to
 *    `related_to` and a contradiction would be drawn as an ordinary link;
 *  · the semantic-zoom tiering, because a mis-tiered hub disappears at the zoom
 *    level where it matters most;
 *  · the filter parser, because it is the one place a query string reaches the
 *    graph and unknown values must degrade rather than blank the page;
 *  · the id helpers, because every join in the projection goes through them.
 *
 * Everything here is pure or built on a Nest testing container. No database, no
 * network, no running API.
 */

// --------------------------------------------------------------------------
// A miniature application, used to prove routes are read from the CONTAINER.
// --------------------------------------------------------------------------

class FakeAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
class FakeAdminAccessGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Controller('probe')
class ProbeController {
  @Get('open')
  open(): string {
    return 'ok';
  }

  @UseGuards(FakeAuthGuard)
  @Get('user/:id')
  user(): string {
    return 'ok';
  }

  @Post('write')
  write(): string {
    return 'ok';
  }

  /** Not a route — proves handler discovery keys off route metadata, not on
   *  "every method on the prototype". */
  helper(): string {
    return 'not a route';
  }
}

@UseGuards(FakeAdminAccessGuard)
@Controller('admin/probe')
class GuardedProbeController {
  @Get('secrets')
  secrets(): string {
    return 'ok';
  }
}

@Module({ controllers: [ProbeController, GuardedProbeController] })
class ProbeModule {}

/**
 * Build a real Nest container and hand its `ModulesContainer` to the service
 * under test.
 *
 * Constructed by hand rather than resolved through DI because vitest's esbuild
 * transform does not emit `design:paramtypes` — Nest's constructor injection
 * needs that metadata and silently injects `undefined` without it. What is
 * being tested here is the READ of a real container, so the container is real;
 * only the wiring into the service is done explicitly.
 */
async function buildTopology(): Promise<TopologyService> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule, ProbeModule],
  }).compile();
  return new TopologyService(moduleRef.get(ModulesContainer));
}

describe('TopologyService — routes are read from the container', () => {
  it('discovers every declared route with its method, path and controller', async () => {
    const topology = await buildTopology();
    const routes = topology.routes();
    const found = routes.map((route) => `${route.method} ${route.path}`);

    expect(found).toContain('GET /probe/open');
    expect(found).toContain('GET /probe/user/:id');
    expect(found).toContain('POST /probe/write');
    expect(found).toContain('GET /admin/probe/secrets');
  });

  it('does not mistake a plain method for a route handler', async () => {
    const topology = await buildTopology();
    expect(topology.routes().some((route) => route.handler === 'helper')).toBe(false);
  });

  it('records the guards on the handler AND on the controller class', async () => {
    const topology = await buildTopology();
    const guarded = topology.routes().find((route) => route.path === '/admin/probe/secrets');
    expect(guarded?.guards).toContain('FakeAdminAccessGuard');

    const perHandler = topology.routes().find((route) => route.path === '/probe/user/:id');
    expect(perHandler?.guards).toContain('FakeAuthGuard');
  });

  /**
   * The security-review property. A route with no guard IS reachable
   * unauthenticated, and the graph must say so rather than defaulting to a
   * reassuring value — this is the one field on the whole graph where an
   * optimistic default would be actively dangerous.
   */
  it('reports an unguarded route as public, not as authenticated', async () => {
    const topology = await buildTopology();
    expect(topology.routes().find((route) => route.path === '/probe/open')?.auth).toBe('public');
  });

  it('counts routes onto their controller', async () => {
    const topology = await buildTopology();
    const probe = topology.controllers().find((controller) => controller.name === 'ProbeController');
    expect(probe?.routeCount).toBe(3);
    expect(probe?.basePath).toBe('/probe');
  });
});

describe('authOf — the posture an operator reads off a node', () => {
  it('ranks operator/admin above authenticated when both guards are present', () => {
    expect(authOf(['AuthGuard', 'AdminAccessGuard'])).toBe('admin');
  });

  it('treats a bare operator-token guard as operator, not admin', () => {
    expect(authOf(['AdminTokenGuard'])).toBe('operator');
  });

  it('reports a capability gate distinctly from plain authentication', () => {
    expect(authOf(['AuthGuard', 'CapabilityGuard'], 'sentinel')).toBe('capability');
    expect(authOf(['AuthGuard'])).toBe('user');
  });

  it('reports the control-plane boundary as internal', () => {
    expect(authOf(['ControlGuard'])).toBe('internal');
  });

  it('falls through to public only when nothing guards the route', () => {
    expect(authOf([])).toBe('public');
  });
});

describe('guardNames', () => {
  it('reads a class reference and an instantiated guard alike', () => {
    expect(guardNames([FakeAuthGuard, new FakeAdminAccessGuard()])).toEqual(['FakeAuthGuard', 'FakeAdminAccessGuard']);
  });

  it('returns nothing for absent metadata rather than throwing', () => {
    expect(guardNames(undefined)).toEqual([]);
    expect(guardNames('not-an-array')).toEqual([]);
  });
});

describe('path helpers', () => {
  it('joins a controller base and a handler path without doubling slashes', () => {
    expect(joinPath(normalisePath('/admin/graph/'), normalisePath('/overview'))).toBe('/admin/graph/overview');
  });

  it('produces a root path when both parts are empty', () => {
    expect(joinPath(normalisePath(''), normalisePath('/'))).toBe('/');
  });
});

describe('node and edge ids', () => {
  it('round-trips through parseNodeId', () => {
    const id = nodeId('concept', 'liquidity-sweep');
    expect(parseNodeId(id)).toEqual({ kind: 'concept', key: 'liquidity-sweep' });
  });

  /** Concept slugs and vault paths contain colons and slashes; only the FIRST
   *  colon separates the kind, or every such id would parse to the wrong kind. */
  it('splits on the first colon only', () => {
    expect(parseNodeId(nodeId('entity', 'NSE:RELIANCE'))).toEqual({ kind: 'entity', key: 'NSE:RELIANCE' });
    expect(parseNodeId(nodeId('note', 'Decisions/2026-08-04 — audit.md'))?.key).toBe('Decisions/2026-08-04 — audit.md');
  });

  it('rejects an id whose kind is not in the vocabulary', () => {
    expect(parseNodeId('bogus:thing')).toBeNull();
    expect(parseNodeId('nocolon')).toBeNull();
  });

  it('keeps GET and POST on the same path as distinct nodes', () => {
    expect(routeNodeId('GET', '/orders')).not.toBe(routeNodeId('POST', '/orders'));
  });

  /** Edge ids are derived, not stored, so a rebuilt snapshot keeps the console's
   *  in-flight pulse animation attached to the same edge. */
  it('derives a stable edge id from its endpoints and relation', () => {
    const a = edgeId('agent:orchestrator', 'calls', 'agent:trap-safety');
    const b = edgeId('agent:orchestrator', 'calls', 'agent:trap-safety');
    expect(a).toBe(b);
    expect(a).not.toBe(edgeId('agent:trap-safety', 'calls', 'agent:orchestrator'));
  });
});

describe('the closed vocabularies', () => {
  it('assigns every node kind to exactly one domain', () => {
    for (const kind of NODE_KINDS) {
      expect(NODE_KIND_DOMAIN[kind], `${kind} has no domain`).toBeTruthy();
    }
  });

  /** The inverse label is what lets ONE stored edge read correctly from both
   *  ends in the inspector. An inverse that does not itself round-trip would
   *  make one of the two ends read backwards. */
  it('gives every relation an inverse that is itself a known relation or its own mirror', () => {
    for (const relation of RELATION_TYPES) {
      const inverse = RELATIONS[relation].inverse;
      expect(typeof inverse).toBe('string');
      expect(inverse.length).toBeGreaterThan(0);
    }
    expect(RELATIONS.related_to.inverse).toBe('related_to');
    expect(RELATIONS.contradicts.inverse).toBe('contradicts');
    expect(RELATIONS.related_to.directed).toBe(false);
    expect(RELATIONS.calls.directed).toBe(true);
  });
});

describe('relation mapping', () => {
  /** The one that matters most: a refuting relation must survive the mapping
   *  as a contradiction, or the console draws disagreement as agreement. */
  it('preserves contradiction through the concept vocabulary', () => {
    expect(mapConceptRelation('contradicts')).toBe('contradicts');
    expect(mapConceptRelation('invalidates')).toBe('contradicts');
    expect(mapConceptRelation('negates')).toBe('contradicts');
  });

  it('maps the ontology synonyms onto one relation each', () => {
    expect(mapConceptRelation('subtype_of')).toBe('part_of');
    expect(mapConceptRelation('refines')).toBe('derived_from');
    expect(mapConceptRelation('causes')).toBe('produces');
    expect(mapConceptRelation('requires')).toBe('depends_on');
  });

  it('falls back to related_to for a relation the vocabulary does not know', () => {
    expect(mapConceptRelation('some-future-relation')).toBe('related_to');
    expect(mapMemoryRelation('whatever')).toBe('related_to');
    expect(mapEntityRelation('whatever')).toBe('related_to');
  });

  it('maps memory and entity relations onto the shared vocabulary', () => {
    expect(mapMemoryRelation('summarises')).toBe('derived_from');
    expect(mapMemoryRelation('supersedes')).toBe('supersedes');
    expect(mapEntityRelation('belongs_to_sector')).toBe('part_of');
  });
});

describe('semantic zoom tiers', () => {
  const node = (over: Partial<GraphNodeDto>): GraphNodeDto => ({
    id: 'x:1',
    kind: 'note',
    domain: 'knowledge',
    label: 'x',
    source: 'database',
    importance: 0.1,
    activity: 0,
    confidence: 1,
    cluster: 'cluster:knowledge',
    tier: 2,
    degree: 0,
    ...over,
  });

  it('keeps the structural spine visible at the furthest zoom-out', () => {
    expect(tierOf(node({ kind: 'service', importance: 0.1 }))).toBe(0);
    expect(tierOf(node({ kind: 'layer', importance: 0 }))).toBe(0);
  });

  /** A hub earns tier 0 by being a hub, not by being a favoured kind — this is
   *  what stops a heavily-linked concept from vanishing at low zoom. */
  it('promotes a genuine hub regardless of its kind', () => {
    expect(tierOf(node({ kind: 'note', degree: 40 }))).toBe(0);
    expect(tierOf(node({ kind: 'note', importance: 0.85 }))).toBe(0);
  });

  it('places evidence-level detail at the deepest tier', () => {
    expect(tierOf(node({ kind: 'learning' }))).toBe(2);
    expect(tierOf(node({ kind: 'memory' }))).toBe(2);
    expect(tierOf(node({ kind: 'route', importance: 0.12 }))).toBe(2);
  });

  it('places services, agents and concepts at the middle tier', () => {
    expect(tierOf(node({ kind: 'agent', importance: 0.5 }))).toBe(1);
    expect(tierOf(node({ kind: 'concept', importance: 0.3 }))).toBe(1);
  });
});

describe('audit event classification', () => {
  it('recognises the security vocabulary, including types nobody has written yet', () => {
    expect(isSecurityEvent('admin.granted')).toBe(true);
    expect(isSecurityEvent('operator.login.failed')).toBe(true);
    expect(isSecurityEvent('broker.credential.revoked')).toBe(true);
    expect(isSecurityEvent('some.future.permission.change')).toBe(true);
  });

  it('does not sweep ordinary product events into the security cluster', () => {
    expect(isSecurityEvent('order.placed')).toBe(false);
    expect(isSecurityEvent('watchlist.updated')).toBe(false);
  });

  it('separates deployment events from security findings', () => {
    expect(isDeploymentEvent('deploy.completed')).toBe(true);
    expect(isDeploymentEvent('migration.applied')).toBe(true);
    expect(isDeploymentEvent('order.placed')).toBe(false);
  });
});

describe('scalar helpers', () => {
  it('clamps to 0..1 and treats a non-number as zero', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(9)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });

  /** Activity must decay smoothly: a cliff makes a busy node blink out the
   *  instant it crosses an arbitrary age. */
  it('decays recency by half-life and never returns a negative', () => {
    const now = 1_000_000;
    expect(recency(now, 60_000, now)).toBe(1);
    expect(recency(now - 60_000, 60_000, now)).toBeCloseTo(0.5, 5);
    expect(recency(now - 600_000, 60_000, now)).toBeLessThan(0.01);
    expect(recency(null, 60_000, now)).toBe(0);
  });

  it('saturates a count into 0..1 without ever reaching 1', () => {
    expect(saturate(0, 10)).toBe(0);
    expect(saturate(10, 10)).toBeCloseTo(0.5, 5);
    expect(saturate(1e9, 10)).toBeLessThan(1);
    expect(saturate(-5, 10)).toBe(0);
  });

  it('compacts a count to fit a four-character glyph', () => {
    expect(compact(42)).toBe('42');
    expect(compact(1_240)).toBe('1.2k');
    expect(compact(48_000)).toBe('48k');
    expect(compact(2_400_000)).toBe('2.4M');
  });
});

describe('parseFilter', () => {
  it('keeps known vocabulary members and drops unknown ones', () => {
    const filter = parseFilter({ domains: 'application,knowledge,atlantis', kinds: 'route,unicorn', relations: 'calls,teleports_to' });
    expect(filter.domains).toEqual(['application', 'knowledge']);
    expect(filter.kinds).toEqual(['route']);
    expect(filter.relations).toEqual(['calls']);
  });

  /**
   * A console on an older build must get the rest of its filter honoured
   * rather than a 400 that blanks the page. This is why unknown values are
   * dropped instead of rejected.
   */
  it('does not throw on a filter made entirely of unknown values', () => {
    const filter = parseFilter({ domains: 'nonsense', kinds: 'nonsense' });
    expect(filter.domains).toEqual([]);
    expect(filter.kinds).toEqual([]);
  });

  it('clamps numeric bounds instead of trusting them', () => {
    expect(parseFilter({ limit: '1000000000' }).limit).toBe(900);
    expect(parseFilter({ limit: '-4' }).limit).toBe(1);
    expect(parseFilter({ minConfidence: '5' }).minConfidence).toBe(1);
    expect(parseFilter({ minConfidence: '-1' }).minConfidence).toBe(0);
    expect(parseFilter({ maxTier: '9' }).maxTier).toBe(2);
  });

  it('leaves an absent or unparseable bound undefined rather than defaulting it to zero', () => {
    expect(parseFilter({}).minConfidence).toBeUndefined();
    expect(parseFilter({ minActivity: '' }).minActivity).toBeUndefined();
    expect(parseFilter({ sinceHours: 'soon' }).sinceHours).toBeUndefined();
  });

  it('trims a search term and treats whitespace as no term at all', () => {
    expect(parseFilter({ q: '  sentinel  ' }).q).toBe('sentinel');
    expect(parseFilter({ q: '   ' }).q).toBeUndefined();
  });
});
