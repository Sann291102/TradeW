// The admin API client, not the product one. Moved under lib/admin/ on
// 2026-08-03 alongside the frontend route; the backend route itself only
// followed on 2026-08-04 (`/knowledge/*` -> `/admin/knowledge/*`, gated by
// AdminGuard) once an audit found the API had no auth of its own despite this
// file's earlier assumption that it did — see knowledge.controller.ts.
import { API_URL, getToken } from '../api';
import { adminApi, getAdminToken } from './api';

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
  tree: () => adminApi('/knowledge/tree') as Promise<TreeNode>,
  file: (path: string) => adminApi(`/knowledge/file?path=${encodeURIComponent(path)}`) as Promise<FileContent>,
  recent: (limit = 20) => adminApi(`/knowledge/recent?limit=${limit}`) as Promise<RecentItem[]>,
  search: (q: string, limit = 50) => adminApi(`/knowledge/search?q=${encodeURIComponent(q)}&limit=${limit}`) as Promise<SearchHit[]>,
  graph: () => adminApi('/knowledge/graph') as Promise<GraphData>,
  activity: (since?: number) => adminApi(`/knowledge/activity${since ? `?since=${since}` : ''}`) as Promise<ActivityEvent[]>,
};

/**
 * Subscribe to the live change stream. `EventSource` cannot set an
 * Authorization/X-Admin-Token header, so both credentials ride as query
 * params (`access_token`, `admin_token`) — the same pattern
 * `subscribeToAgentStream` in `lib/admin/api.ts` uses for `/admin/stream`.
 * `AdminGuard` allowlists this exact path for that fallback. Returns an
 * unsubscribe function; the callback fires per file create/modify/delete,
 * callers re-fetch the authed content endpoints in response.
 */
export function subscribeToChanges(
  onChange: (ev: ActivityEvent) => void,
  handlers: { onOpen?: () => void; onError?: () => void } = {},
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const params = new URLSearchParams();
  const session = getToken();
  const operator = getAdminToken();
  if (session) params.set('access_token', session);
  if (operator) params.set('admin_token', operator);
  const source = new EventSource(`${API_URL}/admin/knowledge/stream?${params.toString()}`);
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
