import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  CognitiveNetwork,
  Episode,
  LAYER_DESCRIPTIONS,
  LAYER_LABELS,
  LAYER_ORDER,
  NewPercept,
  PerceptDomain,
  Percept,
  SynapseChange,
} from '@tradew/ai-core';
import { Prisma } from '@prisma/client';
import { LeaderElectionService } from '../common/leader-election';
import { PrismaService } from '../prisma/prisma.service';
import { CognitionConceptPort, CognitionMemoryStore, SynapsePersistence } from './cognition.store';
import { applicationPerceptors } from './perceptors/application.perceptors';
import { assistantPerceptors } from './perceptors/assistant.perceptors';
import { learningPerceptors } from './perceptors/learning.perceptors';
import { marketPerceptors } from './perceptors/market.perceptors';
import { platformPerceptors } from './perceptors/platform.perceptors';

/**
 * The cognition runtime — one network, one loop, one place it is persisted.
 *
 * WHY THIS LIVES IN services/api AND NOT IN SENTINEL
 *
 * Every perceptor reads Postgres, and `services/api` is the process that owns
 * the Prisma client. Putting the network in Sentinel would mean either a second
 * database client in a service that talks to the API over HTTP, or a set of new
 * internal endpoints existing only to feed sensors. Both are more moving parts
 * to observe than the thing being observed.
 *
 * The direction of the dependency is also right: this network watches the
 * platform, and the API *is* the platform's centre. Sentinel and tradew-ai push
 * percepts in through `ingest()` when they know something the database does not.
 *
 * THREE GATES BEFORE ANY OF IT RUNS
 *
 *  1. `COGNITION_ENABLED` — off by default. A learning loop that switches
 *     itself on during a deploy nobody scoped for it is not a feature.
 *  2. **Leader only** — the pass reads windows and writes episodes; two
 *     replicas would double-count every observation and, worse, would each lay
 *     eligibility traces that the other's outcomes would never score.
 *  3. **Salience floor** — the network's attention budget, applied in L1.
 */

const COGNITION_JOB = 'cognition-network';

/** How often a full pass runs. */
const PASS_INTERVAL_MS = Number(process.env.COGNITION_PASS_MS ?? 5 * 60_000);

/** How often dirty weights are written back. */
const FLUSH_INTERVAL_MS = Number(process.env.COGNITION_FLUSH_MS ?? 30_000);

/** Percepts and episodes older than this are pruned. Weights never are. */
const RETENTION_DAYS = Number(process.env.COGNITION_RETENTION_DAYS ?? 30);

@Injectable()
export class CognitionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CognitionService.name);
  private readonly enabled = process.env.COGNITION_ENABLED === 'true';

  private network!: CognitiveNetwork;
  private passTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Guards against a slow pass overlapping the next tick. */
  private passing = false;
  private booted = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: CognitionMemoryStore,
    private readonly concepts: CognitionConceptPort,
    private readonly synapsePersistence: SynapsePersistence,
    private readonly leader: LeaderElectionService,
  ) {}

  async onModuleInit(): Promise<void> {
    // The network object is constructed even when the loop is disabled, so the
    // admin console can render the roster, the layer map and the stored weights
    // on an instance that is deliberately not running passes. A console that
    // shows nothing when a feature is off cannot tell an operator whether the
    // feature is off or broken.
    this.network = new CognitiveNetwork(
      { memory: this.memory, concepts: this.concepts },
      { salienceFloor: Number(process.env.COGNITION_SALIENCE_FLOOR ?? 0.15) },
    );

    for (const perceptor of [
      ...applicationPerceptors(this.prisma),
      ...marketPerceptors(this.prisma),
      ...assistantPerceptors(this.prisma),
      ...learningPerceptors(this.prisma),
      ...platformPerceptors(this.prisma),
    ]) {
      this.network.registry.register(perceptor);
    }

    if (!this.enabled) {
      this.logger.log(
        `cognition network registered ${this.network.registry.list().length} perceptors but is NOT running (set COGNITION_ENABLED=true)`,
      );
      return;
    }

    await this.boot();
    this.leader.register(COGNITION_JOB);
    this.passTimer = setInterval(() => void this.tick(), PASS_INTERVAL_MS);
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.logger.log(
      `cognition network running: ${this.network.registry.list().length} perceptors, pass every ${PASS_INTERVAL_MS / 1000}s`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.passTimer) clearInterval(this.passTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    // The last flush is the one that matters. Everything else this service
    // holds is re-derivable; the weights are not.
    await this.flush();
  }

  // ------------------------------------------------------------------ boot

  /** Restore persisted weights and per-perceptor enablement. */
  private async boot(): Promise<void> {
    if (this.booted) return;
    try {
      const loaded = await this.synapsePersistence.load(this.network.synapses);

      const states = await this.prisma.perceptorState.findMany({ select: { perceptorId: true, enabled: true } });
      for (const state of states) {
        // Only disabling is restored, never enabling. A perceptor removed from
        // the code should not be resurrected by a stale row, and a perceptor
        // an operator turned off must stay off across the deploy that made
        // them turn it off.
        if (!state.enabled) this.network.registry.setEnabled(state.perceptorId, false);
      }

      this.booted = true;
      this.logger.log(`restored ${loaded} synapses and ${states.length} perceptor states`);
    } catch (err) {
      // A boot that cannot read its weights starts from initial values rather
      // than refusing to start. Degraded learning beats a dead loop.
      this.logger.error(`cognition boot failed, starting with empty weights: ${String(err)}`);
      this.booted = true;
    }
  }

  // ------------------------------------------------------------------ loop

  private async tick(): Promise<void> {
    if (!this.leader.isLeader(COGNITION_JOB)) return;
    if (this.passing) {
      // Two overlapping passes would sense the same window twice and record
      // both, which is indistinguishable in the data from the world actually
      // doing the thing twice.
      this.logger.warn('previous cognition pass still running; skipping this tick');
      return;
    }
    this.passing = true;
    try {
      await this.runPass({ trigger: 'scheduled', windowMs: PASS_INTERVAL_MS });
      await this.prune();
    } catch (err) {
      this.logger.error(`cognition pass failed: ${String(err)}`);
    } finally {
      this.passing = false;
    }
  }

  private async flush(): Promise<void> {
    try {
      const written = await this.synapsePersistence.flush(this.network.synapses);
      if (written) this.logger.debug(`flushed ${written} synapses`);
    } catch (err) {
      this.logger.warn(`synapse flush failed: ${String(err)}`);
    }
  }

  // --------------------------------------------------------------- passes

  /**
   * Run one pass and persist everything it produced.
   *
   * Persistence order matters: the episode row is written **first**, before its
   * percepts and proposals, so a crash mid-write leaves an episode with missing
   * children rather than orphan children with no episode. The first is a
   * visibly incomplete record; the second is rows nothing can ever join back to.
   */
  async runPass(options: { trigger: string; domain?: PerceptDomain; windowMs?: number; percepts?: NewPercept[] }): Promise<Episode> {
    const episode = await this.network.perceive({
      trigger: options.trigger,
      domain: options.domain,
      windowMs: options.windowMs ?? PASS_INTERVAL_MS,
      percepts: options.percepts,
    });

    await this.persistEpisode(episode);
    await this.persistPerceptorStates();
    return episode;
  }

  /**
   * Accept percepts from another service or from the assistant.
   *
   * The escape hatch for everything the database does not know: Sentinel's
   * in-flight reasoning, a conversation turn, a deploy marker. Runs a full pass
   * over just those percepts so pushed observations go through exactly the same
   * four layers, the same salience gate and the same corroboration bar as polled
   * ones. A second, more permissive path into memory is how a "temporary"
   * bypass becomes the way most knowledge gets in.
   */
  async ingest(percepts: NewPercept[], trigger = 'ingest'): Promise<Episode> {
    return this.runPass({ trigger, percepts, windowMs: PASS_INTERVAL_MS });
  }

  // -------------------------------------------------------------- outcomes

  /**
   * Score an episode. This is the half that makes the network improve.
   *
   * Called when ground truth appears — an operator resolving a proposal, or a
   * service reporting how something turned out. Writes the reward onto the
   * episode and lets credit flow back through the eligibility traces the
   * forward pass laid down.
   *
   * Traces live in memory, so an episode scored after a restart updates the
   * episode row but moves no weights. That is a real limitation and the honest
   * behaviour: reconstructing traces from persisted percepts would guess at
   * coactivation values that were never recorded, and a learning system fed
   * fabricated inputs is worse than one that occasionally learns nothing.
   */
  async score(episodeId: string, reward: number, reason: string): Promise<SynapseChange[]> {
    const clamped = Math.min(1, Math.max(0, reward));
    const observedAt = new Date();

    const changes = this.network.reinforce({ episodeId, reward: clamped, reason, observedAt });

    await this.prisma.cognitiveEpisode
      .update({
        where: { episodeId },
        data: { reward: clamped, rewardReason: reason.slice(0, 500), scoredAt: observedAt },
      })
      .catch((err: unknown) => this.logger.warn(`could not record outcome for ${episodeId}: ${String(err)}`));

    // Written straight through rather than left for the timer: an outcome is
    // rare and precious, and losing one to a restart in the next 30 seconds
    // costs more than the write.
    await this.flush();
    return changes;
  }

  /**
   * Resolve a proposal, and turn the resolution into an outcome signal.
   *
   * `dismissed` is the single most valuable input the network receives, and it
   * is worth being explicit about why: it is a human saying "you were wrong",
   * about a specific chain of activations, with the traces still live. Nothing
   * else in this platform produces a negative label at all. An `accepted`
   * proposal is a weaker positive — it means the finding looked worth acting on,
   * not that it was correct — so it is rewarded well below the ceiling.
   */
  async resolveProposal(
    id: string,
    status: 'accepted' | 'dismissed' | 'done',
    resolvedBy: string,
    resolution?: string,
  ): Promise<void> {
    const proposal = await this.prisma.cognitiveProposal.update({
      where: { id },
      data: { status, resolvedBy, resolution: resolution?.slice(0, 1_000) ?? null, resolvedAt: new Date() },
    });

    const reward = status === 'dismissed' ? 0 : status === 'done' ? 1 : 0.7;
    await this.score(proposal.episodeId, reward, `proposal ${status} by operator`);
  }

  // ------------------------------------------------------------- persistence

  private async persistEpisode(episode: Episode): Promise<void> {
    try {
      await this.prisma.cognitiveEpisode.create({
        data: {
          episodeId: episode.episodeId,
          domain: episode.domain,
          trigger: episode.trigger,
          status: episode.status,
          perceptCount: episode.percepts.length,
          gatedCount: episode.gated,
          collapsedCount: episode.collapsed,
          hypothesisCount: episode.hypotheses.length,
          promotedCount: episode.remembered.length,
          proposalCount: episode.proposals.length,
          layerTimings: episode.layerTimings as unknown as Prisma.InputJsonValue,
          error: episode.error,
          startedAt: episode.startedAt,
          finishedAt: episode.finishedAt,
        },
      });
    } catch (err) {
      // Without the parent row the children have nothing to join to, so this
      // is the one write whose failure aborts the rest.
      this.logger.error(`could not persist episode ${episode.episodeId}: ${String(err)}`);
      return;
    }

    if (episode.percepts.length) {
      await this.prisma.percept
        .createMany({ data: episode.percepts.map((p) => this.perceptRow(p, episode.episodeId)) })
        .catch((err: unknown) => this.logger.warn(`percept persist failed: ${String(err)}`));
    }

    if (episode.proposals.length) {
      await this.prisma.cognitiveProposal
        .createMany({
          data: episode.proposals.map((proposal) => ({
            episodeId: episode.episodeId,
            domain: proposal.domain,
            kind: proposal.kind,
            title: proposal.title.slice(0, 500),
            rationale: proposal.rationale.slice(0, 2_000),
            confidence: proposal.confidence,
            perceptIds: proposal.perceptIds,
          })),
        })
        .catch((err: unknown) => this.logger.warn(`proposal persist failed: ${String(err)}`));
    }
  }

  private perceptRow(percept: Percept, episodeId: string): Prisma.PerceptCreateManyInput {
    return {
      perceptorId: percept.perceptorId,
      domain: percept.domain,
      kind: percept.kind,
      subjectType: percept.subject.type,
      subjectId: percept.subject.id,
      observedAt: percept.observedAt,
      salience: percept.salience,
      confidence: percept.confidence,
      features: percept.features as unknown as Prisma.InputJsonValue,
      summary: percept.summary.slice(0, 1_000),
      payload: (percept.payload ?? null) as Prisma.InputJsonValue,
      tags: percept.tags,
      occurrences: percept.occurrences ?? 1,
      episodeId,
    };
  }

  /** Mirror in-memory sensor health into Postgres, so the console survives a
   *  restart and an operator's disable decision outlives the deploy. */
  private async persistPerceptorStates(): Promise<void> {
    const health = this.network.snapshot().perceptors;
    for (const state of health) {
      const definition = this.network.registry.get(state.perceptorId)?.definition;
      if (!definition) continue;
      await this.prisma.perceptorState
        .upsert({
          where: { perceptorId: state.perceptorId },
          create: {
            perceptorId: state.perceptorId,
            domain: definition.domain,
            enabled: definition.enabled,
            status: state.status,
            lastSensedAt: state.lastSensedAt,
            lastPerceptAt: state.lastPerceptAt,
            consecutiveFailures: state.consecutiveFailures,
            lastError: state.lastError,
            totalPercepts: state.totalPercepts,
            meanSalience: state.meanSalience,
          },
          update: {
            domain: definition.domain,
            enabled: definition.enabled,
            status: state.status,
            lastSensedAt: state.lastSensedAt,
            lastPerceptAt: state.lastPerceptAt,
            consecutiveFailures: state.consecutiveFailures,
            lastError: state.lastError,
            totalPercepts: state.totalPercepts,
            meanSalience: state.meanSalience,
          },
        })
        .catch(() => {
          /* health mirroring must never fail a pass */
        });
    }
  }

  /**
   * Drop percepts and episodes past the retention window.
   *
   * `NeuralSynapse` is deliberately absent from this method and must stay
   * absent. Percepts and episodes are history and regenerate; a weight is weeks
   * of accumulated outcomes that cannot be recomputed from anything. Adding it
   * here "for consistency" would delete everything the network has learned.
   */
  private async prune(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    try {
      await this.prisma.percept.deleteMany({ where: { createdAt: { lt: cutoff } } });
      // Unscored episodes are kept regardless of age: they are the backlog the
      // feedback loop still owes an answer to, and deleting them would make a
      // stalled loop look like a healthy one.
      await this.prisma.cognitiveEpisode.deleteMany({
        where: { startedAt: { lt: cutoff }, scoredAt: { not: null } },
      });
    } catch (err) {
      this.logger.warn(`cognition prune failed: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------------ reads

  /** Live network state for the console. */
  snapshot() {
    const snap = this.network.snapshot();
    return {
      enabled: this.enabled,
      isLeader: this.enabled ? this.leader.isLeader(COGNITION_JOB) : false,
      passIntervalMs: PASS_INTERVAL_MS,
      ...snap,
      layers: snap.layers.map((layer) => ({
        ...layer,
        label: LAYER_LABELS[layer.id],
        description: LAYER_DESCRIPTIONS[layer.id],
        // Position in the stack, so the UI does not have to know the order.
        index: LAYER_ORDER.indexOf(layer.id),
      })),
    };
  }

  /** Definitions joined to live health — the console's perceptor table. */
  perceptors() {
    const health = new Map(this.network.snapshot().perceptors.map((h) => [h.perceptorId, h]));
    return this.network.registry.list().map((perceptor) => ({
      ...perceptor.definition,
      health: health.get(perceptor.definition.id) ?? null,
    }));
  }

  async setPerceptorEnabled(id: string, enabled: boolean): Promise<void> {
    const perceptor = this.network.registry.get(id);
    if (!perceptor) throw new Error(`unknown perceptor: ${id}`);
    this.network.registry.setEnabled(id, enabled);
    await this.prisma.perceptorState.upsert({
      where: { perceptorId: id },
      create: { perceptorId: id, domain: perceptor.definition.domain, enabled, status: enabled ? 'healthy' : 'disabled' },
      update: { enabled, status: enabled ? 'healthy' : 'disabled' },
    });
  }
}
