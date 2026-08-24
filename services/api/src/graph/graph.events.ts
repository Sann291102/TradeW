import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentActivityEvent, AgentRunEndEvent, AgentRunStartEvent, AiCallEvent } from '@tradew/ai-core';
import { TelemetryService, type ApiCallRecord } from '../telemetry/telemetry.service';
import { KnowledgeService, type ActivityEvent as VaultEvent } from '../knowledge/knowledge.service';
import { GraphService } from './graph.service';
import {
  clamp01,
  edgeId,
  GraphDomain,
  GraphEvent,
  GraphEventKind,
  nodeId,
  saturate,
} from './graph.types';
import { routeNodeId } from './graph.projection';

/**
 * The live edge of the system graph.
 *
 * ## Why this is a translator and not a new event bus
 *
 * The platform already emits everything this needs. `TelemetryService.bus`
 * carries HTTP requests, LLM calls, agent transitions and run boundaries;
 * `KnowledgeService.changes` carries vault writes. Introducing a second
 * publishing mechanism would mean every future feature has to remember to
 * publish twice, and the one that forgets produces a graph that is quietly
 * wrong rather than visibly broken.
 *
 * So this class subscribes to what exists and translates it into the one thing
 * the console needs and the raw events do not carry: **which node and which
 * edge to light up**. That mapping — `AiCallEvent { agent: 'trap-safety' }` →
 * `agent:trap-safety` and the edge from the route that triggered it — is the
 * whole job, and it belongs next to the projection that assigned those ids.
 *
 * ## Pulses are never invented
 *
 * Every event published here is caused by a real platform event. There is no
 * timer that emits decorative activity, and there must never be one: an
 * operator watching this feed is entitled to read "nothing is moving" as
 * "nothing is happening".
 *
 * ## Structural events invalidate the snapshot
 *
 * Most events are traffic — they light a node that already exists. A few
 * (a vault write, a concept promotion) change the graph's SHAPE, so they also
 * mark the cached snapshot stale. That is done by debounced invalidation
 * rather than an immediate rebuild: a burst of twenty vault writes during a
 * git checkout should cost one rebuild, not twenty.
 */

/** How long a burst of structural changes is allowed to coalesce. */
const REBUILD_DEBOUNCE_MS = 3_000;

/** Ceiling on the replay buffer. Enough to fill a console that just connected
 *  without holding a session's worth of traffic in the API's heap. */
const REPLAY_SIZE = 120;

@Injectable()
export class GraphEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphEventsService.name);

  /** Fires `graph` with a `GraphEvent`. One listener per connected console. */
  readonly bus = new EventEmitter();

  /** The last few events, so a console that connects mid-stream has something
   *  to draw immediately instead of an empty canvas until traffic happens. */
  private readonly replay: GraphEvent[] = [];

  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private detach: Array<() => void> = [];

  constructor(
    private readonly telemetry: TelemetryService,
    private readonly knowledge: KnowledgeService,
    private readonly graph: GraphService,
  ) {
    // One listener per connected console, plus the four this class attaches.
    this.bus.setMaxListeners(60);
  }

  onModuleInit(): void {
    const onApi = (record: ApiCallRecord) => this.onApiCall(record);
    const onAi = (event: AiCallEvent) => this.onAiCall(event);
    const onActivity = (event: AgentActivityEvent) => this.onAgentActivity(event);
    const onRun = (event: (AgentRunStartEvent | AgentRunEndEvent) & { phase: 'start' | 'end' }) => this.onRun(event);
    const onVault = (event: VaultEvent) => this.onVaultChange(event);

    this.telemetry.bus.on('api', onApi);
    this.telemetry.bus.on('ai', onAi);
    this.telemetry.bus.on('activity', onActivity);
    this.telemetry.bus.on('run', onRun);
    this.knowledge.changes.on('change', onVault);

    this.detach = [
      () => this.telemetry.bus.off('api', onApi),
      () => this.telemetry.bus.off('ai', onAi),
      () => this.telemetry.bus.off('activity', onActivity),
      () => this.telemetry.bus.off('run', onRun),
      () => this.knowledge.changes.off('change', onVault),
    ];
  }

  onModuleDestroy(): void {
    for (const off of this.detach) off();
    this.detach = [];
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.bus.removeAllListeners();
  }

  /** Events the console missed, oldest first. */
  recent(limit = 40): GraphEvent[] {
    return this.replay.slice(-Math.min(limit, REPLAY_SIZE));
  }

  /**
   * Publish an event from somewhere that is not one of the buses above.
   *
   * Used by the cognition and concept write paths, which are ordinary service
   * calls rather than emitters. Exposed rather than private so a new source
   * can be wired in without this file having to know about it — but it still
   * goes through `emit`, so the "never invented" rule holds at one chokepoint.
   */
  publish(event: Omit<GraphEvent, 'id' | 'at'> & { at?: number }): void {
    this.emit({ ...event, id: randomUUID(), at: event.at ?? Date.now() });
  }

  // ---------------------------------------------------------------- sources

  private onApiCall(record: ApiCallRecord): void {
    const route = routeNodeId(record.method, record.path);
    const failed = record.statusCode >= 400;
    this.emit({
      id: record.requestId,
      kind: failed ? 'error.generated' : 'route.activity',
      at: Date.now(),
      nodeIds: [route],
      edgeIds: [],
      summary: `${record.method} ${record.path} → ${record.statusCode} in ${record.durationMs}ms`,
      domain: failed ? 'security' : 'application',
      // A slow or failing request is a stronger signal than a fast success —
      // the pulse an operator notices should be the one worth noticing.
      intensity: failed ? 1 : clamp01(0.3 + saturate(record.durationMs, 800) * 0.5),
      status: failed ? 'error' : 'ok',
    });
  }

  private onAiCall(event: AiCallEvent): void {
    const agent = nodeId('agent', event.agent);
    const model = nodeId('model', `${event.provider}/${event.model}`);
    const failed = event.status !== 'ok';
    this.emit({
      id: randomUUID(),
      kind: 'ai.call',
      at: Date.now(),
      nodeIds: [agent, model],
      edgeIds: [edgeId(agent, 'uses', model)],
      summary: `${event.agent} → ${event.provider}/${event.model} · ${event.latencyMs}ms${failed ? ` · ${event.status}` : ''}`,
      domain: 'ai',
      intensity: failed ? 1 : clamp01(0.4 + saturate(event.latencyMs, 4_000) * 0.4),
      status: failed ? 'error' : 'ok',
    });
  }

  /**
   * An agent transition. `sending` is the one that carries a direction, so it
   * is the one that pulses an EDGE — the others light the node only. That is
   * the same distinction `AgentActivity.peer` was designed around, and reusing
   * it here means the pulse travels the way the data travelled.
   */
  private onAgentActivity(event: AgentActivityEvent): void {
    const agent = nodeId('agent', event.agent);
    const nodeIds = [agent];
    const edgeIds: string[] = [];
    if (event.peer) {
      const peer = nodeId('agent', event.peer);
      nodeIds.push(peer);
      if (event.state === 'sending') edgeIds.push(edgeId(agent, 'calls', peer));
      if (event.state === 'receiving') edgeIds.push(edgeId(peer, 'calls', agent));
    }
    this.emit({
      id: randomUUID(),
      kind: event.state === 'error' ? 'error.generated' : 'agent.activity',
      at: event.at,
      nodeIds,
      edgeIds,
      summary: event.detail ? `${event.agent}: ${event.detail}` : `${event.agent} · ${event.state}`,
      domain: 'ai',
      intensity: event.state === 'error' ? 1 : event.state === 'thinking' ? 0.7 : 0.5,
      status: event.state === 'error' ? 'error' : 'ok',
    });
  }

  private onRun(event: (AgentRunStartEvent | AgentRunEndEvent) & { phase: 'start' | 'end' }): void {
    const end = event.phase === 'end' ? (event as AgentRunEndEvent) : null;
    const start = event.phase === 'start' ? (event as AgentRunStartEvent) : null;
    const agents = end?.agentsRan ?? [];
    this.emit({
      id: randomUUID(),
      kind: 'agent.run',
      at: event.at,
      nodeIds: agents.map((agent) => nodeId('agent', agent)),
      edgeIds: [],
      summary: start
        ? `run started · ${start.trigger}${start.symbol ? ` · ${start.symbol}` : ''}`
        : `run ${end?.status} · ${agents.length} agent(s)${end?.surfaced ? ' · surfaced' : ' · silent'}`,
      domain: 'ai',
      intensity: end?.status === 'error' ? 1 : 0.6,
      status: end?.status === 'error' ? 'error' : 'ok',
    });
  }

  /**
   * A vault write. Structural: a new note, or a new link inside one, changes
   * the graph's shape, so the cached snapshot is marked stale.
   */
  private onVaultChange(event: VaultEvent): void {
    const kind: GraphEventKind =
      event.type === 'created' ? 'knowledge.created' : event.type === 'deleted' ? 'knowledge.deleted' : 'knowledge.updated';
    this.emit({
      id: event.id,
      kind,
      at: event.at,
      nodeIds: [nodeId('note', event.path)],
      edgeIds: [],
      summary: `${event.type} · ${event.title}`,
      domain: 'knowledge',
      intensity: 0.8,
      status: 'ok',
    });
    this.scheduleRebuild();
  }

  // ------------------------------------------------------------------ plumbing

  private emit(event: GraphEvent): void {
    this.replay.push(event);
    if (this.replay.length > REPLAY_SIZE) this.replay.splice(0, this.replay.length - REPLAY_SIZE);
    try {
      this.bus.emit('graph', event);
    } catch (err) {
      // A console that vanished mid-write must never take down the request
      // path this listener is attached to.
      this.logger.debug(`graph event fan-out failed: ${String(err)}`);
    }
  }

  /** Coalesce a burst of structural changes into one snapshot rebuild. */
  private scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.graph.invalidate();
      this.emit({
        id: randomUUID(),
        kind: 'graph.rebuilt',
        at: Date.now(),
        nodeIds: [],
        edgeIds: [],
        summary: 'graph structure changed — snapshot invalidated',
        domain: 'knowledge' as GraphDomain,
        intensity: 0.2,
        status: 'ok',
      });
    }, REBUILD_DEBOUNCE_MS);
    this.rebuildTimer.unref?.();
  }
}
