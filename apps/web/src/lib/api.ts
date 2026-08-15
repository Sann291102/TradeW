/**
 * Browser requests must stay same-origin unless an operator explicitly opts
 * into another public API URL.  In production this is routed by the edge
 * (`/api` -> services/api); it works behind Caddy today and Azure Front Door
 * / Container Apps during the migration.  Local development still sets
 * NEXT_PUBLIC_API_URL in apps/web/.env.local.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export function getToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('tradew_token');
}

export function getRefreshToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('tradew_refresh_token');
}

/**
 * A NON-SECRET marker that a session exists, mirrored into a cookie.
 *
 * The credential itself stays in localStorage — that has not changed. But
 * Next middleware runs on the server and cannot read localStorage, so without
 * some server-visible signal the route gate would have to be a client-side
 * redirect, which means rendering the workspace and yanking it away a tick
 * later. This cookie exists purely so the gate can decide before paint.
 *
 * It is deliberately valueless. Forging `tw_auth=1` gets you a workspace shell
 * that 401s on the first API call, because every real authorization decision
 * is still made by the API against the bearer token. Do not put anything in
 * here that would be worth stealing, and do not start trusting it for
 * anything but routing.
 */
export const AUTH_HINT_COOKIE = 'tw_auth';

function setAuthHint(present: boolean) {
  if (typeof document === 'undefined') return;
  document.cookie = present
    ? // Mirrors REFRESH_TOKEN_DAYS (30d) — the window in which a session can
      // still be revived by a refresh, not the 15-minute access token.
      `${AUTH_HINT_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`
    : `${AUTH_HINT_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

export function setSession(accessToken: string, refreshToken?: string) {
  localStorage.setItem('tradew_token', accessToken);
  if (refreshToken) localStorage.setItem('tradew_refresh_token', refreshToken);
  setAuthHint(true);
}

export function setToken(token: string) {
  localStorage.setItem('tradew_token', token);
  setAuthHint(true);
}

export function clearToken() {
  localStorage.removeItem('tradew_token');
  localStorage.removeItem('tradew_refresh_token');
  setAuthHint(false);
}

async function refreshAccessToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  setSession(data.accessToken, data.refreshToken);
  return true;
}

/**
 * An API call that reached the server and came back non-OK. Carries the HTTP
 * status so callers can tell "not signed in" (401) from "the service behind
 * this route is down" (5xx) — a distinction the UI must surface accurately
 * rather than collapsing every failure into one message. A thrown TypeError
 * (rather than this) means the API itself was unreachable.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api(path: string, options: RequestInit = {}) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 && await refreshAccessToken()) {
    const retryToken = getToken();
    const retry = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(retryToken ? { Authorization: `Bearer ${retryToken}` } : {}),
        ...(options.headers || {}),
      },
    });
    const retryData = await retry.json().catch(() => ({}));
    if (!retry.ok) throw new ApiError(retryData.message || 'API request failed', retry.status);
    return retryData;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.message || 'API request failed', res.status);
  return data;
}
