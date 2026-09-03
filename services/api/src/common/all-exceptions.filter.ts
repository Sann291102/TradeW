import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/**
 * The one place an unhandled error becomes an HTTP response.
 *
 * ── WHY THIS EXISTS (the 2026-09-03 sign-in report) ───────────────────────
 *
 * `POST /auth/login` returned `{"statusCode":500,"message":"Internal server
 * error"}` for every account, on two different machines. That body is Nest's
 * default for any exception it does not recognise, and with no filter
 * installed it was the whole of what anyone — user, operator, or the developer
 * reading a screenshot — had to go on. The actual cause was a database one
 * migration behind: Prisma's generated SELECT names every column a model
 * declares, so `user.findUnique` threw P2022 on a missing `User` column and
 * sign-in died before it ever reached bcrypt.
 *
 * Three things were wrong with that, and this filter fixes all three:
 *
 *  1. A CONFIGURATION fault was reported as 500 (a bug in this service). An
 *     un-migrated or unreachable database is 503 — the request would have
 *     succeeded against a correctly provisioned deployment, and 503 is what
 *     tells a load balancer and an operator to look at the environment.
 *  2. The response named nothing. Every error now carries a `requestId` that
 *     also appears in the server log line and the `X-Request-Id` header, so a
 *     screenshot is enough to find the stack trace.
 *  3. Operational faults are actionable, so they say what to do. That detail
 *     is withheld in production, where the audience is the public.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: an `HttpException` is passed through
 * byte-for-byte — same status, same body. Validation 400s (class-validator's
 * message array), 401s, and the throttler's 429 with its `Retry-After` header
 * are contracts clients already depend on, and this filter is not the place to
 * renegotiate them.
 */

/** Prisma codes that mean "the database does not have the schema this build
 *  was compiled against" — i.e. migrations have not been applied. */
const SCHEMA_DRIFT_CODES = new Set([
  'P2021', // table does not exist
  'P2022', // column does not exist
]);

/** Prisma codes that mean "the database could not be reached or opened". */
const UNREACHABLE_CODES = new Set([
  'P1000', // authentication failed
  'P1001', // cannot reach database server
  'P1002', // connection timed out
  'P1008', // operation timed out
  'P1010', // access denied
  'P1017', // server closed the connection
]);

interface ClassifiedError {
  status: number;
  message: string;
  error: string;
  /** Operator-facing remedy. Included in the response outside production only. */
  detail?: string;
}

/**
 * A caller-supplied `X-Request-Id` is echoed so a trace can span the browser
 * and the API, but it lands in log lines, so it is bounded and stripped to
 * characters that cannot forge a second log entry. Anything else is replaced
 * rather than rejected — the id is a convenience, never a credential.
 */
export function sanitiseRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Map a thrown value to the response it deserves.
 *
 * Exported for tests: the classification is the whole point of this file, and
 * asserting it through a live Nest app would test Express instead.
 */
export function classify(exception: unknown): ClassifiedError {
  const code =
    exception instanceof Prisma.PrismaClientKnownRequestError ? exception.code : undefined;

  if (code && SCHEMA_DRIFT_CODES.has(code)) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      message: 'The server is not ready: its database is missing tables or columns this build requires.',
      detail:
        `Prisma ${code}: ${sentence(describe(exception))} The database has not had every migration applied. ` +
        'Run `npm run db:migrate` from the repo root (deployed databases: `npm run migrate:deploy -w @tradew/database`).',
    };
  }

  if (
    exception instanceof Prisma.PrismaClientInitializationError ||
    (code && UNREACHABLE_CODES.has(code))
  ) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      message: 'The server could not reach its database. Try again shortly.',
      detail: `Prisma${code ? ` ${code}` : ''}: ${sentence(describe(exception))} Check that Postgres is running and DATABASE_URL is correct.`,
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    error: 'Internal Server Error',
    message: 'Internal server error',
  };
}

/**
 * The one sentence that says what is actually wrong.
 *
 * A Prisma error message is a rendered code frame — the failing call, the
 * source path, five numbered lines of the caller, and only THEN the reason:
 *
 *     Invalid `this.prisma.user.findUnique()` invocation in
 *     /srv/api/src/auth/auth.service.ts:109:41
 *       108 async login(email: string, password: string) {
 *     → 109   const user = await this.prisma.user.findUnique(
 *     The column `User.agentPaperTradingEnabledAt` does not exist ...
 *
 * Flattened whole and truncated, the frame fills the field and the last line —
 * the only part naming the missing column — is what gets cut. So the frame is
 * dropped here. It is not lost: the full message and stack still go to the log,
 * where a code frame is exactly the right shape.
 */
export function describe(exception: unknown): string {
  const raw = exception instanceof Error ? exception.message : String(exception);
  const meaningful = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(→\s*)?\d+(\s|$)/.test(line))          // numbered frame lines
    .filter((line) => !/^Invalid .*invocation( in)?$/.test(line)) // the frame's header
    .filter((line) => !/^[~./A-Za-z]:?[^\s]*:\d+:\d+$/.test(line)); // its file:line:col
  const text = (meaningful.length > 0 ? meaningful : [raw]).join(' ').trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Exactly one trailing full stop, so joining a Prisma message (which usually
 *  ends in one) to the remedy that follows it never reads as "database..". */
function sentence(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, '');
  return trimmed.length > 0 ? `${trimmed}.` : '';
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const requestId = sanitiseRequestId(req?.headers?.['x-request-id']) ?? randomUUID();
    const method = String(req?.method ?? '');
    const path = String(req?.originalUrl ?? req?.url ?? '').split('?')[0];

    // A response already on the wire (SSE streams) cannot be given a body. The
    // log line is still worth writing — it is the only record left.
    if (res?.headersSent) {
      this.logger.error(`${method} ${path} failed after the response had begun [${requestId}]`, stackOf(exception));
      return;
    }

    res?.setHeader?.('X-Request-Id', requestId);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // Nest's own default body, unchanged — see the header note about not
      // renegotiating contracts clients already depend on.
      const body = exception.getResponse();
      if (status >= 500) {
        this.logger.error(`${status} ${method} ${path} [${requestId}]`, stackOf(exception));
      }
      res.status(status).json(
        typeof body === 'object' && body !== null ? { ...body, requestId } : { statusCode: status, message: body, requestId },
      );
      return;
    }

    const classified = classify(exception);
    this.logger.error(
      `${classified.status} ${method} ${path} [${requestId}]${classified.detail ? ` — ${classified.detail}` : ''}`,
      stackOf(exception),
    );

    res.status(classified.status).json({
      statusCode: classified.status,
      error: classified.error,
      message: classified.message,
      requestId,
      // The remedy names table and column, and the shape of the deployment.
      // That is exactly what the operator of a dev or self-hosted stack needs
      // and exactly what a public deployment must not volunteer.
      ...(classified.detail && process.env.NODE_ENV !== 'production' ? { detail: classified.detail } : {}),
    });
  }
}

function stackOf(exception: unknown): string {
  return exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
}
