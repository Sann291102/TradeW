import Link from 'next/link';
import { Card } from '@tradew/ui';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { LEGAL_DOCUMENTS } from '@/components/settings/legal-documents';

export const metadata = { title: 'About — TradeW Settings' };

/**
 * About.
 *
 * Values come from `NEXT_PUBLIC_*` variables that the build can set, with a
 * plain "not set" where it has not. A hardcoded version string is worse than
 * no version string: it is the field people quote in a bug report, and a stale
 * one sends the reader to the wrong commit.
 *
 * There is no release-notes feed and no generated licence manifest in this
 * repository, so neither is invented here.
 */
const VERSION = process.env.NEXT_PUBLIC_APP_VERSION;
const COMMIT = process.env.NEXT_PUBLIC_GIT_SHA;
const BUILT_AT = process.env.NEXT_PUBLIC_BUILD_TIME;
const ENVIRONMENT = process.env.NEXT_PUBLIC_ENVIRONMENT ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development');

function Field({ label, value, hint }: { label: string; value?: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border py-2.5 last:border-b-0">
      <dt className="w-40 shrink-0 text-xs font-semibold text-faint">{label}</dt>
      <dd className="min-w-0 flex-1">
        <span className={value ? 'font-mono text-sm text-text' : 'text-sm text-muted'}>
          {value || 'Not set on this build'}
        </span>
        {hint && <span className="ml-2 text-[11px] text-faint">{hint}</span>}
      </dd>
    </div>
  );
}

export default function AboutPage() {
  return (
    <SettingsSection title="About" description="What this build is, and what it is made of.">
      <Card title="TradeW">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          An AI trading workspace: live Indian market data, a paper-trading order engine, and AI
          Sentinel — an observer that watches strategies and describes what it sees. Every order in
          TradeW is paper. Nothing here is investment advice.
        </p>
      </Card>

      <Card title="Build">
        <dl>
          <Field label="Version" value={VERSION} />
          <Field label="Commit" value={COMMIT} />
          <Field label="Built" value={BUILT_AT} />
          <Field label="Environment" value={ENVIRONMENT} />
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-faint">
          Blank fields mean the build did not set them, not that the information is hidden. Include
          whatever is shown here in a bug report — it is what identifies which build you are on.
        </p>
      </Card>

      <Card title="Legal">
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {LEGAL_DOCUMENTS.map((doc) => (
            <li key={doc.slug}>
              <Link href={`/settings/legal/${doc.slug}`} className="text-xs text-teal hover:underline">
                {doc.title}
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Open-source licences">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          TradeW is built on open-source software — among it Next.js and React (MIT),
          lightweight-charts (Apache-2.0), NestJS (MIT), Prisma (Apache-2.0), TanStack Query (MIT),
          Zustand (MIT), Tailwind CSS (MIT) and Framer Motion (MIT).
        </p>
        <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-amber">
          This is not the full manifest. There is no generated licence report in the repository, and
          listing a handful of packages as though it were complete would misstate what TradeW
          depends on. The authoritative list is the dependency tree of the build.
        </p>
      </Card>

      <Card title="Release notes">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          There is no in-app changelog feed. Release history lives with the source repository rather
          than being served to the client, so this page does not render one.
        </p>
      </Card>
    </SettingsSection>
  );
}
