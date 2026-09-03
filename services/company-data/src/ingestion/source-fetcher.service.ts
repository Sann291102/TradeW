import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { buildUrl, FilingDataset, isAllowedDocumentUrl } from '../catalogue/filing-datasets';

/**
 * Fetches one catalogued artefact and records its provenance.
 *
 * ── THE ONE RULE ───────────────────────────────────────────────────────────
 * Nothing in this service parses anything. It answers "what bytes are at this
 * catalogued location right now, and have we seen them before", writes a
 * `SourceRecord`, and hands the bytes on. Parsing lives downstream, per format,
 * where a parser failure is a parser failure and not a network mystery.
 *
 * That separation is what makes the `status` column meaningful: `failed` here
 * always means we could not READ it, never that we could not UNDERSTAND it.
 * Those two facts justify different behaviour — the first permits continuing to
 * show the last good value with its real timestamp, the second does not.
 *
 * ── THE THREE THINGS THAT MAKE NSE WORK ────────────────────────────────────
 * Carried over from `services/api/src/nse/nse.service.ts`, verified again
 * 2026-08-19 against the filing endpoints:
 *  1. **Cookie priming.** A bare request to `/api/*` is refused. Hitting the
 *     homepage first sets the cookies that make it succeed — and the homepage
 *     may itself answer 403 while STILL setting usable cookies, so a failed
 *     prime must not short-circuit the real request. The cookies are the point,
 *     not the status code.
 *  2. **A browser-shaped request.** UA, Accept, Accept-Language, and a Referer
 *     matching the page that would normally make the call.
 *  3. **`getSetCookie()`, not `get('set-cookie')`.** The latter collapses
 *     multiple Set-Cookie headers into one comma-joined string, which produces
 *     a cookie jar that looks fine and does not work.
 *
 * ── WHEN NSE REFUSES ───────────────────────────────────────────────────────
 * It serves an HTML page with HTTP 200. So "did this succeed" cannot be decided
 * on status alone; `looksLikeRefusal` checks the body shape. Without that, the
 * symptom surfaces much later as a JSON parse error in a parser that was handed
 * a login page.
 */

const FETCH_TIMEOUT_MS = 30_000;
const PRIME_TTL_MS = 10 * 60_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export interface FetchOutcome {
  /** The SourceRecord row id — the provenance handle everything downstream carries. */
  sourceRecordId: string;
  status: 'ok' | 'unchanged' | 'failed';
  /** Present only when status === 'ok'. Never populated for a refusal. */
  body?: string;
  contentHash?: string;
  httpStatus?: number;
  error?: string;
}

export interface FetchRequest {
  dataset: FilingDataset;
  /** Symbol, or undefined/'market' for whole-market datasets. */
  scope?: string;
  /** Previous content hash, if known — enables the 'unchanged' short-circuit. */
  knownHash?: string | null;
  /** Previous ETag/Last-Modified, for a conditional request. */
  etag?: string | null;
  lastModified?: string | null;
}

@Injectable()
export class SourceFetcherService {
  private readonly logger = new Logger(SourceFetcherService.name);
  private cookie: string | null = null;
  private primedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** Fetch a catalogued dataset. */
  async fetchDataset(req: FetchRequest): Promise<FetchOutcome> {
    // buildUrl validates the scope. It throws rather than encoding anything
    // suspicious, and that throw must NOT be caught into a 'failed' record —
    // a rejected scope is a programming error on our side, not an upstream
    // fault, and burying it in the provenance table would hide it.
    const url = buildUrl(req.dataset, req.scope);
    return this.fetchUrl({
      url,
      datasetKey: req.dataset.id,
      referer: req.dataset.referer,
      subjectSymbol: req.dataset.scope === 'symbol' ? req.scope : undefined,
      knownHash: req.knownHash,
      etag: req.etag,
      lastModified: req.lastModified,
    });
  }

  /**
   * Fetch a document URL that was found INSIDE a payload (an `xbrl` link).
   *
   * Guarded rather than trusted: the URL came from a third party, so it is
   * checked against the document-host allowlist before any request is made.
   */
  async fetchDocument(args: {
    url: string;
    datasetKey: string;
    subjectSymbol?: string;
    subjectIsin?: string;
    knownHash?: string | null;
  }): Promise<FetchOutcome> {
    if (!isAllowedDocumentUrl(args.url)) {
      // Recorded, not thrown: a filing that points somewhere unexpected is a
      // fact about the upstream worth keeping, and it must be visible without
      // reading logs.
      const record = await this.record({
        datasetKey: args.datasetKey,
        sourceUrl: args.url,
        subjectSymbol: args.subjectSymbol,
        subjectIsin: args.subjectIsin,
        status: 'failed',
        contentHash: this.hash(`refused:${args.url}`),
        error: 'Document URL is not on the allowed NSE archive hosts',
      });
      this.logger.warn(`Refused off-host document URL for ${args.datasetKey}: ${args.url}`);
      return { sourceRecordId: record.id, status: 'failed', error: 'off-host document URL' };
    }

    return this.fetchUrl({
      url: args.url,
      datasetKey: args.datasetKey,
      referer: 'https://www.nseindia.com/',
      subjectSymbol: args.subjectSymbol,
      subjectIsin: args.subjectIsin,
      knownHash: args.knownHash,
    });
  }

  private async fetchUrl(args: {
    url: string;
    datasetKey: string;
    referer: string;
    subjectSymbol?: string;
    subjectIsin?: string;
    knownHash?: string | null;
    etag?: string | null;
    lastModified?: string | null;
  }): Promise<FetchOutcome> {
    await this.prime();

    // Explicit, NOT a spread of `args`. Two reasons the compiler is right to
    // insist: `args.url` is not `sourceUrl`, and `args.etag`/`args.lastModified`
    // are the values we SENT on the conditional request — recording those as
    // the artefact's own validators would make the next conditional request
    // echo back a validator the server never issued.
    const base = {
      datasetKey: args.datasetKey,
      sourceUrl: args.url,
      subjectSymbol: args.subjectSymbol,
      subjectIsin: args.subjectIsin,
    };

    let res: Response;
    let body: string;
    try {
      res = await fetch(args.url, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json, text/csv, application/xml, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9',
          referer: args.referer,
          ...(this.cookie ? { cookie: this.cookie } : {}),
          // Conditional request: a weekly document sweep should cost a 304.
          ...(args.etag ? { 'if-none-match': args.etag } : {}),
          ...(args.lastModified ? { 'if-modified-since': args.lastModified } : {}),
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (res.status === 304) {
        const record = await this.record({
          ...base,
          status: 'unchanged',
          httpStatus: 304,
          contentHash: args.knownHash ?? this.hash(''),
        });
        return { sourceRecordId: record.id, status: 'unchanged', httpStatus: 304 };
      }

      body = await res.text();
    } catch (err) {
      const message = (err as Error).message;
      const record = await this.record({
        ...base,
        status: 'failed',
        contentHash: this.hash(`error:${args.url}:${message}`),
        error: message,
      });
      this.logger.warn(`Fetch failed for ${args.datasetKey} (${args.url}): ${message}`);
      return { sourceRecordId: record.id, status: 'failed', error: message };
    }

    if (!res.ok || looksLikeRefusal(body, res)) {
      const error = res.ok ? `refused with HTTP 200 (${describeBody(body)})` : `HTTP ${res.status}`;
      const record = await this.record({
        ...base,
        status: 'failed',
        httpStatus: res.status,
        contentHash: this.hash(body),
        contentType: res.headers.get('content-type') ?? undefined,
        contentSize: body.length,
        error,
      });
      // A refusal often means the cookie jar went stale; drop it so the next
      // call re-primes rather than repeating the same rejected request.
      this.cookie = null;
      this.logger.warn(`Fetch refused for ${args.datasetKey}: ${error}`);
      return { sourceRecordId: record.id, status: 'failed', httpStatus: res.status, error };
    }

    const contentHash = this.hash(body);

    if (args.knownHash && args.knownHash === contentHash) {
      // Identical bytes. The unique index on (dataSourceId, sourceUrl,
      // contentHash) would reject a duplicate row anyway; `record` upserts, so
      // this returns the EXISTING row's id rather than creating a second.
      const record = await this.record({
        ...base,
        status: 'unchanged',
        httpStatus: res.status,
        contentHash,
        contentType: res.headers.get('content-type') ?? undefined,
        contentSize: body.length,
      });
      return { sourceRecordId: record.id, status: 'unchanged', contentHash, httpStatus: res.status };
    }

    const record = await this.record({
      ...base,
      status: 'ok',
      httpStatus: res.status,
      contentHash,
      contentType: res.headers.get('content-type') ?? undefined,
      contentSize: body.length,
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
    });

    return { sourceRecordId: record.id, status: 'ok', body, contentHash, httpStatus: res.status };
  }

  /**
   * Write the provenance row.
   *
   * Upsert on the natural key, so re-fetching identical bytes is idempotent —
   * the property the whole ingestion design leans on when a job re-runs.
   */
  private async record(args: {
    datasetKey: string;
    sourceUrl: string;
    subjectSymbol?: string;
    subjectIsin?: string;
    status: string;
    contentHash: string;
    httpStatus?: number;
    contentType?: string;
    contentSize?: number;
    etag?: string;
    lastModified?: string;
    error?: string;
  }) {
    const dataSource = await this.resolveDataSource();
    return this.prisma.sourceRecord.upsert({
      where: {
        dataSourceId_sourceUrl_contentHash: {
          dataSourceId: dataSource.id,
          sourceUrl: args.sourceUrl,
          contentHash: args.contentHash,
        },
      },
      // Seeing the same bytes again is new information about WHEN, not about
      // WHAT — so retrievedAt moves and the rest stands.
      //
      // `status` is deliberately NOT written here. The row is keyed by content
      // hash, so an existing row already records how these exact bytes were
      // first obtained; a later re-read reporting 'unchanged' would overwrite
      // 'ok' with a value that describes the REQUEST rather than the artefact,
      // and every downstream consumer selecting parseable records by
      // status = 'ok' would stop seeing it. Verified: without this, one
      // successful fetch followed by one unchanged re-fetch left the only
      // provenance row reading 'unchanged'.
      update: { retrievedAt: new Date() },
      create: {
        dataSourceId: dataSource.id,
        datasetKey: args.datasetKey,
        sourceUrl: args.sourceUrl,
        subjectSymbol: args.subjectSymbol ?? null,
        subjectIsin: args.subjectIsin ?? null,
        status: args.status,
        contentHash: args.contentHash,
        httpStatus: args.httpStatus ?? null,
        contentType: args.contentType ?? null,
        contentSize: args.contentSize ?? null,
        etag: args.etag ?? null,
        lastModified: args.lastModified ?? null,
        error: args.error ?? null,
      },
    });
  }

  /**
   * The NSE DataSource row, created on first use.
   *
   * The licence note is deliberately blunt. Whoever reads this row in six
   * months needs the actual standing, not a reassuring summary.
   */
  private async resolveDataSource() {
    return this.prisma.dataSource.upsert({
      where: { key: 'nse-public' },
      update: {},
      create: {
        key: 'nse-public',
        name: 'NSE India — public filings and archives',
        tier: 1,
        baseUrl: 'https://www.nseindia.com',
        licenseNote:
          'Unofficial, undocumented, unversioned JSON/CSV surface. No SLA. NSE terms restrict automated access; ' +
          'server-side only, one shared cache, polite cadence. A data agreement is the durable answer. ' +
          'Verified reachable 2026-08-19; /api/quote-equity already refuses this client with 403.',
        rateLimitPerMin: 30,
      },
    });
  }

  /**
   * Establish the session cookies NSE requires.
   *
   * A failed prime is logged and IGNORED: NSE answers the homepage 403 to this
   * client while still setting usable cookies, so treating the status as
   * authoritative would refuse to make requests that would have worked.
   */
  private async prime(force = false): Promise<void> {
    if (!force && this.cookie && Date.now() - this.primedAt < PRIME_TTL_MS) return;
    try {
      const res = await fetch('https://www.nseindia.com/', {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const jar = (res.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0])
        .filter(Boolean)
        .join('; ');
      if (jar) {
        this.cookie = jar;
        this.primedAt = Date.now();
      }
    } catch (err) {
      this.logger.warn(`NSE cookie prime failed: ${(err as Error).message}`);
    }
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}

/**
 * Did NSE hand us a page instead of data?
 *
 * It refuses with an HTML body under HTTP 200, so status is not enough. Kept as
 * a free function so it is testable without a Nest context or a database.
 */
export function looksLikeRefusal(body: string, res: { headers: { get(name: string): string | null } }): boolean {
  const contentType = res.headers.get('content-type') ?? '';
  const head = body.slice(0, 400).toLowerCase();
  // A CSV or XML body is never HTML; a JSON body never starts with a tag.
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return true;
  if (contentType.includes('text/html') && head.includes('access denied')) return true;
  return false;
}

function describeBody(body: string): string {
  return body.slice(0, 80).replace(/\s+/g, ' ');
}
