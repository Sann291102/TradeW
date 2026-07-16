import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EntityRef, GraphEdge, GraphNode, KnowledgeGraph, NeighborQuery } from '@tradew/ai-core';
import { PrismaService } from '../prisma.service';

/**
 * Knowledge graph over the GraphNode/GraphEdge tables (Phase 3 schema) —
 * plain SQL nodes/edges, no Neo4j (locked Q4 decision). Backs Concept
 * Learning's entity links and Historical Similarity's pattern lookups.
 */
@Injectable()
export class PrismaKnowledgeGraph implements KnowledgeGraph {
  constructor(private readonly prisma: PrismaService) {}

  async upsertNode(entity: EntityRef, properties: Record<string, unknown> = {}): Promise<GraphNode> {
    const row = await this.prisma.graphNode.upsert({
      where: { entityId: entity.id },
      update: { label: entity.label, properties: properties as Prisma.InputJsonValue },
      create: { entityType: entity.type, entityId: entity.id, label: entity.label, properties: properties as Prisma.InputJsonValue },
    });
    return this.nodeFromRow(row);
  }

  async upsertEdge(fromId: string, toId: string, relation: string, weight = 1, properties: Record<string, unknown> = {}): Promise<GraphEdge> {
    const existing = await this.prisma.graphEdge.findFirst({ where: { fromId, toId, relation } });
    const row = existing
      ? await this.prisma.graphEdge.update({ where: { id: existing.id }, data: { weight, properties: properties as Prisma.InputJsonValue } })
      : await this.prisma.graphEdge.create({ data: { fromId, toId, relation, weight, properties: properties as Prisma.InputJsonValue } });
    return this.edgeFromRow(row);
  }

  async getNode(entityId: string): Promise<GraphNode | null> {
    const row = await this.prisma.graphNode.findUnique({ where: { entityId } });
    return row ? this.nodeFromRow(row) : null;
  }

  async neighbors(query: NeighborQuery): Promise<{ node: GraphNode; edge: GraphEdge }[]> {
    const dir = query.direction ?? 'out';
    const edgeWhere = { ...(query.relation ? { relation: query.relation } : {}) };
    const out: { node: GraphNode; edge: GraphEdge }[] = [];

    if (dir === 'out' || dir === 'both') {
      const edges = await this.prisma.graphEdge.findMany({
        where: { fromId: query.nodeId, ...edgeWhere },
        take: query.limit ?? 20,
        include: { to: true },
      });
      for (const e of edges) out.push({ node: this.nodeFromRow(e.to), edge: this.edgeFromRow(e) });
    }
    if (dir === 'in' || dir === 'both') {
      const edges = await this.prisma.graphEdge.findMany({
        where: { toId: query.nodeId, ...edgeWhere },
        take: query.limit ?? 20,
        include: { from: true },
      });
      for (const e of edges) out.push({ node: this.nodeFromRow(e.from), edge: this.edgeFromRow(e) });
    }
    return out.slice(0, query.limit ?? 20);
  }

  /** BFS up to maxHops — a straightforward shortest relation path, not weighted/Dijkstra. */
  async path(fromEntityId: string, toEntityId: string, maxHops = 4): Promise<GraphEdge[] | null> {
    const fromNode = await this.getNode(fromEntityId);
    const toNode = await this.getNode(toEntityId);
    if (!fromNode || !toNode) return null;
    if (fromNode.id === toNode.id) return [];

    const visited = new Set<string>([fromNode.id]);
    let frontier: { nodeId: string; path: GraphEdge[] }[] = [{ nodeId: fromNode.id, path: [] }];

    for (let hop = 0; hop < maxHops; hop++) {
      const next: { nodeId: string; path: GraphEdge[] }[] = [];
      for (const { nodeId, path } of frontier) {
        const edges = await this.prisma.graphEdge.findMany({ where: { OR: [{ fromId: nodeId }, { toId: nodeId }] } });
        for (const e of edges) {
          const neighborId = e.fromId === nodeId ? e.toId : e.fromId;
          if (visited.has(neighborId)) continue;
          const newPath = [...path, this.edgeFromRow(e)];
          if (neighborId === toNode.id) return newPath;
          visited.add(neighborId);
          next.push({ nodeId: neighborId, path: newPath });
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return null;
  }

  private nodeFromRow(row: Prisma.GraphNodeGetPayload<Record<string, never>>): GraphNode {
    return {
      id: row.id,
      entity: { type: row.entityType, id: row.entityId, label: row.label ?? undefined },
      properties: (row.properties as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private edgeFromRow(row: Prisma.GraphEdgeGetPayload<Record<string, never>>): GraphEdge {
    return {
      id: row.id,
      fromId: row.fromId,
      toId: row.toId,
      relation: row.relation,
      weight: row.weight,
      properties: (row.properties as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
    };
  }
}
