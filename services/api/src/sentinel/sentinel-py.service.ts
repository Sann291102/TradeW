import { BadGatewayException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Outbound client for services/sentinel-py — the user-facing half of the
 * Python Sentinel wiring.
 *
 * `SentinelPyController` (the `/internal/sentinel-py/notify` ingress) is the
 * other direction: sentinel-py pushing notifications in. This is the browser
 * reaching sentinel-py out, and it is what makes user-authored strategies
 * reachable at all — before it, everything in sentinel-py was service-to-
 * service only.
 *
 * ## userId is never taken from the client
 *
 * sentinel-py scopes every query by a `userId` query parameter, which is
 * correct for a service that only its own gateway can reach. The gateway is
 * this class, and it fills that parameter from the authenticated JWT
 * (`req.user.sub`) — never from anything the caller sent. A route that let a
 * client name the user would let any logged-in account read and edit every
 * other account's strategies.
 */
@Injectable()
export class SentinelPyService {
  private readonly logger = new Logger(SentinelPyService.name);

  private get baseUrl(): string {
    return (process.env.SENTINEL_PY_SERVICE_URL ?? 'http://localhost:4011').replace(/\/$/, '');
  }

  private get headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-service-token': process.env.SENTINEL_PY_SERVICE_TOKEN ?? '',
    };
  }

  /**
   * One place that talks to sentinel-py, so timeouts, error mapping and the
   * service token are not re-implemented per route.
   *
   * A 4xx from sentinel-py is forwarded as-is (it is a real answer about the
   * request — 404 for someone else's strategy, 400 for a zero-risk position).
   * Anything else becomes 502/503: the caller should not see a Python stack
   * trace, and "sentinel-py is down" is not "your request was wrong".
   */
  private async call<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers: this.headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(Number(process.env.SENTINEL_PY_TIMEOUT_MS ?? 8000)),
      });
    } catch (err) {
      this.logger.warn(`sentinel-py unreachable (${init.method} ${path}): ${err}`);
      throw new ServiceUnavailableException('Sentinel strategy service is not reachable');
    }

    if (res.status >= 400 && res.status < 500) {
      // Forward the ORIGINAL status, not a blanket 502. "You asked for a
      // strategy that isn't yours" is a 404 the caller can act on; turning it
      // into "bad gateway" tells them the platform is broken when it is not.
      const detail = await res.json().catch(() => null);
      const message =
        (detail && typeof detail === 'object' && 'detail' in detail
          ? String((detail as { detail: unknown }).detail)
          : null) ?? `Sentinel rejected the request (${res.status})`;
      throw new HttpException(message, res.status);
    }
    if (!res.ok) {
      this.logger.warn(`sentinel-py ${res.status} on ${init.method} ${path}`);
      throw new BadGatewayException('Sentinel strategy service failed');
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private scoped(path: string, userId: string): string {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}userId=${encodeURIComponent(userId)}`;
  }

  // --- strategies ---------------------------------------------------------

  /** Preview only: turns free text into structured rules WITHOUT saving, so
   * the user can confirm or edit before anything is persisted. */
  parseStrategy(text: string) {
    return this.call('/strategies/parse', { method: 'POST', body: { text } });
  }

  /** The adoptable catalogue — a menu, not a recommendation. */
  listTemplates() {
    return this.call('/strategies/templates', { method: 'GET' });
  }

  /** Adopt a template: it becomes the user's own strategy, editable like one
   * they typed. sentinel-py refuses (409) any template the watch engine
   * cannot yet evaluate rather than saving something inert. */
  adoptTemplate(userId: string, templateId: string, name?: string) {
    const suffix = name ? `&name=${encodeURIComponent(name)}` : '';
    return this.call(
      `${this.scoped(`/strategies/templates/${encodeURIComponent(templateId)}/adopt`, userId)}${suffix}`,
      { method: 'POST' },
    );
  }

  createStrategy(userId: string, body: unknown) {
    return this.call(this.scoped('/strategies', userId), { method: 'POST', body });
  }

  listStrategies(userId: string) {
    return this.call(this.scoped('/strategies', userId), { method: 'GET' });
  }

  getStrategy(userId: string, id: string) {
    return this.call(this.scoped(`/strategies/${encodeURIComponent(id)}`, userId), { method: 'GET' });
  }

  updateStrategy(userId: string, id: string, body: unknown) {
    return this.call(this.scoped(`/strategies/${encodeURIComponent(id)}`, userId), { method: 'PATCH', body });
  }

  archiveStrategy(userId: string, id: string) {
    return this.call(this.scoped(`/strategies/${encodeURIComponent(id)}`, userId), { method: 'DELETE' });
  }

  /** How the user's OWN strategy has behaved: funnel, outcomes, R stats.
   * Describes history; never ranks strategies or proposes a trade. */
  strategyPerformance(userId: string, id: string) {
    return this.call(this.scoped(`/strategies/${encodeURIComponent(id)}/performance`, userId), {
      method: 'GET',
    });
  }

  // --- watches ------------------------------------------------------------

  createWatch(userId: string, body: unknown) {
    return this.call(this.scoped('/watch', userId), { method: 'POST', body });
  }

  listWatches(userId: string) {
    return this.call(this.scoped('/watch', userId), { method: 'GET' });
  }

  /** The per-watch event stream the workspace feed renders. */
  timeline(userId: string, watchId: string, limit = 100) {
    return this.call(
      this.scoped(`/watch/${encodeURIComponent(watchId)}/timeline?limit=${limit}`, userId),
      { method: 'GET' },
    );
  }

  openPosition(userId: string, watchId: string, body: unknown) {
    return this.call(this.scoped(`/watch/${encodeURIComponent(watchId)}/position`, userId), {
      method: 'POST',
      body,
    });
  }

  closePosition(userId: string, watchId: string) {
    return this.call(this.scoped(`/watch/${encodeURIComponent(watchId)}/position`, userId), {
      method: 'DELETE',
    });
  }
}
