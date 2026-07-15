import { EntityRef } from '../domain/knowledge';

/**
 * Knowledge Graph interfaces — plain SQL node/edge tables behind this contract
 * (locked Q4: no Neo4j until scale demands it; swapping stores must not touch
 * consumers).
 */

export interface GraphNode {
  id: string;
  entity: EntityRef;
  /** free-form properties, e.g. { sector: 'ENERGY' } */
  properties: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  /** e.g. 'mentions', 'belongs_to_sector', 'derived_from', 'contradicts', 'supports' */
  relation: string;
  weight: number;
  properties: Record<string, unknown>;
  createdAt: Date;
}

export interface NeighborQuery {
  nodeId: string;
  relation?: string;
  direction?: 'out' | 'in' | 'both';
  limit?: number;
}

export interface KnowledgeGraph {
  upsertNode(entity: EntityRef, properties?: Record<string, unknown>): Promise<GraphNode>;
  upsertEdge(fromId: string, toId: string, relation: string, weight?: number, properties?: Record<string, unknown>): Promise<GraphEdge>;
  getNode(entityId: string): Promise<GraphNode | null>;
  neighbors(query: NeighborQuery): Promise<{ node: GraphNode; edge: GraphEdge }[]>;
  /** shortest relation path between two entities, bounded by maxHops */
  path(fromEntityId: string, toEntityId: string, maxHops?: number): Promise<GraphEdge[] | null>;
}
