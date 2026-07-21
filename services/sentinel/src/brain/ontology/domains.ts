/**
 * The fifteen knowledge domains of the Sentinel Concept Knowledge Graph.
 *
 * A domain is a folder under `knowledge-base/` at the repo root — one YAML
 * file per concept inside it. The list is closed on purpose: a concept that
 * doesn't fit an existing domain is a signal to discuss the taxonomy, not to
 * invent a folder, because domain is an indexed query dimension and every
 * consumer (reasoning, Learning Hub, the graph UI) groups by it.
 *
 * This is the *concept* ontology for Sentinel's runtime Brain. It is not
 * `TradeW/knowledge/` — that is the Obsidian engineering vault for coding
 * agents (CLAUDE.md Rule 4), holds files rather than concepts, and is never
 * wired into the production runtime. See docs/product-architecture/
 * SENTINEL-KNOWLEDGE-GRAPH.md §1.
 */
export const DOMAINS = [
  'market-structure',
  'price-action',
  'options',
  'technical-analysis',
  'volume',
  'market-microstructure',
  'macroeconomics',
  'trading-psychology',
  'risk-management',
  'institutional-concepts',
  'company-fundamentals',
  'derivatives',
  'sentiment',
  'patterns',
  'glossary',
] as const;

export type Domain = (typeof DOMAINS)[number];

const DOMAIN_SET: ReadonlySet<string> = new Set(DOMAINS);

export function isDomain(value: unknown): value is Domain {
  return typeof value === 'string' && DOMAIN_SET.has(value);
}

/** One-line descriptions, surfaced in the graph UI legend and in authoring errors. */
export const DOMAIN_DESCRIPTIONS: Record<Domain, string> = {
  'market-structure': 'How price organises itself — trends, ranges, swing points, timeframe hierarchy.',
  'price-action': 'What price does at those structures — breakouts, sweeps, rejections, expansion.',
  options: 'Options-specific concepts — greeks, IV behaviour, expiry mechanics, chain structure.',
  'technical-analysis': 'Indicators and derived studies, and what they actually measure.',
  volume: 'Participation and conviction — volume profile, delta, accumulation and distribution.',
  'market-microstructure': 'Order book mechanics — spreads, depth, liquidity provision, execution effects.',
  macroeconomics: 'Rates, inflation, policy, currency and cross-asset drivers of equity behaviour.',
  'trading-psychology': 'Cognitive and emotional biases as observable behaviour, not diagnosis.',
  'risk-management': 'Position sizing, exposure, drawdown and the controls that bound them.',
  'institutional-concepts': 'How large participants must operate, and the footprints that leaves.',
  'company-fundamentals': 'Earnings, balance sheet and valuation concepts that drive repricing.',
  derivatives: 'Futures, basis, rollover and the structural effects of derivative positioning.',
  sentiment: 'Positioning and crowd-state measures — breadth, put-call, flows.',
  patterns: 'Named, recurring multi-signal configurations composed from the other domains.',
  glossary: 'Foundational vocabulary that other concepts depend on but that carries no signal.',
};
