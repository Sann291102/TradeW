import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  archiveCandidates,
  datasetUrl,
  resolveDataset,
  NSE_DATASETS,
  type NseDataset,
  type NseDatasetId,
} from './nse-datasets';

/**
 * NSE public-data connector — institutional flow, positioning and breadth.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The Sentinel dashboard reported FII/DII, global breadth and the event
 * calendar as "no data source in TradeW". For FII/DII that was assumed to be a
 * Dhan gap to be closed with the broker token — it is not. DhanHQ v2's data
 * surface is quotes, `/charts/historical`, `/charts/intraday`, `/optionchain`
 * and the scrip masters; there is no participant-wise or cash-flow endpoint
 * anywhere in it, and no token unlocks one. (Full endpoint audit:
 * knowledge/API/2026-08-11 - Dhan Algo Strategies.)
 *
 * NSE publishes all of it free and keyless. That is what this reads.
 *
 * ── THE THREE THINGS THAT MAKE THIS WORK ───────────────────────────────────
 *  1. **Cookie priming.** A bare request to `/api/*` is refused. A request to
 *     the homepage first sets the cookies that make it succeed — and, verified
 *     2026-08-16, the homepage may itself answer 403 while STILL setting usable
 *     cookies. So priming failure is not fatal and must not short-circuit the
 *     real request; the cookies are the point, not the status code.
 *  2. **A browser-shaped request.** UA, Accept, Accept-Language and a Referer
 *     matching the page that would normally make the call.
 *  3. **Caching by how often the SOURCE changes.** FII/DII and participant OI
 *     are end-of-day publications: polling them every minute would fetch the
 *     same row hundreds of times a day. TTLs live on the dataset.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * Not a browser and not a scraper of pages. It reads a closed catalogue of
 * structured endpoints by name (`nse-datasets.ts`), parses them into typed
 * numbers, and never returns third-party prose that could reach a model as
 * instruction. No caller — including the assistant — supplies a URL.
 *
 * ── OPERATIONAL HONESTY ────────────────────────────────────────────────────
 * This is an unofficial, undocumented, unversioned surface with no SLA. It can
 * change shape or start refusing this server's IP without notice. Every parser
 * below therefore degrades to null rather than throwing, every route reports
 * the fault rather than substituting a number, and the cache means an outage
 * shows the last good reading with its timestamp instead of a gap.
 */

const FETCH_TIMEOUT_MS = 10_000;
const PRIME_TTL_MS = 10 * 60_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export interface FiiDiiRow {
  category: 'FII' | 'DII';
  /** The session this describes — NOT today. See `endOfDay` on the dataset. */
  date: string;
  buy: number | null;
  sell: number | null;
  net: number | null;
}

export interface FiiDiiFlow {
  session: string | null;
  rows: FiiDiiRow[];
  fetchedAt: string;
}

export interface ParticipantOiRow {
  participant: string;
  futureIndexLong: number | null;
  futureIndexShort: number | null;
  optionIndexCallLong: number | null;
  optionIndexPutLong: number | null;
  totalLong: number | null;
  totalShort: number | null;
}

export interface ParticipantOi {
  session: string | null;
  rows: ParticipantOiRow[];
  fetchedAt: string;
}

export interface BreadthSnapshot {
  index: string;
  last: number | null;
  percentChange: number | null;
  advances: number | null;
  declines: number | null;
  unchanged: number | null;
  fetchedAt: string;
}

interface CacheEntry {
  at: number;
  value: unknown;
}

@Injectable()
export class NseService {
  private readonly logger = new Logger(NseService.name);
  private readonly cache = new Map<string, CacheEntry>();

  /** Cookies from the last successful prime, and when it happened. */
  private cookie: string | null = null;
  private primedAt = 0;
  /** Collapses concurrent primes into one — every dataset needs the session. */
  private priming: Promise<void> | null = null;

  // ---------------------------------------------------------------- datasets

  /** The catalogue, for callers that need to know what can be asked for. */
  catalogue() {
    return Object.values(NSE_DATASETS).map((d) => ({
      id: d.id,
      describes: d.describes,
      endOfDay: d.endOfDay,
      format: d.format,
    }));
  }

  /**
   * FII/FPI and DII cash-market flow for the last completed session.
   *
   * `session` is carried out of the payload deliberately. This number is always
   * about a finished day, and a UI that shows it without its date during market
   * hours is asserting that today's institutions have already acted.
   */
  async fiiDiiFlow(): Promise<FiiDiiFlow> {
    return this.cached('fii-dii-cash', async () => {
      const raw = await this.readJson('fii-dii-cash');
      const list = Array.isArray(raw) ? raw : [];

      const rows: FiiDiiRow[] = list.flatMap((entry) => {
        const record = asRecord(entry);
        if (!record) return [];
        const label = str(record.category) ?? '';
        // NSE labels the foreign side "FII/FPI"; normalise, but only for the
        // two categories this endpoint actually publishes — an unknown label is
        // dropped rather than guessed into one of them.
        const category = /FII|FPI/i.test(label) ? 'FII' : /DII/i.test(label) ? 'DII' : null;
        if (!category) return [];
        return [
          {
            category,
            date: str(record.date) ?? '',
            buy: num(record.buyValue),
            sell: num(record.sellValue),
            net: num(record.netValue),
          },
        ];
      });

      return {
        session: rows[0]?.date || null,
        rows,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Participant-wise open interest in equity derivatives.
   *
   * Published as a dated CSV per trading day, so the newest file may not exist
   * yet (it lands well after the close) and weekends have none at all. The
   * candidates are walked newest-first and the first that resolves wins — a
   * 404 here is a normal "not published yet", not a fault.
   */
  async participantOi(): Promise<ParticipantOi> {
    return this.cached('participant-oi', async () => {
      const errors: string[] = [];
      for (const day of archiveCandidates(new Date())) {
        try {
          const csv = await this.readText('participant-oi', day);
          const parsed = parseParticipantOi(csv);
          if (parsed.rows.length > 0) return { ...parsed, fetchedAt: new Date().toISOString() };
        } catch (err) {
          errors.push(`${day}: ${(err as Error).message}`);
        }
      }
      throw new ServiceUnavailableException(
        `No participant open-interest report available for the last few sessions (${errors.join('; ')}).`,
      );
    });
  }

  /**
   * Advance/decline breadth for one index, default NIFTY 50.
   *
   * This is the first REAL breadth figure available to this platform — the
   * market-context layer has been reporting participation as derived from
   * signal flags because nothing counted advancing and declining constituents.
   */
  async breadth(index = 'NIFTY 50'): Promise<BreadthSnapshot> {
    return this.cached(`indices:${index}`, async () => {
      const raw = await this.readJson('indices');
      const rows = Array.isArray(asRecord(raw)?.data) ? (asRecord(raw)!.data as unknown[]) : [];
      const match = rows.map(asRecord).find((r) => r && str(r.index) === index);

      if (!match) {
        throw new ServiceUnavailableException(`NSE returned no index row for "${index}".`);
      }
      return {
        index,
        last: num(match.last),
        percentChange: num(match.percentChange),
        advances: num(match.advances),
        declines: num(match.declines),
        unchanged: num(match.unchanged),
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /** Whether each NSE segment is open, straight from the exchange. */
  async marketStatus(): Promise<unknown> {
    return this.cached('market-status', () => this.readJson('market-status'));
  }

  /**
   * Upcoming corporate board meetings.
   *
   * Company-authored free text (`bm_desc`) is deliberately NOT returned. It is
   * third-party prose, and this connector's contract is that nothing it emits
   * can reach a model as instruction. Symbol, company, purpose and date carry
   * the event risk; the description carries only the injection surface.
   */
  async eventCalendar(limit = 25): Promise<{ events: unknown[]; fetchedAt: string }> {
    return this.cached('event-calendar', async () => {
      const raw = await this.readJson('event-calendar');
      const list = Array.isArray(raw) ? raw : [];
      const events = list
        .map(asRecord)
        .filter((r): r is Record<string, unknown> => r !== null)
        .slice(0, limit)
        .map((r) => ({
          symbol: str(r.symbol),
          company: str(r.company),
          purpose: str(r.purpose),
          date: str(r.date),
        }));
      return { events, fetchedAt: new Date().toISOString() };
    });
  }

  // ------------------------------------------------------------------ plumbing

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const dataset = resolveDataset(key.split(':')[0]);
    const ttl = dataset?.ttlMs ?? 60_000;

    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;

    try {
      const value = await load();
      this.cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      // A stale reading with a visible timestamp beats a gap: NSE refusing this
      // IP for a minute should not blank a panel that was correct 30s ago. The
      // reading carries `fetchedAt`, so "old" is legible downstream.
      if (hit) {
        this.logger.warn(`NSE ${key} refresh failed (${(err as Error).message}); serving cached`);
        return hit.value as T;
      }
      throw err;
    }
  }

  /**
   * Establish the session cookies NSE requires.
   *
   * A 403 from the homepage is NOT treated as failure — verified 2026-08-16,
   * NSE answers the homepage 403 to this client while still setting the cookies
   * that make the subsequent API call return 200. Reading the status here and
   * bailing on it would have made the whole connector look broken while it was
   * one header away from working.
   */
  private async prime(force = false): Promise<void> {
    if (!force && this.cookie && Date.now() - this.primedAt < PRIME_TTL_MS) return;
    if (this.priming) return this.priming;

    this.priming = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch('https://www.nseindia.com/', {
          signal: controller.signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
          },
        });
        const jar = readSetCookies(res);
        if (jar) {
          this.cookie = jar;
          this.primedAt = Date.now();
        }
      } catch (err) {
        this.logger.warn(`NSE cookie prime failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
        this.priming = null;
      }
    })();

    return this.priming;
  }

  private async request(id: NseDatasetId, day?: string): Promise<Response> {
    const dataset = resolveDataset(id);
    if (!dataset) throw new ServiceUnavailableException(`Unknown NSE dataset "${id}".`);

    const url = datasetUrl(dataset, day);
    if (!url) throw new ServiceUnavailableException(`NSE dataset "${id}" needs a valid archive day.`);

    await this.prime();
    let res = await this.send(url, dataset);

    // 401/403 after a good run means the session lapsed. Re-prime ONCE and
    // retry; a loop here would turn a block into a hammer on a public exchange.
    if (res.status === 401 || res.status === 403) {
      await this.prime(true);
      res = await this.send(url, dataset);
    }
    return res;
  }

  private async send(url: string, dataset: NseDataset): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, {
        signal: controller.signal,
        // No redirect following: every URL here is a known endpoint on a known
        // host, so a redirect means the request is no longer going where the
        // catalogue said. Following it would let the destination move outside
        // the allowlist that is this module's only control.
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: dataset.format === 'json' ? 'application/json, text/plain, */*' : '*/*',
          'accept-language': 'en-US,en;q=0.9',
          referer: dataset.referer,
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson(id: NseDatasetId): Promise<unknown> {
    const res = await this.request(id);
    if (!res.ok) {
      throw new ServiceUnavailableException(`NSE ${id} returned HTTP ${res.status}.`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // NSE serves an HTML challenge page instead of JSON when it decides to
      // refuse. Naming that is the difference between a five-minute diagnosis
      // and an afternoon of "why is JSON.parse failing".
      throw new ServiceUnavailableException(
        `NSE ${id} did not return JSON — the request was most likely refused and served an HTML page instead.`,
      );
    }
  }

  private async readText(id: NseDatasetId, day?: string): Promise<string> {
    const res = await this.request(id, day);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
}

// ------------------------------------------------------------------- parsing

/**
 * Read the participant-OI CSV.
 *
 * Hand-rolled for the same reason `parseRss` is: one known file in a fixed
 * shape, and the alternative is a CSV dependency in the API for one report.
 * Column headers carry trailing whitespace in the real file ("Future Stock
 * Short       "), so every header is trimmed before matching — that padding is
 * exactly the kind of thing an index-based reader gets right by luck and a
 * name-based one gets wrong silently.
 */
export function parseParticipantOi(csv: string): { session: string | null; rows: ParticipantOiRow[] } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 3) return { session: null, rows: [] };

  // Line 0 is a title: ""Participant wise Open Interest … as on Aug 14, 2026"",,,
  const session = /as on ([A-Za-z]{3} \d{1,2}, \d{4})/.exec(lines[0])?.[1] ?? null;

  const header = lines[1].split(',').map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const at = (cells: string[], name: string): number | null => {
    const index = col(name);
    return index === -1 ? null : num(cells[index]);
  };

  const rows: ParticipantOiRow[] = [];
  for (const line of lines.slice(2)) {
    const cells = line.split(',').map((c) => c.trim());
    const participant = cells[0];
    if (!participant) continue;
    rows.push({
      participant,
      futureIndexLong: at(cells, 'Future Index Long'),
      futureIndexShort: at(cells, 'Future Index Short'),
      optionIndexCallLong: at(cells, 'Option Index Call Long'),
      optionIndexPutLong: at(cells, 'Option Index Put Long'),
      totalLong: at(cells, 'Total Long Contracts'),
      totalShort: at(cells, 'Total Short Contracts'),
    });
  }
  return { session, rows };
}

/**
 * Cookies from a response, as a single `cookie` header value.
 *
 * `getSetCookie()` is the correct API (multiple Set-Cookie headers cannot be
 * read through `get()` without being joined into one unusable string) but it is
 * Node 20+; the fallback keeps this working on 18 rather than silently
 * returning a mangled jar.
 */
function readSetCookies(res: Response): string | null {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : null;
  const list = all && all.length > 0 ? all : [res.headers.get('set-cookie') ?? ''];
  const pairs = list
    .map((c) => c.split(';')[0]?.trim())
    .filter((c): c is string => !!c && c.includes('='));
  return pairs.length > 0 ? pairs.join('; ') : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A number, or null.
 *
 * NSE returns these as strings ("14295.49", "39") and occasionally as "-" or
 * "" for a value it does not have. Coercing those to 0 would report a session
 * with no data as a session where institutions transacted nothing — so
 * anything that does not parse finitely is null, and stays null all the way to
 * the screen.
 */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}
