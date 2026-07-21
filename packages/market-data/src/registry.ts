import type { MarketDataProvider } from '@tradew/types';
import { MarketFeed } from './contracts/feed';
import { DhanMarketFeed, WebSocketFactory } from './providers/dhan/dhan.feed';
import { SimulatedMarketFeed } from './providers/simulated/simulated.feed';
import { AnchorResolver, SimulatedMarketDataProvider } from './providers/simulated/simulated.provider';

/**
 * Selects the active provider and feed from configuration.
 *
 * This is the seam the whole phase exists to create: moving from the simulator
 * to Dhan is `MARKET_DATA_FEED=dhan` plus credentials, not a code change
 * (Phase 1 objective 5).
 *
 * The simulator is the default and stays permanently available — it is the
 * development and CI source, and the fallback when a live feed cannot start.
 */

export type ProviderName = 'simulated' | 'dhan';

export interface MarketDataConfig {
  provider: ProviderName;
  feed: ProviderName;
  simulated?: { intervalMs?: number; emitWhenClosed?: boolean };
  dhan?: { accessToken?: string; clientId?: string; url?: string };
}

export interface RegistryDependencies {
  resolveAnchor?: AnchorResolver;
  /** Required only when the Dhan feed is selected. */
  webSocketFactory?: WebSocketFactory;
}

/**
 * Read configuration from the environment.
 *
 * Defaults to the simulator on purpose: an operator must opt in to a live feed,
 * and a missing/typo'd env var can never silently start billing against a real
 * data subscription or produce data labelled as live when it is not.
 */
export function loadMarketDataConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MarketDataConfig {
  const feed = normaliseName(env.MARKET_DATA_FEED) ?? 'simulated';
  const provider = normaliseName(env.MARKET_DATA_PROVIDER) ?? feed;
  return {
    provider,
    feed,
    simulated: {
      intervalMs: toInt(env.MARKET_DATA_SIM_INTERVAL_MS) ?? 2000,
      emitWhenClosed: env.MARKET_DATA_SIM_EMIT_WHEN_CLOSED === 'true',
    },
    dhan: {
      accessToken: env.DHAN_ACCESS_TOKEN,
      clientId: env.DHAN_CLIENT_ID,
      url: env.DHAN_FEED_URL,
    },
  };
}

export function createMarketDataProvider(config: MarketDataConfig, deps: RegistryDependencies = {}): MarketDataProvider {
  switch (config.provider) {
    case 'dhan':
      // The pull-side Dhan provider (historical candles, option chain) is
      // Phase 3/5 work. Falling back silently to simulation would mislabel
      // simulated data as live, so this fails loudly instead.
      throw new Error(
        'MARKET_DATA_PROVIDER=dhan is not implemented yet — the Dhan REST provider arrives with historical backfill ' +
          '(DHAN-MARKET-DATA-INTEGRATION.md Phase 3). Use MARKET_DATA_PROVIDER=simulated.',
      );
    case 'simulated':
    default:
      return new SimulatedMarketDataProvider(deps.resolveAnchor);
  }
}

export function createMarketFeed(config: MarketDataConfig, deps: RegistryDependencies = {}): MarketFeed {
  if (config.feed === 'dhan') {
    const { accessToken, clientId, url } = config.dhan ?? {};
    if (!accessToken || !clientId) {
      throw new Error('MARKET_DATA_FEED=dhan requires DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID.');
    }
    if (!deps.webSocketFactory) {
      throw new Error('MARKET_DATA_FEED=dhan requires a webSocketFactory dependency.');
    }
    return new DhanMarketFeed({ accessToken, clientId, url, webSocketFactory: deps.webSocketFactory });
  }
  return new SimulatedMarketFeed({
    intervalMs: config.simulated?.intervalMs,
    emitWhenClosed: config.simulated?.emitWhenClosed,
    resolveAnchor: deps.resolveAnchor,
  });
}

function normaliseName(value: string | undefined): ProviderName | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  return v === 'dhan' || v === 'simulated' ? v : null;
}

function toInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
