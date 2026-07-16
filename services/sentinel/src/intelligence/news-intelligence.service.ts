import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NewsEventClassifier,
  ProviderManager,
  ProviderNotAvailableError,
  createProviderManager,
  loadProvidersConfigFromEnv,
} from '@tradew/ai-core';
import { MarketDataProvider, NewsItem } from '@tradew/types';
import { PrismaService } from '../prisma.service';
import { Signal } from '../domain';
import { MARKET_DATA } from './market-intelligence.service';

/**
 * News Event Intelligence — the NVIDIA distillation blueprint in production
 * form. Headlines from the MarketDataProvider are classified into the 13
 * standardized event categories through the provider layer; with
 * NVIDIA_NIM_BASE_URL pointed at a distilled student model (NeMo Data
 * Flywheel output), classification runs on that model with zero code change.
 * Classified events are persisted (NewsEvent) and feed volatility signals.
 */
@Injectable()
export class NewsIntelligenceService {
  private readonly logger = new Logger(NewsIntelligenceService.name);
  private providers: ProviderManager;

  constructor(
    @Inject(MARKET_DATA) private readonly marketData: MarketDataProvider,
    private readonly prisma: PrismaService,
  ) {
    this.providers = createProviderManager(loadProvidersConfigFromEnv());
  }

  async signals(symbol: string): Promise<Signal[]> {
    let news: NewsItem[] = [];
    try {
      news = await this.marketData.getNews([symbol], 24);
    } catch (err) {
      this.logger.warn(`news feed unavailable: ${err}`);
    }
    if (news.length === 0) {
      return [
        {
          name: 'news_driven_volatility',
          agent: 'market-technical',
          triggered: false,
          weight: 0.25,
          evidence: ['No news events in the last 24h for this symbol'],
        },
      ];
    }

    const classified = await this.classifyAndPersist(news);
    const highImpact = classified.filter((c) =>
      ['Earnings', 'Mergers and Acquisitions', 'Regulatory', 'Guidance', 'Credit Ratings'].includes(c.eventType),
    );
    const unscheduled = news.filter((n) => n.unscheduled).length;

    return [
      {
        name: 'news_driven_volatility',
        agent: 'market-technical',
        triggered: highImpact.length > 0 || unscheduled > 0,
        weight: 0.25,
        evidence: [
          `${news.length} news item(s) in the last 24h; ${highImpact.length} high-impact event(s)` +
            (highImpact.length ? ` (${[...new Set(highImpact.map((h) => h.eventType))].join(', ')})` : ''),
          ...(unscheduled > 0 ? [`${unscheduled} unscheduled news event(s) coinciding with current price action`] : []),
        ],
        data: { eventTypes: classified.map((c) => c.eventType) },
      },
    ];
  }

  private async classifyAndPersist(news: NewsItem[]) {
    let classifier: NewsEventClassifier;
    try {
      classifier = new NewsEventClassifier(this.providers.getLlm());
    } catch (err) {
      if (err instanceof ProviderNotAvailableError) {
        // no LLM configured — treat everything as unclassified OTHER
        return news.map((n) => ({ headline: n.headline, eventType: 'OTHER' as const }));
      }
      throw err;
    }

    const results = await classifier.classifyBatch(news.map((n) => n.headline));
    try {
      await this.prisma.newsEvent.createMany({
        data: results.map((r, i) => ({
          headline: r.headline,
          source: news[i].source,
          url: news[i].url ?? null,
          publishedAt: news[i].publishedAt,
          symbols: news[i].symbols,
          eventType: r.eventType,
          classifiedBy: `${r.servedBy.provider}/${r.servedBy.model}`,
        })),
      });
    } catch (err) {
      this.logger.warn(`could not persist classified news events: ${err}`);
    }
    return results;
  }
}
