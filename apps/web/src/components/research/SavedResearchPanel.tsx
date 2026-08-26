'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Card, buttonClasses } from '@tradew/ui';
import { fetchResearchPreferences, saveResearchPreferences, type SavedResearchKind } from '@/lib/research/storage';
import type { PeriodType, ResearchAnalysis } from '@/lib/research/types';
import { asOf } from '@/lib/research/format';
import { DataUnavailable } from './DataUnavailable';

export function SavedResearchPanel({
  symbol,
  periodType,
  latestAnalysis,
}: {
  symbol: string;
  periodType: PeriodType;
  latestAnalysis: ResearchAnalysis | null;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['research', 'prefs'],
    queryFn: fetchResearchPreferences,
    staleTime: 60_000,
    retry: 1,
  });
  const [kind, setKind] = useState<SavedResearchKind>('note');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const symbolEntries = useMemo(
    () => (query.data?.saved ?? []).filter((entry) => entry.symbol === symbol).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [query.data?.saved, symbol],
  );

  const saveEntry = async (entryKind: SavedResearchKind, entryTitle: string, entryBody: string) => {
    if (!query.data) return;
    const next = {
      ...query.data,
      saved: [
        {
          id: crypto.randomUUID(),
          symbol,
          kind: entryKind,
          title: entryTitle.trim(),
          body: entryBody.trim(),
          periodType,
          createdAt: new Date().toISOString(),
        },
        ...query.data.saved,
      ].slice(0, 30),
    };
    await saveResearchPreferences(next);
    await client.invalidateQueries({ queryKey: ['research', 'prefs'] });
  };

  if (query.isError) {
    return (
      <DataUnavailable
        title="Saved research unavailable"
        reason={query.error instanceof Error ? query.error.message : 'Research preferences could not be loaded.'}
      />
    );
  }

  return (
    <Card title="Saved research" subtitle="· notes, thesis, saved AI summaries and history">
      <div className="space-y-4">
        {latestAnalysis && (
          <div className="rounded-lg border border-border px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-faint">Latest AI summary</p>
                <p className="mt-1 text-[11px] text-muted">{latestAnalysis.provider} · {latestAnalysis.model}</p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await saveEntry(
                    'ai-summary',
                    `${symbol} AI summary`,
                    latestAnalysis.sections.map((section) => `${section.heading}\n${section.body}`).join('\n\n'),
                  );
                  setMessage('Saved the latest AI summary.');
                }}
                className={buttonClasses({ variant: 'outline', size: 'sm' })}
              >
                Save AI summary
              </button>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-border px-3 py-2.5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-faint">New entry</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {(['brief', 'note', 'thesis', 'finding'] as SavedResearchKind[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={buttonClasses({ variant: kind === option ? 'primary' : 'outline', size: 'sm' })}
              >
                {option}
              </button>
            ))}
          </div>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Title"
            className="mt-3 w-full rounded-lg border border-border2 bg-card px-3 py-2 text-xs text-text focus:border-teal focus:outline-none"
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Write the thesis, finding, or note exactly as you want it saved."
            rows={5}
            className="mt-2 w-full rounded-lg border border-border2 bg-card px-3 py-2 text-xs text-text focus:border-teal focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[10.5px] text-faint">Saved research is persisted in your account preferences for this session.</p>
            <button
              type="button"
              disabled={!title.trim() || !body.trim() || !query.data}
              onClick={async () => {
                await saveEntry(kind, title, body);
                setTitle('');
                setBody('');
                setMessage('Saved your research note.');
              }}
              className={buttonClasses({ variant: 'primary', size: 'sm' })}
            >
              Save
            </button>
          </div>
          {message && <p className="mt-2 text-[11px] text-faint">{message}</p>}
        </div>

        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-faint">Saved for {symbol}</p>
          {symbolEntries.length === 0 && (
            <p className="text-[11px] text-faint">Nothing saved for this company yet. History is still tracked automatically.</p>
          )}
          {symbolEntries.map((entry) => (
            <div key={entry.id} className="rounded-lg border border-border px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="neutral" className="px-1.5 py-0 text-[9px] uppercase">
                  {entry.kind}
                </Badge>
                <span className="text-[10.5px] text-faint">{asOf(entry.createdAt)}</span>
              </div>
              <p className="mt-2 text-sm font-semibold text-text">{entry.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-muted">{entry.body}</p>
            </div>
          ))}
        </div>

        {query.data && query.data.history.length > 0 && (
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-faint">Recent history</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {query.data.history.slice(0, 8).map((entry, index) => (
                <Link
                  key={`${entry.symbol}-${entry.viewedAt}-${index}`}
                  href={`/research?symbol=${encodeURIComponent(entry.symbol)}&period=${entry.periodType}`}
                  className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text"
                >
                  {entry.symbol} · {entry.periodType}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
