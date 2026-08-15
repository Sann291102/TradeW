'use client';

/**
 * Client-side admin API.
 *
 * All calls go to /api/proxy/* — the Next.js Route Handlers that attach the
 * operator token server-side and forward to services/api/admin/*. The raw
 * ADMIN_API_TOKEN is never in the browser; the session cookie is the auth
 * signal the proxy checks before forwarding.
 *
 * This module mirrors the interface of apps/web/src/lib/admin/api.ts so page
 * components transplanted from apps/web need only a single import-path change.
 */

export class AdminApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
  }
}

export async function adminApi<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/proxy${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
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
 * Subscribe to the live agent SSE stream.
 *
 * EventSource sends cookies automatically for same-origin requests, so the
 * session cookie flows to /api/stream without any extra credentials. The Route
 * Handler there checks the cookie and proxies to services/api with the operator
 * token — the token never touches the browser.
 */
export function subscribeToAgentStream(handlers: {
  onActivity?: (event: AgentActivityFrame) => void;
  onRun?: (event: AgentRunFrame) => void;
  onAi?: (event: AiCallFrame) => void;
  onOpen?: () => void;
  onError?: () => void;
}): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const source = new EventSource('/api/stream');
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onError?.();

  const on = <T,>(name: string, fn?: (e: T) => void) => {
    if (!fn) return;
    source.addEventListener(name, (e) => {
      try { fn(JSON.parse((e as MessageEvent).data) as T); } catch { /* ignore */ }
    });
  };

  on<AgentActivityFrame>('activity', handlers.onActivity);
  on<AgentRunFrame>('run', handlers.onRun);
  on<AiCallFrame>('ai', handlers.onAi);

  return () => source.close();
}

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

// ---------------------------------------------------------------------------
// Wire shapes — mirror services/api admin contracts
// ---------------------------------------------------------------------------

export type AgentState = 'queued' | 'thinking' | 'sending' | 'receiving' | 'done' | 'error' | 'idle';

export interface AgentActivityFrame { runId: string; system: string; agent: string; state: AgentState; peer?: string; detail?: string; durationMs?: number; at: number; }
export interface AgentRunFrame { phase: 'start' | 'end'; runId: string; system: string; trigger?: string; symbol?: string; status?: 'ok' | 'error'; surfaced?: boolean; confidence?: number; durationMs?: number; at: number; }
export interface AiCallFrame { system: string; agent: string; provider: string; model: string; latencyMs: number; costUsd: number; status: string; }
export interface AgentNode { name: string; label: string; role: string; state: AgentState; peer: string | null; detail: string | null; lastSeen: string | null; transitions24h: number; }
export interface Overview { windowHours: number; api: { total: number; errors: number; errorRate: number; avgLatencyMs: number }; ai: { calls: number; errors: number; costUsd: number; promptTokens: number; completionTokens: number }; agents: { runs: number; surfaced: number; silentRate: number }; orders: { total: number; rejected: number; trades: number }; users: { total: number; new: number }; }
export interface ApiCallRow { id: string; requestId: string; method: string; path: string; statusCode: number; durationMs: number; userId: string | null; ip: string | null; error: string | null; createdAt: string; user: { email: string } | null; }
export interface AiCallRow { id: string; requestId: string | null; system: string; agent: string; provider: string; model: string; tier: string | null; promptTokens: number; completionTokens: number; costUsd: number; latencyMs: number; status: string; error: string | null; createdAt: string; }
export interface AgentSummaryRow { system: string; agent: string; calls: number; costUsd: number; promptTokens: number; completionTokens: number; avgLatencyMs: number; maxLatencyMs: number; failures: number; }
export interface RunRow { runId: string; system: string; trigger: string; symbol: string | null; status: string; surfaced: boolean; confidence: number | null; agentsRan: string[]; durationMs: number | null; startedAt: string; error: string | null; }
export interface OrderRow { id: string; status: string; side: string; type: string; quantity: number; filledQuantity: number; price: string | null; avgFillPrice: string | null; rejectReason: string | null; placedAt: string; user: { id: string; email: string } | null; instrument: { symbol: string; displayName: string; type: string } | null; }
export interface UserRow { id: string; email: string; country: string; experienceLevel: string | null; isAdmin: boolean; createdAt: string; _count: { orders: number; trades: number; notifications: number }; subscriptions: Array<{ status: string; planId: string }>; }
export interface AuditRow { id: string; eventType: string; userId: string | null; ip: string | null; createdAt: string; user: { email: string } | null; }
export interface HealthReport { services: Array<{ name: string; status: 'up' | 'down'; latencyMs: number; error?: string }>; serverErrorsLast5m: number; oldestPendingOrder: { id: string; createdAt: string } | null; uptimeSeconds: number; memoryMb: number; nodeVersion: string; checkedAt: string; }
export interface RouteStatRow { method: string; path: string; count: number; avgMs: number; maxMs: number; errors: number; }
export interface AiModelRow { provider: string; model: string; calls: number; costUsd: number; promptTokens: number; completionTokens: number; avgLatencyMs: number; failures: number; }
export interface PulseRow { bucket: string; total: number; errors: number; avgMs: number; }
export interface DomainRow { domain: string; percepts: number; meanSalience: number; lastAt: string | null; perHour: number; }
export interface TimeseriesRow { bucket: string; ok?: number; client?: number; server?: number; avgMs?: number; calls?: number; cost?: number; tokens?: number; }
export type PerceptDomain = 'market' | 'application' | 'assistant' | 'learning' | 'platform';
export type NeuralLayerId = 'L1_PERCEPTION' | 'L2_ENCODING' | 'L3_ASSOCIATION' | 'L4_CONSOLIDATION';
export type PerceptorStatus = 'healthy' | 'stale' | 'failing' | 'quarantined' | 'disabled';
export interface PerceptorHealthRow { perceptorId: string; status: PerceptorStatus; lastSensedAt: string | null; lastPerceptAt: string | null; consecutiveFailures: number; lastError: string | null; perceptsLastPass: number; meanSalience: number; totalPercepts: number; }
export interface PerceptorRow { id: string; domain: PerceptDomain; label: string; description: string; cadence: 'event' | 'interval' | 'manual'; expectedIntervalMs?: number; emits: string[]; enabled: boolean; health: PerceptorHealthRow | null; }
export interface LayerRow { id: NeuralLayerId; index: number; label: string; description: string; passes: number; inputs: number; outputs: number; ratio: number; }
export interface CognitionOverview { enabled: boolean; isLeader: boolean; passIntervalMs: number; at: string; layers: LayerRow[]; perceptors: PerceptorHealthRow[]; synapses: { total: number; proven: number; unproven: number; meanWeight: number; totalActivations: number; totalReinforcements: number; pendingTraces: number; }; }
export interface EpisodeRow { id: string; episodeId: string; domain: string | null; trigger: string; status: 'running' | 'ok' | 'degraded' | 'error'; perceptCount: number; gatedCount: number; collapsedCount: number; hypothesisCount: number; promotedCount: number; proposalCount: number; layerTimings: Record<string, number> | null; error: string | null; reward: number | null; rewardReason: string | null; scoredAt: string | null; startedAt: string; finishedAt: string | null; }
export interface PerceptRow { id: string; perceptorId: string; domain: PerceptDomain; kind: string; subjectType: string; subjectId: string; observedAt: string; salience: number; confidence: number; features: Record<string, number>; summary: string; tags: string[]; occurrences: number; episodeId: string; createdAt: string; }
export interface SynapseRow { id: string; layer: NeuralLayerId; source: string; target: string; weight: number; activations: number; reinforcements: number; meanReward: number; lastActivatedAt: string | null; lastReinforcedAt: string | null; }
export interface ProposalRow { id: string; episodeId: string; domain: PerceptDomain; kind: 'investigate' | 'tune' | 'learn' | 'notify'; title: string; rationale: string; confidence: number; perceptIds: string[]; status: 'pending' | 'accepted' | 'dismissed' | 'done'; resolvedBy: string | null; resolution: string | null; resolvedAt: string | null; createdAt: string; }
export type ActivityEvent = import('./knowledge').ActivityEvent;

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '' && !Number.isNaN(value)) search.set(key, String(value));
  }
  return search.toString();
}

export const admin = {
  overview: (hours = 24) => adminApi<Overview>(`/overview?hours=${hours}`),
  health: () => adminApi<HealthReport>('/health'),
  apiCalls: (q: Record<string, string | number | undefined> = {}) => adminApi<ApiCallRow[]>(`/api-calls?${qs(q)}`),
  apiTimeseries: (hours = 24) => adminApi<TimeseriesRow[]>(`/api-calls/timeseries?hours=${hours}`),
  routeStats: (hours = 24) => adminApi<RouteStatRow[]>(`/api-calls/routes?hours=${hours}`),
  aiCalls: (q: Record<string, string | number | undefined> = {}) => adminApi<AiCallRow[]>(`/ai/calls?${qs(q)}`),
  aiByAgent: (hours = 24) => adminApi<AgentSummaryRow[]>(`/ai/by-agent?hours=${hours}`),
  aiByModel: (hours = 24) => adminApi<AiModelRow[]>(`/ai/by-model?hours=${hours}`),
  aiTimeseries: (hours = 24) => adminApi<TimeseriesRow[]>(`/ai/timeseries?hours=${hours}`),
  apiPulse: (minutes = 30) => adminApi<PulseRow[]>(`/api-calls/pulse?minutes=${minutes}`),
  agentStates: (system = 'sentinel') => adminApi<AgentNode[]>(`/agents/states?system=${system}`),
  runs: (q: Record<string, string | number | undefined> = {}) => adminApi<RunRow[]>(`/agents/runs?${qs(q)}`),
  run: (runId: string) => adminApi(`/agents/runs/${encodeURIComponent(runId)}`),
  orders: (q: Record<string, string | number | undefined> = {}) => adminApi<OrderRow[]>(`/orders?${qs(q)}`),
  orderStats: (hours = 24) => adminApi<{ byStatus: Array<{ status: string; count: number }>; bySide: Array<{ side: string; count: number }>; trades: number }>(`/orders/stats?hours=${hours}`),
  trades: (limit = 100, hours = 24) => adminApi(`/trades?limit=${limit}&hours=${hours}`),
  users: (q: Record<string, string | number | undefined> = {}) => adminApi<UserRow[]>(`/users?${qs(q)}`),
  audit: (q: Record<string, string | number | undefined> = {}) => adminApi<AuditRow[]>(`/audit?${qs(q)}`),
  setAdmin: (email: string, isAdmin: boolean) => adminApi('/users/set-admin', { method: 'POST', body: JSON.stringify({ email, isAdmin }) }),
  cognition: {
    overview: () => adminApi<CognitionOverview>('/cognition/overview'),
    perceptors: () => adminApi<PerceptorRow[]>('/cognition/perceptors'),
    domains: (hours = 24) => adminApi<DomainRow[]>(`/cognition/domains?hours=${hours}`),
    episodes: (q: Record<string, string | number | undefined> = {}) => adminApi<EpisodeRow[]>(`/cognition/episodes?${qs(q)}`),
    episode: (episodeId: string) => adminApi<{ episode: EpisodeRow | null; percepts: PerceptRow[]; proposals: ProposalRow[] }>(`/cognition/episodes/${encodeURIComponent(episodeId)}`),
    percepts: (q: Record<string, string | number | undefined> = {}) => adminApi<PerceptRow[]>(`/cognition/percepts?${qs(q)}`),
    synapses: (q: Record<string, string | number | undefined> = {}) => adminApi<SynapseRow[]>(`/cognition/synapses?${qs(q)}`),
    proposals: (q: Record<string, string | number | undefined> = {}) => adminApi<ProposalRow[]>(`/cognition/proposals?${qs(q)}`),
    setPerceptorEnabled: (id: string, enabled: boolean) => adminApi(`/cognition/perceptors/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
    resolveProposal: (id: string, status: 'accepted' | 'dismissed' | 'done', resolution?: string) => adminApi(`/cognition/proposals/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ status, resolution }) }),
    run: (domain?: PerceptDomain) => adminApi<EpisodeRow>('/cognition/run', { method: 'POST', body: JSON.stringify(domain ? { domain } : {}) }),
  },
};
