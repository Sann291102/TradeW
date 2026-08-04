import { API_URL, getToken } from '../api';

/**
 * The admin portal's API client.
 *
 * Separate from `lib/api.ts` for one reason that matters: every admin request
 * carries the operator token in `X-Admin-Token`, and that header must never be
 * attached to an ordinary product request. Sharing one client and branching on
 * the path would put the operator secret one bug away from being sent to every
 * endpoint the app calls.
 *
 * **Where the operator token lives.** `sessionStorage`, not `localStorage`, and
 * never in a cookie. The consequences are deliberate:
 *
 *  · It dies with the tab. An admin who closes the window is signed out of the
 *    operator surface even though their product session survives.
 *  · It is not shared across tabs, so it is not silently present in a tab the
 *    admin forgot about.
 *  · It is never sent automatically by the browser, so a CSRF against the admin
 *    API cannot succeed on ambient credentials alone.
 *
 * This is a real trade — a page reload in a new tab means re-entering the
 * token — and it is the right one for the surface that can read every user's
 * activity.
 */

const TOKEN_KEY = 'tradew_admin_token';

export function getAdminToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export class AdminApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
  }
}

/**
 * One admin request.
 *
 * Deliberately does NOT reuse `lib/api.ts`'s refresh-and-retry: a 401 here
 * means either the product session lapsed or the operator token is wrong, and
 * silently retrying obscures which. The portal shows the gate again instead.
 */
export async function adminApi<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const session = getToken();
  const operator = getAdminToken();

  const res = await fetch(`${API_URL}/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
      ...(operator ? { 'X-Admin-Token': operator } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AdminApiError(
      (body as { message?: string }).message || `Request failed (${res.status})`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

/**
 * Subscribe to the live agent-activity stream.
 *
 * `EventSource` cannot set headers, so the credentials ride as query params on
 * this one endpoint. That is a real weakening — URLs land in access logs — and
 * it is bounded deliberately: the stream endpoint is read-only, emits only
 * telemetry the portal already has via polling, and the operator token it
 * carries is tab-scoped and short-lived.
 *
 * `fetch`-with-ReadableStream would keep the headers, at the cost of
 * hand-rolling SSE framing and reconnection. If this stream ever carries
 * anything beyond agent state, that is the trade to revisit.
 */
export function subscribeToAgentStream(handlers: {
  onActivity?: (event: AgentActivityFrame) => void;
  onRun?: (event: AgentRunFrame) => void;
  onAi?: (event: AiCallFrame) => void;
  onOpen?: () => void;
  onError?: () => void;
}): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const params = new URLSearchParams();
  const session = getToken();
  const operator = getAdminToken();
  if (session) params.set('access_token', session);
  if (operator) params.set('admin_token', operator);

  const source = new EventSource(`${API_URL}/admin/stream?${params.toString()}`);
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onError?.();

  const on = <T,>(name: string, fn?: (e: T) => void) => {
    if (!fn) return;
    source.addEventListener(name, (e) => {
      try {
        fn(JSON.parse((e as MessageEvent).data) as T);
      } catch {
        /* ignore a malformed frame rather than tearing down the stream */
      }
    });
  };

  on<AgentActivityFrame>('activity', handlers.onActivity);
  on<AgentRunFrame>('run', handlers.onRun);
  on<AiCallFrame>('ai', handlers.onAi);

  return () => source.close();
}

// ---------------------------------------------------------------------------
// Wire shapes — mirror services/api/src/admin/admin.service.ts.
// ---------------------------------------------------------------------------

export type AgentState = 'queued' | 'thinking' | 'sending' | 'receiving' | 'done' | 'error' | 'idle';

export interface AgentActivityFrame {
  runId: string;
  system: string;
  agent: string;
  state: AgentState;
  peer?: string;
  detail?: string;
  durationMs?: number;
  at: number;
}

export interface AgentRunFrame {
  phase: 'start' | 'end';
  runId: string;
  system: string;
  trigger?: string;
  symbol?: string;
  status?: 'ok' | 'error';
  surfaced?: boolean;
  confidence?: number;
  durationMs?: number;
  at: number;
}

export interface AiCallFrame {
  system: string;
  agent: string;
  provider: string;
  model: string;
  latencyMs: number;
  costUsd: number;
  status: string;
}

export interface AgentNode {
  name: string;
  label: string;
  role: string;
  state: AgentState;
  peer: string | null;
  detail: string | null;
  lastSeen: string | null;
  transitions24h: number;
}

export interface Overview {
  windowHours: number;
  api: { total: number; errors: number; errorRate: number; avgLatencyMs: number };
  ai: { calls: number; errors: number; costUsd: number; promptTokens: number; completionTokens: number };
  agents: { runs: number; surfaced: number; silentRate: number };
  orders: { total: number; rejected: number; trades: number };
  users: { total: number; new: number };
}

export interface ApiCallRow {
  id: string;
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  userId: string | null;
  ip: string | null;
  error: string | null;
  createdAt: string;
  user: { email: string } | null;
}

export interface AiCallRow {
  id: string;
  requestId: string | null;
  system: string;
  agent: string;
  provider: string;
  model: string;
  tier: string | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface AgentSummaryRow {
  system: string;
  agent: string;
  calls: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  failures: number;
}

export interface RunRow {
  runId: string;
  system: string;
  trigger: string;
  symbol: string | null;
  status: string;
  surfaced: boolean;
  confidence: number | null;
  agentsRan: string[];
  durationMs: number | null;
  startedAt: string;
  error: string | null;
}

export interface OrderRow {
  id: string;
  status: string;
  side: string;
  type: string;
  quantity: number;
  filledQuantity: number;
  price: string | null;
  avgFillPrice: string | null;
  rejectReason: string | null;
  /** Order lifecycle timestamp. NOT `createdAt` — the Prisma model calls it
   *  `placedAt`, and Trade uses `executedAt`. */
  placedAt: string;
  user: { id: string; email: string } | null;
  instrument: { symbol: string; displayName: string; type: string } | null;
}

export interface UserRow {
  id: string;
  email: string;
  country: string;
  experienceLevel: string | null;
  isAdmin: boolean;
  createdAt: string;
  _count: { orders: number; trades: number; notifications: number };
  subscriptions: Array<{ status: string; planId: string }>;
}

export interface AuditRow {
  id: string;
  eventType: string;
  userId: string | null;
  ip: string | null;
  createdAt: string;
  user: { email: string } | null;
}

export interface HealthReport {
  services: Array<{ name: string; status: 'up' | 'down'; latencyMs: number; error?: string }>;
  serverErrorsLast5m: number;
  oldestPendingOrder: { id: string; createdAt: string } | null;
  uptimeSeconds: number;
  memoryMb: number;
  nodeVersion: string;
  checkedAt: string;
}

export interface RouteStatRow {
  method: string;
  path: string;
  count: number;
  avgMs: number;
  maxMs: number;
  errors: number;
}

export interface TimeseriesRow {
  bucket: string;
  ok?: number;
  client?: number;
  server?: number;
  avgMs?: number;
  calls?: number;
  cost?: number;
  tokens?: number;
}

export const admin = {
  overview: (hours = 24) => adminApi<Overview>(`/overview?hours=${hours}`),
  health: () => adminApi<HealthReport>('/health'),

  apiCalls: (q: Record<string, string | number | undefined> = {}) =>
    adminApi<ApiCallRow[]>(`/api-calls?${qs(q)}`),
  apiTimeseries: (hours = 24) => adminApi<TimeseriesRow[]>(`/api-calls/timeseries?hours=${hours}`),
  routeStats: (hours = 24) => adminApi<RouteStatRow[]>(`/api-calls/routes?hours=${hours}`),

  aiCalls: (q: Record<string, string | number | undefined> = {}) => adminApi<AiCallRow[]>(`/ai/calls?${qs(q)}`),
  aiByAgent: (hours = 24) => adminApi<AgentSummaryRow[]>(`/ai/by-agent?hours=${hours}`),
  aiTimeseries: (hours = 24) => adminApi<TimeseriesRow[]>(`/ai/timeseries?hours=${hours}`),

  agentStates: (system = 'sentinel') => adminApi<AgentNode[]>(`/agents/states?system=${system}`),
  runs: (q: Record<string, string | number | undefined> = {}) => adminApi<RunRow[]>(`/agents/runs?${qs(q)}`),
  run: (runId: string) => adminApi(`/agents/runs/${encodeURIComponent(runId)}`),

  orders: (q: Record<string, string | number | undefined> = {}) => adminApi<OrderRow[]>(`/orders?${qs(q)}`),
  orderStats: (hours = 24) =>
    adminApi<{ byStatus: Array<{ status: string; count: number }>; bySide: Array<{ side: string; count: number }>; trades: number }>(
      `/orders/stats?hours=${hours}`,
    ),
  trades: (limit = 100, hours = 24) => adminApi(`/trades?limit=${limit}&hours=${hours}`),

  users: (q: Record<string, string | number | undefined> = {}) => adminApi<UserRow[]>(`/users?${qs(q)}`),
  audit: (q: Record<string, string | number | undefined> = {}) => adminApi<AuditRow[]>(`/audit?${qs(q)}`),
  setAdmin: (email: string, isAdmin: boolean) =>
    adminApi('/users/set-admin', { method: 'POST', body: JSON.stringify({ email, isAdmin }) }),
};

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '' && !Number.isNaN(value)) search.set(key, String(value));
  }
  return search.toString();
}
