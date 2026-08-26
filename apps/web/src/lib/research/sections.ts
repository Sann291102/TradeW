export const RESEARCH_SECTIONS = [
  { key: 'overview', label: 'Overview' },
  { key: 'financials', label: 'Financials' },
  { key: 'ratios', label: 'Ratios' },
  { key: 'history', label: 'Historical' },
  { key: 'ownership', label: 'Ownership' },
  { key: 'news', label: 'News' },
  { key: 'analyst', label: 'Analyst' },
  { key: 'technicals', label: 'Technicals' },
  { key: 'earnings', label: 'Earnings' },
  { key: 'valuation', label: 'Valuation' },
  { key: 'peers', label: 'Peers' },
  { key: 'graph', label: 'Knowledge Graph' },
  { key: 'signals', label: 'Signals' },
  { key: 'saved', label: 'Saved Research' },
  { key: 'ai', label: 'AI research' },
] as const;

export type ResearchSectionKey = (typeof RESEARCH_SECTIONS)[number]['key'];
