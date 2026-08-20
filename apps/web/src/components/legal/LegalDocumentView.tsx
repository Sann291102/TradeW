import Link from 'next/link';
import { LEGAL_DOCUMENTS, type LegalBlock, type LegalDocument } from '@/lib/legal/documents';

/**
 * Renders one legal document.
 *
 * A server component over structured data (lib/legal/documents.ts) rather than
 * MDX or a CMS. Three reasons, in order of weight:
 *
 *  1. Every heading gets a stable `id` by construction, so `/legal/privacy#your-rights`
 *     — a link that appears in the footer — cannot silently stop resolving
 *     because someone reworded a heading.
 *  2. The set of documents is enumerable at build time, so `links.test.ts` can
 *     assert that every `/legal/*` href in the footer has a document behind it
 *     and that every document is public in the middleware.
 *  3. No new dependency. The app already ships react-markdown for lesson
 *     content, but that path renders untrusted-ish authored strings; legal text
 *     is code-reviewed and benefits from being typed instead.
 *
 * Prose here is intentionally narrow (max-w-3xl) and set at the body scale
 * rather than the workspace's dense data scale — these are documents to be
 * read, not panels to be scanned.
 */

function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case 'p':
      return <p className="mt-4 text-fsSm leading-normal2 text-muted">{block.text}</p>;

    case 'ul':
      return (
        <ul className="mt-4 space-y-2.5">
          {block.items.map((item) => (
            <li key={item} className="flex gap-3 text-fsSm leading-normal2 text-muted">
              <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-teal" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );

    case 'table':
      // Wide content scrolls inside its own container rather than making the
      // page scroll sideways — the tables here have up to five columns and are
      // read on phones.
      return (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[34rem] border-collapse text-left">
            <thead>
              <tr>
                {block.head.map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="border-b border-border bg-card px-4 py-3 text-fs2xs font-semibold uppercase tracking-wideTrack text-faint"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr key={row.join('|')} className="border-b border-border last:border-b-0">
                  {row.map((cell, i) => (
                    <td
                      key={`${i}-${cell}`}
                      className={`px-4 py-3 align-top text-fsXs leading-normal2 ${
                        i === 0 ? 'font-medium text-text' : 'text-muted'
                      }`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'note':
      // `outstanding` is TradeW admitting a gap. It is given the amber
      // treatment rather than being tucked into body copy, because the whole
      // value of these notes is that a reader can find them.
      return (
        <div
          className={`mt-5 rounded-2xl border px-5 py-4 text-fsXs leading-normal2 ${
            block.tone === 'outstanding'
              ? 'border-amber bg-amber-bg text-text'
              : 'border-border bg-card text-muted'
          }`}
        >
          {block.tone === 'outstanding' && (
            <span className="mr-2 font-semibold uppercase tracking-wideTrack text-amber">
              Outstanding
            </span>
          )}
          {block.text}
        </div>
      );
  }
}

export function LegalDocumentView({ doc }: { doc: LegalDocument }) {
  const others = LEGAL_DOCUMENTS.filter((d) => d.slug !== doc.slug);

  return (
    <article className="mx-auto max-w-3xl px-6 py-16">
      <header>
        <Link
          href="/"
          className="rounded-sm text-fs2xs uppercase tracking-wideTrack text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          ← Back to TradeW
        </Link>

        <h1 className="mt-6 text-balance text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
          {doc.title}
        </h1>

        <p className="mt-2 text-fs2xs uppercase tracking-wideTrack text-faint">
          Effective {doc.effectiveDate}
        </p>

        <p className="mt-6 text-fsMd leading-normal2 text-text">{doc.summary}</p>

        {/* Rendered on the page, not buried in a repository. A reader deciding
            whether to trust a legal document is entitled to know it has not
            been through professional review yet. */}
        <div className="mt-6 rounded-2xl border border-border bg-card px-5 py-4">
          <p className="text-fs2xs font-semibold uppercase tracking-wideTrack text-faint">
            Not legal advice
          </p>
          <p className="mt-2 text-fsXs leading-normal2 text-muted">
            This document was written from what the platform actually does and from published
            regulatory sources. It has not been reviewed by a lawyer. {doc.pendingReview}
          </p>
        </div>
      </header>

      {/* Section index. Short documents do not need one; every document here is
          long enough that a reader arriving for one clause should not have to
          scroll to find it. */}
      <nav aria-label="On this page" className="mt-12 border-t border-border pt-6">
        <h2 className="text-fs2xs font-semibold uppercase tracking-wideTrack text-faint">
          On this page
        </h2>
        <ul className="mt-4 space-y-2">
          {doc.sections.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="rounded-sm text-fsXs text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {s.heading}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {doc.sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          // scroll-mt so a hash landing does not tuck the heading under the
          // top of the viewport — the same treatment the landing sections use.
          className="scroll-mt-8 border-t border-border pt-10 mt-12"
        >
          <h2 className="text-fsLg font-semibold tracking-tightTrack text-navy">
            {section.heading}
          </h2>
          {section.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </section>
      ))}

      {/* Cross-links. The legal surface is one set of documents that depend on
          each other — the Terms incorporate the Risk Disclosure, the Privacy
          Policy points at Security — so every page carries the whole set rather
          than sending the reader back to the footer to find the next one. */}
      <nav aria-label="Other legal documents" className="mt-16 border-t border-border pt-6">
        <h2 className="text-fs2xs font-semibold uppercase tracking-wideTrack text-faint">
          The rest of the legal surface
        </h2>
        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2.5">
          {others.map((d) => (
            <li key={d.slug}>
              <Link
                href={`/legal/${d.slug}`}
                className="rounded-sm text-fsXs text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {d.navLabel}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </article>
  );
}
