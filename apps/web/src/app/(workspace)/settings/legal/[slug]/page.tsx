import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card } from '@tradew/ui';
import { LEGAL_DOCUMENTS, findLegalDocument } from '@/components/settings/legal-documents';

/** Pre-render every policy: the set is fixed and known at build time. */
export function generateStaticParams() {
  return LEGAL_DOCUMENTS.map((doc) => ({ slug: doc.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  const doc = findLegalDocument(params.slug);
  return { title: doc ? `${doc.title} — TradeW` : 'Legal — TradeW' };
}

export default function LegalDocumentPage({ params }: { params: { slug: string } }) {
  const doc = findLegalDocument(params.slug);
  if (!doc) notFound();

  return (
    <div className="space-y-4">
      <nav className="text-xs text-faint">
        <Link href="/settings/legal" className="text-teal hover:underline">
          Legal &amp; policies
        </Link>{' '}
        / {doc.title}
      </nav>

      <header>
        {/* h2 — the Settings layout renders the page-level h1. */}
        <h2 className="text-xl font-bold text-text">{doc.title}</h2>
        <p className="mt-0.5 text-sm text-muted">{doc.summary}</p>
      </header>

      {!doc.reviewed && (
        <Card className="border-amber bg-amber-bg">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warning" className="px-1.5 py-0 text-[9px]">AWAITING LEGAL REVIEW</Badge>
            <span className="text-xs font-semibold text-text">
              This is a draft describing how TradeW works. It is not reviewed legal text.
            </span>
          </div>
        </Card>
      )}

      <Card>
        <article className="space-y-5">
          {doc.body.map((section) => (
            <section key={section.heading}>
              <h3 className="text-sm font-bold text-text">{section.heading}</h3>
              {section.paragraphs.map((p, i) => (
                <p key={i} className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </article>
      </Card>

      <p className="text-[11px] text-faint">
        Questions about any of this belong in{' '}
        <Link href="/settings/help" className="text-teal hover:underline">
          Help &amp; Support
        </Link>
        .
      </p>
    </div>
  );
}
