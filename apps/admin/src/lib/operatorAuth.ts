/**
 * Server-side operator login — the standalone console's ONE authentication
 * boundary.
 *
 * The browser never calls `services/api /admin/operator/login` itself; it calls
 * `apps/admin /api/auth/login`, which calls this, which calls the API. That
 * indirection is the point: `ADMIN_API_TOKEN` lives only in this process's env,
 * the operator's password is verified server-to-server, and the browser sees
 * neither — it receives only the sealed session cookie the Route Handler sets.
 *
 * Never import this from a Client Component. Every export reads
 * `process.env.ADMIN_API_TOKEN`, which is present in Route Handlers and absent
 * from client bundles — importing it client-side would be a silent trust-
 * boundary violation, so it is used only from `src/app/api/**\/route.ts`.
 */

import type { OperatorIdentity } from './operatorSession';

const API_URL = process.env.ADMIN_API_URL ?? 'http://localhost:4000';

export type OperatorLoginOutcome =
  | { ok: true; assertion: string; operator: OperatorIdentity }
  | { ok: false; status: number; message: string };

/**
 * Exchange operator credentials for an assertion, presenting the operator token
 * as the first factor. Returns a structured outcome rather than throwing so the
 * Route Handler decides the HTTP shape.
 *
 * The upstream endpoint deliberately collapses every credential failure to one
 * 401 with a generic message (no account-enumeration oracle), so this function
 * has nothing finer to report than what it is handed.
 */
export async function loginOperator(email: string, password: string): Promise<OperatorLoginOutcome> {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return { ok: false, status: 500, message: 'ADMIN_API_TOKEN is not configured on the admin server' };

  const res = await fetch(`${API_URL}/admin/operator/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': token },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
  }).catch(() => null);

  if (!res) return { ok: false, status: 502, message: 'services/api is unreachable' };

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    return { ok: false, status: res.status, message: (data?.message as string) || 'Invalid operator credentials' };
  }

  const assertion = data?.assertion;
  const operator = (data?.operator ?? null) as { id?: unknown; email?: unknown; name?: unknown } | null;
  if (typeof assertion !== 'string' || !operator || typeof operator.id !== 'string') {
    return { ok: false, status: 502, message: 'services/api returned an unexpected login response' };
  }

  return {
    ok: true,
    assertion,
    operator: {
      id: operator.id,
      email: typeof operator.email === 'string' ? operator.email : email,
      name: typeof operator.name === 'string' ? operator.name : null,
    },
  };
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
