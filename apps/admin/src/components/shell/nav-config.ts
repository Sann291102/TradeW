/**
 * The 8 modules of the operator console, as specified: Engine Health,
 * Knowledge Management, Agent Management, Reasoning Inspector, TradingView
 * Rule Management, Learning Platform, Observability, Audit & Compliance —
 * plus View as Trader, which is a passthrough rather than a module (it opens
 * the real trader-facing /sentinel workspace in apps/web, not a
 * reimplementation of it — see components/shell/ViewAsTrader.tsx).
 */
export interface AdminNavItem {
  href: string;
  label: string;
  description: string;
}

export const ADMIN_NAV: AdminNavItem[] = [
  { href: '/health', label: 'Engine Health', description: 'Agent status, queue depth, latency, memory, model usage, errors.' },
  { href: '/knowledge', label: 'Knowledge Management', description: 'Corpus, embeddings, concepts, citations, re-index, ingestion jobs.' },
  { href: '/agents', label: 'Agent Management', description: 'Enable/disable agents, confidence thresholds, prompts, versions.' },
  { href: '/reasoning', label: 'Reasoning Inspector', description: 'Full reasoning trace — agent votes, confidence, evidence, citations.' },
  { href: '/rules', label: 'TradingView Rule Management', description: 'Learned rules, approval workflow, rollback, version history.' },
  { href: '/learning-platform', label: 'Learning Platform', description: 'Courses, generated content, user progress, AI teacher analytics.' },
  { href: '/observability', label: 'Observability', description: 'API health, Dhan bridge, market-data pipeline, Redis, PostgreSQL, pgvector.' },
  { href: '/audit', label: 'Audit & Compliance', description: 'AI decisions, overrides, policy violations, user activity.' },
];
