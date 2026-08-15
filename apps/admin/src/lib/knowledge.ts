'use client';

import { adminApi } from './api';

export type NodeType = 'dir' | 'file';

export interface TreeNode {
  name: string;
  path: string;
  type: NodeType;
  children?: TreeNode[];
  size?: number;
  modified?: number;
}

export interface FileMeta {
  path: string;
  title: string;
  tags: string[];
  noteType?: string;
  size: number;
  created: number;
  modified: number;
}

export interface FileContent extends FileMeta {
  content: string;
  links: string[];
  backlinks: string[];
}

export interface RecentItem extends FileMeta {
  status: 'created' | 'modified';
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  matches: number;
  fields: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  group: string;
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ActivityType = 'created' | 'modified' | 'deleted';

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  path: string;
  category: string;
  title: string;
  at: number;
}

export const knowledge = {
  tree: () => adminApi<TreeNode>('/knowledge/tree'),
  file: (path: string) => adminApi<FileContent>(`/knowledge/file?path=${encodeURIComponent(path)}`),
  recent: (limit = 20) => adminApi<RecentItem[]>(`/knowledge/recent?limit=${limit}`),
  search: (q: string, limit = 50) => adminApi<SearchHit[]>(`/knowledge/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  graph: () => adminApi<GraphData>('/knowledge/graph'),
  activity: (since?: number) => adminApi<ActivityEvent[]>(`/knowledge/activity${since ? `?since=${since}` : ''}`),
};

/**
 * Subscribe to the live vault change stream.
 *
 * EventSource sends cookies automatically for same-origin requests. The Route
 * Handler at /api/stream/knowledge checks the session cookie and proxies to
 * services/api — the operator token never touches the browser.
 */
export function subscribeToChanges(
  onChange: (ev: ActivityEvent) => void,
  handlers: { onOpen?: () => void; onError?: () => void } = {},
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const source = new EventSource('/api/stream/knowledge');
  source.onopen = () => handlers.onOpen?.();
  source.addEventListener('change', (e) => {
    try { onChange(JSON.parse((e as MessageEvent).data) as ActivityEvent); } catch { /* ignore */ }
  });
  source.onerror = () => handlers.onError?.();
  return () => source.close();
}
