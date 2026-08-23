import { notFound } from 'next/navigation';
import { LegalDocumentView } from '@/components/legal/LegalDocumentView';
import { LEGAL_DOCUMENTS, getLegalDocument } from '@/lib/legal/documents';

/**
 * One route per legal document, generated from lib/legal/documents.ts.
 *
 * `dynamicParams = false` is the point of this file being a dynamic segment at
 * all: the document set is closed and known at build time, so anything outside
 * it 404s rather than rendering an empty shell. Adding a document is adding an
 * entry to `LEGAL_DOCUMENTS` — there is no second place to remember, which is
 * what keeps the footer, the middleware allowlist, the sitemap and the routes
 * from drifting apart.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return LEGAL_DOCUMENTS.map((doc) => ({ slug: doc.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  const doc = getLegalDocument(params.slug);
  if (!doc) return {};
  return {
    title: `${doc.title} — TradeW`,
    description: doc.description,
    // Relative canonical. `metadataBase` in the root layout resolves it against
    // NEXT_PUBLIC_SITE_URL when one is configured; unset — which is the state
    // today, since TradeW has no established public domain — Next emits the
    // path and nothing is invented. See docs/footer/FOOTER_RESEARCH_REPORT.md §1.
    alternates: { canonical: `/legal/${doc.slug}` },
  };
}

export default function LegalPage({ params }: { params: { slug: string } }) {
  const doc = getLegalDocument(params.slug);
  if (!doc) notFound();
  return <LegalDocumentView doc={doc} />;
}
