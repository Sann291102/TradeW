import Link from 'next/link';
import { Badge, Card } from '@tradew/ui';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { LEGAL_DOCUMENTS } from '@/components/settings/legal-documents';

export const metadata = { title: 'Legal — TradeW Settings' };

export default function LegalIndexPage() {
  return (
    <SettingsSection
      title="Legal & policies"
      description="The documents that govern your use of TradeW."
    >
      <Card className="border-amber bg-amber-bg">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warning" className="px-1.5 py-0 text-[9px]">AWAITING LEGAL REVIEW</Badge>
          <span className="text-sm font-semibold text-text">None of these documents has been reviewed by a lawyer.</span>
        </div>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          They are drafted from how TradeW actually works, so that the product has the right
          structure and a reader can see where it stands. They deliberately make no compliance
          claim — not SEBI, not GDPR, not the DPDP Act, not any other regime — because a compliance
          claim is a legal representation and none has been verified. Where a question is open, the
          document says the question is open.
        </p>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        {LEGAL_DOCUMENTS.map((doc) => (
          <Link
            key={doc.slug}
            href={`/settings/legal/${doc.slug}`}
            className="flex flex-col rounded-card border border-border bg-card p-4 shadow-card transition-colors duration-micro hover:border-teal hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-text">{doc.title}</span>
              {!doc.reviewed && (
                <Badge tone="neutral" className="ml-auto px-1.5 py-0 text-[9px]">DRAFT</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">{doc.summary}</p>
            <span className="mt-2 text-xs font-semibold text-teal">Read →</span>
          </Link>
        ))}
      </div>
    </SettingsSection>
  );
}
