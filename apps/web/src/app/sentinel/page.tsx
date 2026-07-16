'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import Link from 'next/link';

/**
 * Sentinel workspace — layout per docs/product-architecture/SENTINEL.md §5:
 * alert callout → reflection cards → (agent timeline / observation feed /
 * session summary) → trading journal. Visual system: TradeW Terminal v0.4.2
 * dark HUD tokens. Observation-only: no buy/sell/entry/exit language anywhere.
 */

type Synthesis = { content: string; pattern: string; confidence: number; disclaimer: string };
type Observation = {
  agent: string;
  category: string;
  pattern?: string | null;
  symbol?: string | null;
  content: string;
  evidence: string[];
  confidence: number;
  createdAt?: string;
  surfaced?: boolean;
};
type Signal = { name: string; agent: string; triggered: boolean; weight: number; evidence: string[] };
type ObserveResponse = { synthesis: Synthesis | null; observations: Observation[]; signals: Signal[] };
type SessionSummary = { tradesToday: number; flaggedEvents: number; realizedPnl: number };
type JournalEntry = { id: string; mood?: string | null; content: string; flaggedByAi: boolean; createdAt: string };

const DEMO: ObserveResponse = {
  synthesis: {
    content:
      'India VIX at 18.8 — elevated. 3 entries within 15 minutes of a losing exit in this session. Position sizing on the last trade was 2.3x your session average. Longest losing streak this session: 3 trades. Together these resemble a revenge trading pattern on NIFTY. This is an observation, not advice — consider waiting for confirmation before acting.',
    pattern: 'revenge_trading',
    confidence: 0.925,
    disclaimer:
      'Sentinel shares observations and educational context only. It is not investment advice and never recommends trades.',
  },
  observations: [
    { agent: 'market-technical', category: 'market_structure_observation', pattern: 'elevated_vix', symbol: 'NIFTY', content: 'India VIX at 18.8 — elevated', evidence: ['India VIX at 18.8 — elevated'], confidence: 0.7 },
    { agent: 'emotion', category: 'behavioral_pattern_observation', pattern: 'revenge_trading', symbol: 'NIFTY', content: '3 entries within 15 minutes of a losing exit in this session', evidence: [], confidence: 0.75 },
    { agent: 'emotion', category: 'behavioral_pattern_observation', pattern: 'position_sizing_drift', symbol: 'NIFTY', content: 'Position sizing on the last trade was 2.3x your session average', evidence: [], confidence: 0.7 },
    { agent: 'emotion', category: 'behavioral_pattern_observation', pattern: 'loss_streak', symbol: 'NIFTY', content: 'Longest losing streak this session: 3 trades', evidence: [], confidence: 0.7 },
  ],
  signals: [
    { name: 'elevated_vix', agent: 'market-technical', triggered: true, weight: 0.3, evidence: ['India VIX at 18.8'] },
    { name: 'revenge_trading', agent: 'emotion', triggered: true, weight: 0.35, evidence: ['3 entries within 15 min of a losing exit'] },
    { name: 'position_sizing_drift', agent: 'emotion', triggered: true, weight: 0.3, evidence: ['Last trade 2.3x session average'] },
    { name: 'loss_streak', agent: 'emotion', triggered: true, weight: 0.3, evidence: ['3 consecutive losing trades'] },
    { name: 'low_volume_breakout', agent: 'trap-safety', triggered: false, weight: 0.4, evidence: ['No breakout without participation'] },
    { name: 'bull_trap', agent: 'trap-safety', triggered: false, weight: 0.45, evidence: ['No failed breakout above resistance'] },
    { name: 'overbought_rsi', agent: 'market-technical', triggered: false, weight: 0.2, evidence: ['RSI(14) is 50.1'] },
    { name: 'weak_breadth', agent: 'market-technical', triggered: false, weight: 0.15, evidence: ['Advance/decline ratio 1.04'] },
  ],
};

const AGENT_LABEL: Record<string, string> = {
  'market-technical': 'Market & Technical',
  emotion: 'Emotion Intelligence',
  'trap-safety': 'Trap & Safety',
  orchestrator: 'Sentinel Orchestrator',
  'compliance-audit': 'Compliance & Audit',
};

const AGENT_COLOR: Record<string, string> = {
  'market-technical': '#14b8a6',
  emotion: '#f0a53c',
  'trap-safety': '#ef5350',
  orchestrator: '#8ea0c4',
};

const pretty = (s?: string | null) => (s ?? '').replace(/_/g, ' ');

export default function SentinelPage() {
  const [data, setData] = useState<ObserveResponse | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState('');
  const [mood, setMood] = useState('focused');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const observe = (await api('/sentinel/observe', { method: 'POST', body: JSON.stringify({ symbol: 'NIFTY' }) })) as ObserveResponse;
      setData(observe);
      setDemoMode(false);
      try {
        setSummary((await api('/sentinel/session-summary')) as SessionSummary);
        setJournal((await api('/sentinel/journal?limit=10')) as JournalEntry[]);
      } catch {
        /* secondary panels degrade independently */
      }
    } catch {
      // API offline or not signed in — render the workspace with sample data
      setData(DEMO);
      setSummary({ tradesToday: 7, flaggedEvents: 1, realizedPnl: -10875 });
      setJournal([
        { id: 'demo-j1', mood: 'frustrated', content: 'Kept re-entering after stops. Sentinel flagged my pacing — taking a break.', flaggedByAi: true, createdAt: new Date().toISOString() },
      ]);
      setDemoMode(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function addJournal() {
    if (!entry.trim()) return;
    try {
      await api('/sentinel/journal', { method: 'POST', body: JSON.stringify({ content: entry, mood }) });
      setEntry('');
      setJournal((await api('/sentinel/journal?limit=10')) as JournalEntry[]);
    } catch {
      setJournal((j) => [{ id: `local-${Date.now()}`, mood, content: entry, flaggedByAi: false, createdAt: new Date().toISOString() }, ...j]);
      setEntry('');
    }
  }

  const emotions = data?.observations.filter((o) => o.agent === 'emotion') ?? [];
  const feed = data?.observations ?? [];
  const signals = data?.signals ?? [];

  return (
    <div className="min-h-screen bg-[#0d1524] text-[#e2e8f0] text-[13.5px]">
      {/* top bar — shared app-shell chrome */}
      <header className="flex items-center gap-4 border-b border-[#1e2c47] bg-[#131e33] px-5 py-3">
        <span className="font-bold tracking-wide text-[15px]">
          Trade<span className="text-[#14b8a6]">W</span>
        </span>
        <nav className="flex items-center gap-1 text-[#8ea0c4]">
          <Link href="/trade" className="rounded-lg px-3 py-1.5 hover:bg-[#182642]">Terminal</Link>
          <span className="cursor-default rounded-lg px-3 py-1.5 text-[#64769c]" title="Coming soon">Research</span>
          <span className="rounded-lg bg-[#12312f] px-3 py-1.5 font-semibold text-[#14b8a6]">Sentinel</span>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="rounded-full bg-[#3a2d14] px-2.5 py-0.5 text-[11px] font-semibold text-[#f0a53c]">PAPER</span>
          <span className="flex items-center gap-1.5 text-[12px] text-[#8ea0c4]">
            <span className={`inline-block h-2 w-2 rounded-full ${loading ? 'bg-[#f0a53c]' : 'bg-[#26a69a]'} animate-pulse`} />
            {loading ? 'Synthesizing…' : 'Agent Desk: Observing'}
          </span>
          <button onClick={() => void refresh()} className="rounded-lg border border-[#2a3a5c] px-3 py-1.5 text-[12px] text-[#8ea0c4] hover:bg-[#182642]">
            ⟳ Refresh
          </button>
        </div>
      </header>

      {demoMode && (
        <div className="border-b border-[#3a2d14] bg-[#3a2d14]/40 px-5 py-2 text-[12px] text-[#f0a53c]">
          Demo data — backend API not reachable (sign in with a Sentinel-entitled account for live observations). The layout and copy below are exactly what the live desk produces.
        </div>
      )}

      <main className="mx-auto max-w-[1200px] space-y-5 p-5">
        {/* 1 — alert callout (orchestrator synthesis, the only user-facing voice) */}
        {data?.synthesis ? (
          <section className="rounded-xl border border-[#ef5350]/40 bg-[#3a1f1e]/60 p-5 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
            <div className="mb-2 flex items-center gap-3">
              <span className="rounded-md bg-[#ef5350] px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
                {pretty(data.synthesis.pattern)}
              </span>
              <span className="text-[12px] text-[#8ea0c4]">
                confidence {(data.synthesis.confidence * 100).toFixed(0)}% · multiple corroborating signals
              </span>
            </div>
            <p className="leading-relaxed">{data.synthesis.content}</p>
            <p className="mt-3 border-t border-[#ef5350]/20 pt-2 text-[11.5px] italic text-[#95a3bd]">{data.synthesis.disclaimer}</p>
          </section>
        ) : (
          <section className="rounded-xl border border-[#1e2c47] bg-[#131e33] p-5">
            <p className="text-[#8ea0c4]">
              <span className="mr-2 inline-block h-2 w-2 rounded-full bg-[#26a69a]" />
              No composite risk pattern right now. Sentinel keeps observing — individual signals appear in the timeline below.
            </p>
          </section>
        )}

        {/* 2 — AI reflection cards */}
        <section>
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-widest text-[#64769c]">AI Reflection Cards</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {(emotions.length ? emotions.slice(0, 3) : [{ agent: 'emotion', category: '', pattern: 'no_patterns', content: 'No behavioral patterns detected this session. Discipline holding steady.', evidence: [], confidence: 0.5 } as Observation]).map(
              (o, i) => (
                <div key={i} className="rounded-xl border border-[#1e2c47] bg-[#131e33] p-4">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[12px] font-semibold capitalize text-[#f0a53c]">{pretty(o.pattern)}</span>
                    <span className="text-[10.5px] text-[#64769c]">Emotion Intelligence</span>
                  </div>
                  <p className="text-[12.5px] leading-relaxed text-[#c6d0e2]">{o.content}</p>
                  <button className="mt-3 text-[12px] font-medium text-[#14b8a6] hover:underline">Reflect with AI ↗</button>
                </div>
              ),
            )}
          </div>
        </section>

        {/* 3 — three-column intelligence footer */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-[#1e2c47] bg-[#131e33] p-4">
            <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-[#64769c]">Agent Activity Timeline</h3>
            <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {signals.map((s, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.triggered ? AGENT_COLOR[s.agent] ?? '#8ea0c4' : '#2a3a5c' }} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-[12px] font-medium capitalize ${s.triggered ? '' : 'text-[#64769c]'}`}>{pretty(s.name)}</span>
                      <span className="text-[10px] uppercase tracking-wide text-[#64769c]">{AGENT_LABEL[s.agent]}</span>
                    </div>
                    <p className="truncate text-[11.5px] text-[#8ea0c4]">{s.evidence[0]}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-[#1e2c47] bg-[#131e33] p-4">
            <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-[#64769c]">Observation Feed</h3>
            <ul className="max-h-72 space-y-3 overflow-y-auto pr-1">
              {feed.map((o, i) => (
                <li key={i} className="rounded-lg border border-[#1e2c47] bg-[#0d1524] p-2.5">
                  <div className="mb-1 flex items-center gap-2 text-[10.5px] uppercase tracking-wide">
                    <span style={{ color: AGENT_COLOR[o.agent] ?? '#8ea0c4' }}>{AGENT_LABEL[o.agent] ?? o.agent}</span>
                    <span className="text-[#64769c]">{o.category.replace(/_/g, ' ')}</span>
                    {o.symbol && <span className="ml-auto text-[#8ea0c4]">{o.symbol}</span>}
                  </div>
                  <p className="text-[12px] leading-snug text-[#c6d0e2]">{o.content}</p>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-[#1e2c47] bg-[#131e33] p-4">
            <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-[#64769c]">Session Summary</h3>
            <dl className="space-y-3">
              <div className="flex items-center justify-between rounded-lg bg-[#0d1524] px-3 py-2.5">
                <dt className="text-[#8ea0c4]">Trades Today</dt>
                <dd className="font-semibold">{summary?.tradesToday ?? '—'}</dd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-[#0d1524] px-3 py-2.5">
                <dt className="text-[#8ea0c4]">Flagged Events</dt>
                <dd className={`font-semibold ${(summary?.flaggedEvents ?? 0) > 0 ? 'text-[#f0a53c]' : ''}`}>{summary?.flaggedEvents ?? '—'}</dd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-[#0d1524] px-3 py-2.5">
                <dt className="text-[#8ea0c4]">Realized P&L</dt>
                <dd className={`font-semibold ${(summary?.realizedPnl ?? 0) < 0 ? 'text-[#ef5350]' : 'text-[#26a69a]'}`}>
                  {summary ? `₹${summary.realizedPnl.toLocaleString('en-IN')}` : '—'}
                </dd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-[#0d1524] px-3 py-2.5">
                <dt className="text-[#8ea0c4]">Order Flow</dt>
                <dd className="text-[11.5px] font-medium text-[#26a69a]">Never blocked by Sentinel</dd>
              </div>
            </dl>
          </div>
        </section>

        {/* 4 — trading journal */}
        <section className="rounded-xl border border-[#1e2c47] bg-[#131e33] p-4">
          <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-[#64769c]">Trading Journal</h3>
          <div className="mb-4 flex gap-2">
            <select value={mood} onChange={(e) => setMood(e.target.value)} className="rounded-lg border border-[#2a3a5c] bg-[#0d1524] px-2.5 py-2 text-[12.5px]">
              <option value="focused">🎯 Focused</option>
              <option value="anxious">😰 Anxious</option>
              <option value="confident">😎 Confident</option>
              <option value="frustrated">😤 Frustrated</option>
            </select>
            <input
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addJournal()}
              placeholder="What's on your mind this session?"
              className="flex-1 rounded-lg border border-[#2a3a5c] bg-[#0d1524] px-3 py-2 text-[12.5px] placeholder:text-[#64769c]"
            />
            <button onClick={() => void addJournal()} className="rounded-lg bg-[#14b8a6] px-4 py-2 text-[12.5px] font-semibold text-[#0d1524] hover:opacity-90">
              Log entry
            </button>
          </div>
          <ul className="space-y-2">
            {journal.map((j) => (
              <li key={j.id} className="flex items-start gap-3 rounded-lg bg-[#0d1524] px-3 py-2.5">
                <span className="text-[11px] uppercase tracking-wide text-[#f0a53c]">{j.mood ?? '—'}</span>
                <p className="flex-1 text-[12.5px] text-[#c6d0e2]">{j.content}</p>
                {j.flaggedByAi && <span className="rounded bg-[#12312f] px-1.5 py-0.5 text-[10px] font-semibold text-[#14b8a6]">flagged by AI Sentinel</span>}
              </li>
            ))}
          </ul>
        </section>

        <p className="pb-6 text-center text-[11px] text-[#64769c]">
          Sentinel observes, researches, remembers, teaches, explains and protects. It never executes trades and never gives buy, sell, entry, exit or target recommendations.
        </p>
      </main>
    </div>
  );
}
