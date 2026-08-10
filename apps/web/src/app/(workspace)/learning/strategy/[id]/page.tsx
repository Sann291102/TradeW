import { notFound } from 'next/navigation';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge, Card } from '@tradew/ui';
import { getAllIds, getEntry } from '@/lib/learning/catalog';
import type { Strategy } from '@/lib/learning/types';

/**
 * A single lesson, rendered from its markdown in `docs/learning/`.
 *
 * Until this route existed the app could show a strategy's payoff shape but
 * never explain it — the prose sat in the repo where no user could reach it.
 * Statically generated at build time, same as the rest of the Hub.
 */

export function generateStaticParams() {
  return getAllIds().map((id) => ({ id }));
}

export function generateMetadata({ params }: { params: { id: string } }) {
  const entry = getEntry(params.id);
  return { title: entry ? `${entry.name} — TradeW Learning` : 'Learning — TradeW' };
}

function isStrategy(entry: NonNullable<ReturnType<typeof getEntry>>): entry is Strategy {
  return 'legs' in entry;
}

export default function LessonPage({ params }: { params: { id: string } }) {
  const entry = getEntry(params.id);
  if (!entry) notFound();

  return (
    <div className="mx-auto max-w-[820px] space-y-4 p-4">
      <div>
        <Link href="/learning" className="text-[11px] font-semibold text-teal hover:underline">
          ← All lessons
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-bold text-text">{entry.name}</h1>
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
            {entry.tier}
          </Badge>
          {isStrategy(entry) && (
            <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">
              {entry.legs.length} {entry.legs.length === 1 ? 'leg' : 'legs'}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{entry.summary}</p>
      </div>

      {isStrategy(entry) && (
        <Card title="At a glance">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[11.5px] sm:grid-cols-2">
            <Row label="Outlook it expresses" value={entry.outlook} />
            <Row label="Opens with" value={entry.net === 'credit' ? 'a credit' : entry.net === 'debit' ? 'a debit' : 'no net cost'} />
            <Row label="Best case" value={entry.maxProfit} />
            <Row label="Worst case" value={entry.maxLoss} />
            <Row label="Breakeven" value={entry.breakeven} />
            {Object.keys(entry.greeks).length > 0 && (
              <Row
                label="Exposures"
                value={Object.entries(entry.greeks)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ')}
              />
            )}
          </dl>
        </Card>
      )}

      {/* Prose styling is explicit rather than via a typography plugin, which
          this app does not include. */}
      <Card title="Lesson">
        <div
          className={[
            'text-[12.5px] leading-relaxed text-muted',
            '[&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-bold [&_h1]:text-text',
            '[&_h2]:mb-1.5 [&_h2]:mt-5 [&_h2]:text-[13px] [&_h2]:font-bold [&_h2]:text-text',
            '[&_h3]:mb-1 [&_h3]:mt-4 [&_h3]:text-[12px] [&_h3]:font-semibold [&_h3]:text-text',
            '[&_p]:mb-2.5',
            '[&_strong]:font-semibold [&_strong]:text-text',
            '[&_ul]:mb-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2.5 [&_ol]:list-decimal [&_ol]:pl-5',
            '[&_li]:mb-1',
            '[&_code]:rounded [&_code]:bg-bg [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-text',
            '[&_table]:mb-3 [&_table]:w-full [&_table]:text-left [&_table]:text-[11.5px]',
            '[&_th]:border-b [&_th]:border-border [&_th]:pb-1 [&_th]:pr-3 [&_th]:font-semibold [&_th]:text-text',
            '[&_td]:border-b [&_td]:border-border [&_td]:py-1 [&_td]:pr-3 [&_td]:align-top',
            '[&_a]:text-teal hover:[&_a]:underline',
            '[&_blockquote]:border-l-2 [&_blockquote]:border-border2 [&_blockquote]:pl-3 [&_blockquote]:italic',
          ].join(' ')}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            // Cross-references in the markdown are repo paths like
            // `greeks/gamma.md`. Many targets are not authored yet, so they
            // render as plain text rather than as links that 404.
            components={{ a: ({ children, href }) => (href?.startsWith('http') ? <a href={href}>{children}</a> : <span>{children}</span>) }}
          >
            {entry.body}
          </ReactMarkdown>
        </div>
      </Card>

      <p className="text-[10px] leading-relaxed text-faint">
        Educational material describing how a structure behaves. Not a recommendation, not a signal, and not personalised
        advice. Source: <code className="font-mono">{entry.path}</code>
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-36 shrink-0 text-faint">{label}</dt>
      <dd className="text-text">{value}</dd>
    </div>
  );
}
