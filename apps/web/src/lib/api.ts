export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export function getToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('tradew_token');
}

export function getRefreshToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('tradew_refresh_token');
}

export function setSession(accessToken: string, refreshToken?: string) {
  localStorage.setItem('tradew_token', accessToken);
  if (refreshToken) localStorage.setItem('tradew_refresh_token', refreshToken);
}

export function setToken(token: string) {
  localStorage.setItem('tradew_token', token);
}

export function clearToken() {
  localStorage.removeItem('tradew_token');
  localStorage.removeItem('tradew_refresh_token');
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
