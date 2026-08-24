import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AdminGuard } from '../admin/admin.guard';
import { AdminAccessGuard } from '../admin/admin-access.guard';
import { OperatorService } from '../admin/operator/operator.service';
import { CognitionModule } from '../cognition/cognition.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { GraphController } from './graph.controller';
import { GraphEventsService } from './graph.events';
import { GraphProjectionService } from './graph.projection';
import { GraphService } from './graph.service';
import { TopologyService } from './topology.service';

/**
 * The system graph — one projection of the whole platform, read by two console
 * pages (the Knowledge Graph and the Neural Network) that must never disagree
 * about what exists.
 *
 * ## Why this module sits where it does in the dependency order
 *
 * It is placed LAST in `AppModule`'s import list, and that placement is load-
 * bearing. `TopologyService` reads the container's module registry to discover
 * routes and controllers; a module registered after this one would be missing
 * from the graph, and the omission would be silent. Last means complete.
 *
 * ## Direction of every dependency here
 *
 * Every arrow points INTO this module, never out of it:
 *
 *  · `CognitionModule` — the graph reads the network's roster and layer state.
 *    The network has no idea this module exists, exactly as `AdminModule`
 *    consumes it today.
 *  · `KnowledgeModule` — the graph reads the vault index. Same shape: the vault
 *    watcher does not know it is being drawn.
 *  · `TelemetryModule` and `PrismaModule` are `@Global`, so neither is listed.
 *
 * Nothing is exported. If another module ever needs graph data, that is a sign
 * the query belongs in that module and not that this one should be reached
 * into — the same rule `AdminModule` states for itself.
 *
 * `DiscoveryModule` is imported for `ModulesContainer`, which is how
 * `TopologyService` reads what actually booted rather than what the source
 * tree suggests booted.
 *
 * ## Why the admin guards are re-provided
 *
 * `AdminModule` deliberately exports nothing, so — exactly as `KnowledgeModule`
 * already does — the composed `AdminAccessGuard` and the two providers it needs
 * are listed here. That keeps the graph behind the identical double factor
 * (operator token + admin identity) without making the admin module exportable,
 * which is the property that lets it be dropped from a deployment.
 */
@Module({
  imports: [DiscoveryModule, CognitionModule, KnowledgeModule],
  controllers: [GraphController],
  providers: [
    TopologyService,
    GraphProjectionService,
    GraphService,
    GraphEventsService,
    AdminGuard,
    OperatorService,
    AdminAccessGuard,
  ],
})
export class GraphModule {}
