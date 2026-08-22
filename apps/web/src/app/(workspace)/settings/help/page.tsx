import Link from 'next/link';
import { Badge, Card } from '@tradew/ui';
import { SettingsSection } from '@/components/settings/SettingsSection';

export const metadata = { title: 'Help & Support — TradeW Settings' };

/**
 * Help & Support.
 *
 * ── WHY THERE IS NO CONTACT FORM ───────────────────────────────────────────
 *
 * TradeW has no support desk: no ticketing system, no support inbox route, no
 * feedback endpoint. A form here would collect a message, show "Thanks, we'll
 * be in touch", and drop it — which is worse than no form, because the person
 * who wrote it stops looking for another way to reach anyone.
 *
 * So this page routes people to things that exist: the in-product guide, the
 * assistant, and the operator email configured for this deployment. If your
 * deployment has a real support channel, set NEXT_PUBLIC_SUPPORT_EMAIL and the
 * contact card becomes a live mailto instead of the notice below.
 */
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;

export default function HelpPage() {
  return (
    <SettingsSection title="Help & Support" description="Where to look, and how to reach a person.">
      <Card title="In the product">
        <ul className="space-y-2 text-xs text-muted">
          <li>
            <Link href="/settings/how-to-use" className="font-semibold text-teal hover:underline">
              How to use TradeW
            </Link>{' '}
            — what each workspace does, and what it deliberately does not.
          </li>
          <li>
            <Link href="/learning" className="font-semibold text-teal hover:underline">
              Learning
            </Link>{' '}
            — courses and concepts on trading itself, rather than on the software.
          </li>
          <li>
            <span className="font-semibold text-text">The assistant</span> — the floating button in
            the bottom corner answers questions about the workspace you are in.
          </li>
          <li>
            <span className="font-semibold text-text">Keyboard shortcuts</span> — press{' '}
            <kbd className="rounded border border-border2 bg-bg px-1 font-mono text-[10px]">?</kbd>.
          </li>
        </ul>
      </Card>

      <Card title="Contact support">
        {SUPPORT_EMAIL ? (
          <p className="text-xs text-muted">
            Email{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="font-semibold text-teal hover:underline">
              {SUPPORT_EMAIL}
            </a>
            . Include your account email and, if it is about an order, the order id from Orders.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">NOT CONFIGURED</Badge>
              <span className="text-sm font-semibold text-text">No support channel is set on this deployment.</span>
            </div>
            <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
              TradeW has no ticketing system and no support inbox route. Rather than showing a
              contact form that would accept a message and discard it, this says so. An operator can
              set <code className="font-mono text-[11px]">NEXT_PUBLIC_SUPPORT_EMAIL</code> to turn
              this card into a real contact address.
            </p>
          </>
        )}
      </Card>

      <Card title="Report a problem">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Two things make a report actionable: what you did, and what you saw instead. If it
          involves an order, the order id from{' '}
          <Link href="/orders" className="text-teal hover:underline">
            Orders
          </Link>{' '}
          is the fastest way to find it server-side — every order carries its own reject reason and
          audit trail.
        </p>
        <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-amber">
          There is no in-app bug reporter or feedback endpoint. Reports go to the support address
          above when one is configured.
        </p>
      </Card>

      <Card title="System status">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">NOT AVAILABLE</Badge>
          <span className="text-sm font-semibold text-text">There is no public status page.</span>
        </div>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          The API exposes a health endpoint for its own monitoring, but nothing publishes an
          incident history or component status to users. Where a service is down, the surface that
          depends on it says so where you are looking — the market ticker, the Sentinel connection
          banner and the portfolio error state each report their own dependency.
        </p>
      </Card>
    </SettingsSection>
  );
}
