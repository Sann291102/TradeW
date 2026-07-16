import { Inject, Injectable, Logger } from '@nestjs/common';
import { Retriever } from '@tradew/ai-core';
import { MarketSnapshot } from '../intelligence/market-intelligence.service';
import { HistoricalSimilarityService } from './historical-similarity.service';
import { RETRIEVER } from './tokens';

/**
 * Market Context Engine — composes a short, educational narrative for the
 * active symbol from the live technical snapshot plus whatever the Brain
 * already remembers about it. Not a signal generator: it explains "what's
 * the story here", never "what to do about it".
 */
@Injectable()
export class MarketContextService {
  private readonly logger = new Logger(MarketContextService.name);

  constructor(
    @Inject(RETRIEVER) private readonly retriever: Retriever,
    private readonly historical: HistoricalSimilarityService,
  ) {}

  async contextFor(symbol: string, snapshot: MarketSnapshot): Promise<string> {
    const parts: string[] = [];
    parts.push(
      `${symbol} is at ${snapshot.lastPrice.toFixed(2)}` +
        (snapshot.rsi14 !== null ? `, RSI(14) ${snapshot.rsi14.toFixed(1)}` : '') +
        `, open interest ${snapshot.oiTrend}.`,
    );

    try {
      const retrieval = await this.retriever.retrieve({
        query: `${symbol} market structure, patterns and behaviour`,
        namespace: 'sentinel',
        limit: 5,
      });
      if (retrieval.hits.length > 0) {
        parts.push(`Sentinel has ${retrieval.hits.length} relevant memory record(s) about ${symbol} from past sessions.`);
      } else {
        parts.push(`No prior Brain memory for ${symbol} yet — this is a fresh context that will build over time.`);
      }
    } catch (err) {
      this.logger.warn(`market context retrieval failed for ${symbol}: ${err}`);
    }

    return parts.join(' ');
  }
}
