import type { MetadataRoute } from 'next';
import { DISALLOWED_CRAWL_PATHS } from '@/lib/site';
import { siteUrl } from '@/lib/site';

/**
 * Crawl policy.
 *
 * The workspace is already unreachable to a signed-out crawler — middleware.ts
 * redirects every gated route to `/`. This file states the intent anyway, so
 * that "search engines cannot see the workspace" stops being an accident of the
 * auth wall's shape and becomes something a reader of this repository can find.
 *
 * `sitemap` is emitted only when a public origin is configured, because a
 * sitemap reference has to be an absolute URL and TradeW has no established
 * domain to make one from (lib/site.ts).
 */
export default function robots(): MetadataRoute.Robots {
  const site = siteUrl();

  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/legal/'],
      disallow: DISALLOWED_CRAWL_PATHS,
    },
    ...(site ? { sitemap: new URL('/sitemap.xml', site).toString() } : {}),
  };
}
