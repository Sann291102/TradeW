// The product API client, not the admin one: `/knowledge/*` is an ordinary
// authenticated route that predates the portal, so it needs the bearer token
// but not the operator token. Moved under lib/admin/ on 2026-08-03 with the
// route itself — it has no remaining caller outside the console.
import { api, API_URL } from '../api';

// Mirrors services/api/src/knowledge/knowledge.service.ts contracts.
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
  tree: () => api('/knowledge/tree') as Promise<TreeNode>,
  file: (path: string) => api(`/knowledge/file?path=${encodeURIComponent(path)}`) as Promise<FileContent>,
  recent: (limit = 20) => api(`/knowledge/recent?limit=${limit}`) as Promise<RecentItem[]>,
  search: (q: string, limit = 50) => api(`/knowledge/search?q=${encodeURIComponent(q)}&limit=${limit}`) as Promise<SearchHit[]>,
  graph: () => api('/knowledge/graph') as Promise<GraphData>,
  activity: (since?: number) => api(`/knowledge/activity${since ? `?since=${since}` : ''}`) as Promise<ActivityEvent[]>,
};

/**
 * Subscribe to the live change stream. Uses EventSource (dev-gated on the
 * server, so no bearer token) and returns an unsubscribe function. The
 * callback fires per file create/modify/delete; callers re-fetch the authed
 * content endpoints in response.
 */
export function subscribeToChanges(
  onChange: (ev: ActivityEvent) => void,
  handlers: { onOpen?: () => void; onError?: () => void } = {},
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const source = new EventSource(`${API_URL}/knowledge/stream`);
  source.onopen = () => handlers.onOpen?.();
  source.addEventListener('change', (e) => {
    try {
      onChange(JSON.parse((e as MessageEvent).data) as ActivityEvent);
    } catch {
      /* ignore malformed frame */
    }
  });
  source.onerror = () => handlers.onError?.();
  return () => source.close();
}
