'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { Mermaid } from './Mermaid';

/**
 * Vault markdown renderer. GFM (tables, task lists, strikethrough) via
 * remark-gfm; fenced ```mermaid blocks render as diagrams; [[wiki links]] are
 * rewritten to internal navigation. Raw HTML is intentionally NOT rendered
 * (no rehype-raw) so vault content can't inject markup — safe by default.
 */
export function MarkdownView({
  content,
  onNavigate,
}: {
  content: string;
  onNavigate: (target: string) => void;
}) {
  // Strip the leading YAML frontmatter (shown separately as chips/metadata).
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  // Rewrite [[wiki]] / [[wiki|alias]] into a sentinel link the renderer maps
  // to an internal navigation click (react-markdown parses standard md links).
  const withWikiLinks = body.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_all, target, alias) => {
    const label = (alias ?? target).trim();
    return `[${label}](#wiki:${encodeURIComponent(String(target).trim())})`;
  });

  const components: Components = {
    a({ href, children, ...props }) {
      const h = href ?? '';
      if (h.startsWith('#wiki:')) {
        const target = decodeURIComponent(h.slice('#wiki:'.length));
        return (
          <button
            type="button"
            onClick={() => onNavigate(target)}
            className="text-[#14b8a6] underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {children}
          </button>
        );
      }
      // Relative .md link → navigate inside the workspace; external → new tab.
      if (h.endsWith('.md') || h.startsWith('./') || h.startsWith('../')) {
        return (
          <button
            type="button"
            onClick={() => onNavigate(h)}
            className="text-[#14b8a6] underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {children}
          </button>
        );
      }
      return (
        <a href={h} target="_blank" rel="noreferrer" className="text-[#14b8a6] underline underline-offset-2" {...props}>
          {children}
        </a>
      );
    },
    code({ className, children }) {
      const text = String(children ?? '').replace(/\n$/, '');
      const lang = /language-(\w+)/.exec(className ?? '')?.[1];
      if (lang === 'mermaid') return <Mermaid chart={text} />;
      if (!className) {
        return <code className="rounded bg-[#0d1524] px-1.5 py-0.5 text-[12px] text-[#7fd4c9]">{children}</code>;
      }
      return (
        <pre className="my-3 overflow-x-auto rounded-lg border border-[#1e2c47] bg-[#0d1524] p-3 text-[12px] leading-relaxed">
          <code className="text-[#c6d0e2]">{text}</code>
        </pre>
      );
    },
    table({ children }) {
      return (
        <div className="my-3 overflow-x-auto rounded-lg border border-[#1e2c47]">
          <table className="w-full border-collapse text-[12.5px]">{children}</table>
        </div>
      );
    },
    thead: ({ children }) => <thead className="bg-[#0d1524] text-[#8ea0c4]">{children}</thead>,
    th: ({ children }) => <th className="border border-[#1e2c47] px-3 py-1.5 text-left font-semibold">{children}</th>,
    td: ({ children }) => <td className="border border-[#1e2c47] px-3 py-1.5 align-top">{children}</td>,
    h1: ({ children }) => <h1 className="mb-3 mt-5 text-[20px] font-bold text-[#e2e8f0]">{children}</h1>,
    h2: ({ children }) => <h2 className="mb-2 mt-5 border-b border-[#1e2c47] pb-1 text-[16px] font-semibold text-[#e2e8f0]">{children}</h2>,
    h3: ({ children }) => <h3 className="mb-2 mt-4 text-[14px] font-semibold text-[#c6d0e2]">{children}</h3>,
    p: ({ children }) => <p className="my-2.5 leading-relaxed text-[#c6d0e2]">{children}</p>,
    ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-6 text-[#c6d0e2]">{children}</ul>,
    ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-6 text-[#c6d0e2]">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    input: ({ checked, type }) =>
      type === 'checkbox' ? (
        <input type="checkbox" checked={!!checked} readOnly className="mr-2 translate-y-[1px] accent-[#14b8a6]" />
      ) : null,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-[#14b8a6] bg-[#0d1524] py-1 pl-3 text-[#95a3bd]">{children}</blockquote>
    ),
    hr: () => <hr className="my-4 border-[#1e2c47]" />,
  };

  return (
    <div className="text-[13.5px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {withWikiLinks}
      </ReactMarkdown>
    </div>
  );
}
