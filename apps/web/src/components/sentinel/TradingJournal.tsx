'use client';

import { useState } from 'react';
import type { JournalEntry } from '@/lib/sentinel/types';

export function TradingJournal({
  journal,
  onAdd,
}: {
  journal: JournalEntry[];
  onAdd: (content: string, mood: string) => void | Promise<void>;
}) {
  const [entry, setEntry] = useState('');
  const [mood, setMood] = useState('focused');

  function submit() {
    if (!entry.trim()) return;
    void onAdd(entry, mood);
    setEntry('');
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-faint">Trading Journal</h3>
      <div className="mb-4 flex gap-2">
        <select
          value={mood}
          onChange={(e) => setMood(e.target.value)}
          className="rounded-lg border border-border2 bg-bg px-2.5 py-2 text-[12.5px] text-text"
        >
          <option value="focused">🎯 Focused</option>
          <option value="anxious">😰 Anxious</option>
          <option value="confident">😎 Confident</option>
          <option value="frustrated">😤 Frustrated</option>
        </select>
        <input
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="What's on your mind this session?"
          className="flex-1 rounded-lg border border-border2 bg-bg px-3 py-2 text-[12.5px] text-text placeholder:text-faint"
        />
        <button onClick={submit} className="rounded-lg bg-teal px-4 py-2 text-[12.5px] font-semibold text-bg hover:opacity-90">
          Log entry
        </button>
      </div>
      <ul className="space-y-2">
        {journal.map((j) => (
          <li key={j.id} className="flex items-start gap-3 rounded-lg bg-bg px-3 py-2.5">
            <span className="text-[11px] uppercase tracking-wide text-amber">{j.mood ?? '—'}</span>
            <p className="flex-1 text-[12.5px] text-muted">{j.content}</p>
            {j.flaggedByAi && <span className="rounded bg-teal-bg px-1.5 py-0.5 text-[10px] font-semibold text-teal">flagged by AI Sentinel</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
