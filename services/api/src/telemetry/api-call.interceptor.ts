import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, tap } from 'rxjs';
import { withTelemetryContext } from '@tradew/ai-core';
import { TelemetryService } from './telemetry.service';

/**
 * Records every HTTP request the API serves, and establishes the correlation
 * context that ties the request to the AI calls it causes.
 *
 * Registered globally in `TelemetryModule` rather than per-controller: partial
 * coverage of an observability surface is worse than none, because an operator
 * reading a request-volume chart has no way to know which routes were left out.
 *
 * Two details worth stating explicitly:
 *
 * · **The route TEMPLATE is logged, not the URL.** `/market-data/quote/:symbol`
 *   groups; `/market-data/quote/NIFTY` does not, and it also drags an
 *   identifier into a table an operator reads casually. Path params are kept
 *   separately in `routeParams` so a specific bad request is still findable.
 *   Query strings are dropped entirely — they carry search terms and tokens.
 *
 * · **Errors are recorded, then rethrown untouched.** The `error` branch of
 *   `tap` observes the failure; it does not swallow, translate or delay it.
 */
@Injectable()
export class ApiCallInterceptor implements NestInterceptor {
  constructor(private readonly telemetry: TelemetryService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<TelemetryRequest>();
    const res = http.getResponse<{ statusCode?: number }>();
    const startedAt = Date.now();

    // Honour an inbound correlation id when a caller supplies one (the web app
    // sends it so a browser-side trace and the server row share an id), but
    // never trust its shape — it lands in a rendered table.
    const inbound = typeof req.headers?.['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined;
    const requestId = inbound && /^[\w-]{8,64}$/.test(inbound) ? inbound : randomUUID();
    req.requestId = requestId;

    const finish = (statusCode: number, error?: string) => {
      this.telemetry.recordApiCall({
        requestId,
        method: req.method ?? 'GET',
        path: routeTemplate(req),
        routeParams: req.params && Object.keys(req.params).length ? req.params : undefined,
        statusCode,
        durationMs: Date.now() - startedAt,
        // `req.user` is set by AuthGuard, which runs before interceptors
        // complete, so authenticated requests are attributed correctly.
        userId: req.user?.sub ?? req.user?.userId,
        ip: req.ip,
        userAgent: typeof req.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
        error,
      });
    };

    // The whole downstream handler runs inside the telemetry context, so any
    // LLM call it makes — however deep — is stamped with this requestId
    // without a single business signature having to carry it.
    return withTelemetryContext({ requestId, userId: req.user?.sub ?? req.user?.userId }, () =>
      next.handle().pipe(
        tap({
          next: () => finish(res.statusCode ?? 200),
          error: (err: unknown) => {
            const status =
              (err as { status?: number; statusCode?: number })?.status ??
              (err as { statusCode?: number })?.statusCode ??
              500;
            finish(status, err instanceof Error ? err.message : String(err));
          },
        }),
      ),
    );
  }
}

interface TelemetryRequest {
  method?: string;
  url?: string;
  ip?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  user?: { sub?: string; userId?: string };
  requestId?: string;
}

/**
 * Express fills `req.route.path` with the matched template once routing has
 * happened. When it hasn't — a 404, or a request rejected by a guard before a
 * route matched — fall back to the URL with its query string stripped, which
 * is the only information that exists at that point.
 */
function routeTemplate(req: TelemetryRequest): string {
  if (req.route?.path) return req.route.path;
  return (req.url ?? '/').split('?')[0].slice(0, 300);
}
