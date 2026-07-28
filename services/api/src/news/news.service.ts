import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Market news — real headlines from Indian financial newswires.
 *
 * Replaces `lib/mock/market.ts`'s NEWS array: six hand-written headlines
 * ("Nifty holds above 23,800 as IT and metals lead broad-based buying") with
 * frozen timestamps, which read as a live feed on a trading screen. It was at
 * least labelled "mock feed"; it is now simply real.
 *
 * Sourced from public RSS rather than a news API because every keyless news
 * API worth using now requires a key, and Twelve Data's /news endpoint is not
 * on this plan (404, verified 2026-07-28). RSS is the honest keyless option and
 * these are the wires Indian traders actually read.
 *
 * NOT classified, scored or ranked. Headlines are passed through with their
 * source and timestamp, newest first. `packages/ai-core` contains a 13-category
 * LLM news classifier and the schema has a NewsEvent model, but wiring either
 * would mean the platform asserting what a headline MEANS for an instrument —
 * a short step from a recommendation, and it needs its own compliance review
 * before it goes near a user. Reporting what was published is not that.
 */

interface FeedSource {
  /** Short label shown as the item's badge. */
  label: string;
  publisher: string;
  url: string;
}

const FEEDS: FeedSource[] = [
  {
    label: 'MARKETS',
    publisher: 'Economic Times',
    url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  },
  {
    label: 'STOCKS',
    publisher: 'Economic Times',
    url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms',
  },
  {
    label: 'BUSINESS',
    publisher: 'Moneycontrol',
    url: 'https://www.moneycontrol.com/rss/business.xml',
  },
  {
    label: 'ECONOMY',
    publisher: 'Economic Times',
    url: 'https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms',
  },
];

export interface NewsItemDto {
  id: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  category: string;
  publisher: string;
}

/** Feeds update on the order of minutes; refetching per request would hammer
 *  the publishers for no benefit. */
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_ITEMS = 60;

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);
  private cache: { at: number; items: NewsItemDto[] } | null = null;

  async headlines(limit = 40): Promise<NewsItemDto[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.items.slice(0, limit);
    }

    // One slow or dead publisher must not take the whole feed down with it.
    const settled = await Promise.allSettled(FEEDS.map((f) => this.loadFeed(f)));
    const items = settled
      .filter((r): r is PromiseFulfilledResult<NewsItemDto[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    const failures = settled.filter((r) => r.status === 'rejected').length;
    if (items.length === 0) {
      throw new ServiceUnavailableException(
        `No market news available — all ${FEEDS.length} newswires were unreachable.`,
      );
    }
    if (failures > 0) this.logger.warn(`${failures}/${FEEDS.length} news feeds failed; serving the rest`);

    // Newest first across all sources, de-duplicated by URL (the same story is
    // routinely carried by more than one of these feeds).
    const seen = new Set<string>();
    const merged = items
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .filter((i) => {
        if (seen.has(i.url)) return false;
        seen.add(i.url);
        return true;
      })
      .slice(0, MAX_ITEMS);

    this.cache = { at: Date.now(), items: merged };
    return merged.slice(0, limit);
  }

  private async loadFeed(feed: FeedSource): Promise<NewsItemDto[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(feed.url, {
        signal: controller.signal,
        // Some publishers 403 a bare fetch with no UA.
        headers: { 'user-agent': 'TradeW/1.0 (+market news reader)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseRss(await res.text(), feed);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ------------------------------------------------------------------ parsing

/**
 * Minimal RSS 2.0 reader.
 *
 * Hand-rolled rather than adding an XML dependency: these are four known feeds
 * in a fixed format, and the alternative is pulling a parser into the API for
 * one endpoint. It reads only well-formed <item> blocks and skips anything it
 * cannot make a title and link out of, so a malformed feed yields fewer items
 * rather than throwing.
 */
function parseRss(xml: string, feed: FeedSource): NewsItemDto[] {
  const out: NewsItemDto[] = [];
  const blocks = xml.split('<item>').slice(1);

  for (const raw of blocks) {
    const block = raw.split('</item>')[0];
    const title = tag(block, 'title');
    const link = tag(block, 'link');
    if (!title || !link) continue;

    const pubDate = tag(block, 'pubDate');
    const published = pubDate ? new Date(pubDate) : null;

    out.push({
      // The publisher's own guid when present; the link is a stable fallback
      // and is what de-duplication keys on anyway.
      id: tag(block, 'guid') || link,
      title: decodeEntities(title),
      summary: decodeEntities(stripHtml(tag(block, 'description') ?? '')).slice(0, 400),
      url: link,
      publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : new Date().toISOString(),
      category: feed.label,
      publisher: feed.publisher,
    });
  }
  return out;
}

/** First occurrence of <tag>…</tag>, CDATA unwrapped and trimmed. */
function tag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  if (!match) return null;
  const value = match[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
  return value.length > 0 ? value : null;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** The handful of entities these feeds actually emit. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
