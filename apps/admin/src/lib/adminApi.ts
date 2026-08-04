/**
 * Server-only client for calling `services/api`'s admin-gated surface.
 *
 * Never imported from a Client Component — every caller is a Route Handler or
 * Server Component, where `process.env.ADMIN_API_TOKEN` is available. Calling
 * this from client code would still "work" during `next dev` (Next inlines
 * server env into route handlers, not into client bundles) but would be a
 * silent trust-boundary violation waiting to leak the token on the day
 * someone imports it from the wrong file, so every export here is used only
 * from `src/app/api/**\/route.ts`.
 */

const API_URL = process.env.ADMIN_API_URL || 'http://localhost:4000';

export class AdminApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
  }
}

export async function adminApi(path: string, options: RequestInit = {}): Promise<unknown> {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) throw new AdminApiError('ADMIN_API_TOKEN is not configured on the admin server', 500);

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-admin-token': token,
      ...(options.headers || {}),
    },
    cache: 'no-store',
  }).catch((err) => {
    throw new AdminApiError(`services/api unreachable: ${err instanceof Error ? err.message : String(err)}`, 502);
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new AdminApiError((data && (data.message as string)) || `services/api returned ${res.status}`, res.status);
  }
  return data;
}

/**
 * Probe an arbitrary URL for liveness — used by the health aggregator to
 * reach services that are NOT behind AdminTokenGuard (the Dhan bridge has no
 * auth of its own at all; sentinel's own health check needs no token).
 * Never throws: a health probe that could itself crash the health page would
 * defeat the entire point.
 */
export async function probe(url: string, timeoutMs = 4000): Promise<{ ok: boolean; status: number | null; latencyMs: number; error: string | null }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - started, error: null };
  } catch (err) {
    return { ok: false, status: null, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
