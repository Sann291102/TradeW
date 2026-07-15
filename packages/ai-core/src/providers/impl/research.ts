import { ResearchProvider } from '../interfaces';
import { ResearchQuery, ResearchResult } from '../types';

/** Tavily — primary research provider per config. */
export class TavilyResearchProvider implements ResearchProvider {
  readonly name = 'tavily';
  private baseUrl: string;

  constructor(private config: { apiKey: string; baseUrl?: string }) {
    this.baseUrl = (config.baseUrl ?? 'https://api.tavily.com').replace(/\/$/, '');
  }

  async search(query: ResearchQuery): Promise<ResearchResult[]> {
    const res = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({
        query: query.query,
        max_results: query.maxResults ?? 5,
        search_depth: 'basic',
        ...(query.recencyDays ? { days: query.recencyDays, topic: 'news' } : {}),
        ...(query.includeDomains?.length ? { include_domains: query.includeDomains } : {}),
      }),
    });
    if (!res.ok) throw new Error(`tavily search failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      results: { title: string; url: string; content: string; score?: number; published_date?: string }[];
    };
    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 500) ?? '',
      content: r.content,
      publishedAt: r.published_date ? new Date(r.published_date) : undefined,
      score: r.score,
      servedBy: { provider: this.name },
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const results = await this.search({ query: 'ping', maxResults: 1 });
      return Array.isArray(results);
    } catch {
      return false;
    }
  }
}

/** Brave Search API. */
export class BraveResearchProvider implements ResearchProvider {
  readonly name = 'brave';
  private baseUrl: string;

  constructor(private config: { apiKey: string; baseUrl?: string }) {
    this.baseUrl = (config.baseUrl ?? 'https://api.search.brave.com').replace(/\/$/, '');
  }

  async search(query: ResearchQuery): Promise<ResearchResult[]> {
    const params = new URLSearchParams({
      q: query.query,
      count: String(query.maxResults ?? 5),
      ...(query.recencyDays ? { freshness: query.recencyDays <= 1 ? 'pd' : query.recencyDays <= 7 ? 'pw' : 'pm' } : {}),
    });
    const res = await fetch(`${this.baseUrl}/res/v1/web/search?${params}`, {
      headers: { accept: 'application/json', 'x-subscription-token': this.config.apiKey },
    });
    if (!res.ok) throw new Error(`brave search failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      web?: { results?: { title: string; url: string; description: string; page_age?: string }[] };
    };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? '',
      publishedAt: r.page_age ? new Date(r.page_age) : undefined,
      servedBy: { provider: this.name },
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const results = await this.search({ query: 'ping', maxResults: 1 });
      return Array.isArray(results);
    } catch {
      return false;
    }
  }
}

/** Firecrawl search (search + scrape in one call). */
export class FirecrawlResearchProvider implements ResearchProvider {
  readonly name = 'firecrawl';
  private baseUrl: string;

  constructor(private config: { apiKey: string; baseUrl?: string }) {
    this.baseUrl = (config.baseUrl ?? 'https://api.firecrawl.dev').replace(/\/$/, '');
  }

  async search(query: ResearchQuery): Promise<ResearchResult[]> {
    const res = await fetch(`${this.baseUrl}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({ query: query.query, limit: query.maxResults ?? 5 }),
    });
    if (!res.ok) throw new Error(`firecrawl search failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      data?: { title?: string; url: string; description?: string; markdown?: string }[];
    };
    return (data.data ?? []).map((r) => ({
      title: r.title ?? r.url,
      url: r.url,
      snippet: r.description ?? r.markdown?.slice(0, 500) ?? '',
      content: r.markdown,
      servedBy: { provider: this.name },
    }));
  }

  async healthCheck(): Promise<boolean> {
    try {
      const results = await this.search({ query: 'ping', maxResults: 1 });
      return Array.isArray(results);
    } catch {
      return false;
    }
  }
}

/**
 * Anthropic server-side web search — research through the Messages API's
 * web_search tool. Returns citation-backed results.
 */
export class AnthropicWebSearchProvider implements ResearchProvider {
  readonly name = 'anthropic-web-search';
  private baseUrl: string;
  private model: string;

  constructor(private config: { apiKey: string; baseUrl?: string; model?: string; version?: string }) {
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.model = config.model ?? 'claude-haiku-4-5-20251001';
  }

  async search(query: ResearchQuery): Promise<ResearchResult[]> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': this.config.version ?? '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: `Search the web and report findings for: ${query.query}` }],
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 3,
            ...(query.includeDomains?.length ? { allowed_domains: query.includeDomains } : {}),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`anthropic web search failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      content: {
        type: string;
        text?: string;
        citations?: { type: string; url?: string; title?: string; cited_text?: string }[];
        content?: { type: string; url?: string; title?: string }[];
      }[];
    };

    const results = new Map<string, ResearchResult>();
    for (const block of data.content ?? []) {
      // citations attached to text blocks
      for (const c of block.citations ?? []) {
        if (c.url && !results.has(c.url)) {
          results.set(c.url, {
            title: c.title ?? c.url,
            url: c.url,
            snippet: c.cited_text?.slice(0, 500) ?? '',
            servedBy: { provider: this.name },
          });
        }
      }
      // web_search_tool_result blocks carry raw result lists
      if (block.type === 'web_search_tool_result') {
        for (const r of block.content ?? []) {
          if (r.url && !results.has(r.url)) {
            results.set(r.url, {
              title: r.title ?? r.url,
              url: r.url,
              snippet: '',
              servedBy: { provider: this.name },
            });
          }
        }
      }
    }
    return [...results.values()].slice(0, query.maxResults ?? 5);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models?limit=1`, {
        headers: { 'x-api-key': this.config.apiKey, 'anthropic-version': this.config.version ?? '2023-06-01' },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
