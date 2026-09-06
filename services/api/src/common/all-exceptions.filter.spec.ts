import { BadRequestException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter, classify, describe as describeError, sanitiseRequestId } from './all-exceptions.filter';

function knownRequestError(code: string, message: string) {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: '5.22.0' });
}

/** A minimal Express-shaped host, enough for the filter and nothing more. */
function host(headers: Record<string, string> = {}, headersSent = false) {
  const res = {
    headersSent,
    statusCode: 0,
    body: undefined as any,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  const req = { method: 'POST', url: '/auth/login', originalUrl: '/auth/login?x=1', headers };
  return {
    res,
    args: {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as any,
  };
}

describe('classify', () => {
  it('calls a missing column a 503, not a 500 — the deployment is at fault, not the request', () => {
    // The reported sign-in failure: a database one migration behind, so
    // Prisma's generated SELECT names a column that is not there.
    const result = classify(
      knownRequestError('P2022', 'The column `User.agentPaperTradingEnabledAt` does not exist in the current database.'),
    );
    expect(result.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(result.detail).toContain('npm run db:migrate');
    expect(result.detail).toContain('User.agentPaperTradingEnabledAt');
  });

  it('classifies a missing table the same way', () => {
    expect(classify(knownRequestError('P2021', 'The table `public.User` does not exist')).status).toBe(503);
  });

  it('classifies an unreachable database as 503 with a config-shaped remedy', () => {
    const result = classify(knownRequestError('P1001', "Can't reach database server at `localhost:5432`"));
    expect(result.status).toBe(503);
    expect(result.detail).toContain('DATABASE_URL');
  });

  it('leaves anything it cannot explain as a genuine 500', () => {
    const result = classify(new Error('kaboom'));
    expect(result).toEqual({
      status: 500,
      error: 'Internal Server Error',
      message: 'Internal server error',
    });
  });

  it('does not classify an unrelated Prisma error as an environment fault', () => {
    // P2002 is a unique-constraint violation: a real bug or a real conflict,
    // and telling an operator to run migrations would send them nowhere.
    expect(classify(knownRequestError('P2002', 'Unique constraint failed')).status).toBe(500);
  });
});

describe('describe', () => {
  it("keeps the reason and drops Prisma's code frame around it", () => {
    // Flattened whole, the frame is 200-odd characters of caller source and
    // the truncation lands mid-way through the only line that names the column.
    const message = [
      'Invalid `this.prisma.user.findUnique()` invocation in',
      '/srv/api/src/auth/auth.service.ts:109:41',
      '',
      '  108 async login(email: string, password: string) {',
      '\u2192 109   const user = await this.prisma.user.findUnique(',
      'The column `User.agentPaperTradingEnabledAt` does not exist in the current database.',
    ].join('\n');

    expect(describeError(new Error(message))).toBe(
      'The column `User.agentPaperTradingEnabledAt` does not exist in the current database.',
    );
  });

  it('falls back to the raw text when the whole message looks like a frame', () => {
    // Better a code frame than an empty explanation.
    expect(describeError(new Error('  108 something'))).toBe('108 something');
  });

  it('bounds the field so one error cannot dominate a response', () => {
    expect(describeError(new Error('x'.repeat(500)))).toHaveLength(300);
  });
});

describe('sanitiseRequestId', () => {
  it('echoes a caller id that is safe to put in a log line', () => {
    expect(sanitiseRequestId('req-123_ab:9')).toBe('req-123_ab:9');
  });

  it('rejects anything that could forge a second log entry, or is oversized', () => {
    expect(sanitiseRequestId('a\nb')).toBeNull();
    expect(sanitiseRequestId('x'.repeat(65))).toBeNull();
    expect(sanitiseRequestId('')).toBeNull();
    expect(sanitiseRequestId(undefined)).toBeNull();
    expect(sanitiseRequestId(['a'])).toBeNull();
  });
});

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();
  // The filter logs every 5xx; silence it so the suite output stays readable.
  vi.spyOn((filter as any).logger, 'error').mockImplementation(() => undefined);

  it('turns schema drift into an actionable 503 carrying a request id', () => {
    const { args, res } = host();
    filter.catch(knownRequestError('P2022', 'The column `User.x` does not exist in the current database.'), args);

    expect(res.statusCode).toBe(503);
    expect(res.body.message).toMatch(/missing tables or columns/);
    expect(res.body.requestId).toBeTruthy();
    // The id in the body and the header must be the same one, or neither
    // locates the log line.
    expect(res.headers['X-Request-Id']).toBe(res.body.requestId);
  });

  it('withholds the remedy in production and keeps it everywhere else', () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const prod = host();
      filter.catch(knownRequestError('P2022', 'The column `User.x` does not exist'), prod.args);
      expect(prod.res.body.detail).toBeUndefined();

      process.env.NODE_ENV = 'development';
      const dev = host();
      filter.catch(knownRequestError('P2022', 'The column `User.x` does not exist'), dev.args);
      expect(dev.res.body.detail).toContain('npm run db:migrate');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('passes an HttpException through with its status and body intact', () => {
    // 401 "Invalid credentials" is the contract the sign-in form reads; a
    // filter that reshaped it would break the one error users see most.
    const { args, res } = host();
    filter.catch(new UnauthorizedException('Invalid credentials'), args);

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
    expect(res.body.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it("preserves class-validator's message array on a 400", () => {
    const { args, res } = host();
    filter.catch(new BadRequestException(['email must be an email']), args);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toEqual(['email must be an email']);
  });

  it('echoes a caller-supplied X-Request-Id so a trace spans browser and API', () => {
    const { args, res } = host({ 'x-request-id': 'web-42' });
    filter.catch(new Error('kaboom'), args);
    expect(res.body.requestId).toBe('web-42');
  });

  it('replaces an unsafe caller id rather than refusing the request', () => {
    const { args, res } = host({ 'x-request-id': 'bad\nid' });
    filter.catch(new Error('kaboom'), args);
    expect(res.body.requestId).not.toBe('bad\nid');
    expect(res.body.requestId).toBeTruthy();
  });

  it('writes no body once the response has already begun', () => {
    // SSE routes stream; a JSON body appended mid-stream corrupts it.
    const { args, res } = host({}, true);
    filter.catch(new Error('kaboom'), args);
    expect(res.statusCode).toBe(0);
    expect(res.body).toBeUndefined();
  });

  it('rethrows for a non-HTTP context rather than inventing a response', () => {
    const args = { getType: () => 'rpc' } as any;
    expect(() => filter.catch(new Error('kaboom'), args)).toThrow('kaboom');
  });

  it('logs and reports a 5xx HttpException as itself', () => {
    const { args, res } = host();
    filter.catch(new HttpException('upstream is down', 502), args);
    expect(res.statusCode).toBe(502);
    expect(res.body.requestId).toBeTruthy();
  });
});
