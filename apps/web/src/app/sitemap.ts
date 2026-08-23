import type { MetadataRoute } from 'next';
import { LEGAL_DOCUMENTS } from '@/lib/legal/documents';
import { PUBLIC_CRAWLABLE_PATHS, siteUrl } from '@/lib/site';

/**
 * The sitemap — public routes only.
 *
 * Returns an EMPTY list when no public origin is configured, which is the state
 * today. A sitemap entry must be an absolute URL, and the only absolute URL
 * available without a configured domain is a guessed one. An empty sitemap is
 * honest; a sitemap full of `https://tradew.io/...` when nothing is served
 * there would point every crawler at a host TradeW does not control.
 *
 * Legal routes come from `LEGAL_DOCUMENTS` rather than a second list, so a new
 * legal document is in the sitemap the moment it exists.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const site = siteUrl();
  if (!site) return [];

  const paths = [...PUBLIC_CRAWLABLE_PATHS, ...LEGAL_DOCUMENTS.map((d) => `/legal/${d.slug}`)];

  return paths.map((path) => ({
    url: new URL(path, site).toString(),
    lastModified: new Date(),
    // The landing page is the entry point; the legal surface is reference
    // material that changes rarely. Both are stated rather than left to a
    // crawler's default.
    changeFrequency: path === '/' ? ('weekly' as const) : ('yearly' as const),
    priority: path === '/' ? 1 : 0.4,
  }));
}
