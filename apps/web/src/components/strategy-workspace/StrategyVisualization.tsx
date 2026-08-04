'use client';

import { useState } from 'react';
import {
  AGENT_LABELS,
  STANCE_LABELS,
  type ChartAnnotation,
  type KnowledgeCitation,
  type ReasoningRun,
  type WorkspacePayload,
} from '@/lib/strategy-workspace/types';

/**
 * Panel 3 — the AI strategy visualization.
 *
 * This is the panel that makes the other two auditable. Every annotation drawn
 * on the chart appears here with the three things the service guarantees it
 * carries: why it was placed, which learned rule triggered it, and the
 * confidence behind it — plus the citations back into the corpus the rule came
 * from.
 *
 * The synthesis block above it renders SILENCE as a first-class state. When the
 * gates do not clear there is no observation, and this panel says which gate
 * held rather than showing a low-confidence reading in smaller text.
 */
export function StrategyVisualization({
  payload,
  focusedId,
  onFocus,
}: {
  payload: WorkspacePayload;
  focusedId: string | null;
  onFocus: (id: string | null) => void;
}) {
  return (
    <div className="space-y-3">
      <SynthesisCard run={payload.reasoning} />
      <RuleMatches matches={payload.ruleMatches} />
      <AnnotationList annotations={payload.annotations} focusedId={focusedId} onFocus={onFocus} />
      <AgentVerdicts run={payload.reasoning} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function SynthesisCard({ run }: { run: ReasoningRun }) {
  const { synthesis } = run;
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  if (!synthesis.surfaced) {
    return (
      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-[12px] font-semibold text-text">Monitoring — nothing surfaced</h2>
          <span className="text-[10.5px] tabular-nums text-faint">
            {pct(synthesis.confidence)} / {pct(synthesis.threshold)} · {synthesis.corroboratingAgents} of{' '}
            {synthesis.requiredCorroboration} agents
          </span>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted">{synthesis.silenceReason}</p>
        <p className="mt-2 text-[10.5px] leading-relaxed text-faint">
          Silence is the designed behaviour below the gates, not a failure. The full reasoning is still shown below so
          you can see what was considered.
        </p>
      </section>
    );
  }

  const observation = synthesis.observation!;
  return (
    <section className="rounded-lg border border-accent/40 bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[12.5px] font-semibold text-text">{observation.status}</h2>
        <span className="text-[10.5px] tabular-nums text-faint">
          {pct(observation.confidence)} · {synthesis.corroboratingAgents} agents corroborating
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-text">{observation.content}</p>

      {observation.citations.length > 0 && <Citations citations={observation.citations} />}

      {synthesis.conflicts.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-medium text-muted">
            {synthesis.conflicts.length} conflict{synthesis.conflicts.length === 1 ? '' : 's'} resolved
          </summary>
          <ul className="mt-1.5 space-y-1.5">
            {synthesis.conflicts.map((conflict, i) => (
              <li key={i} className="text-[10.5px] leading-relaxed text-muted">
                <span className="font-medium text-text">{conflict.kind.replace(/-/g, ' ')}</span> — {conflict.detail}{' '}
                <span className="text-faint">{conflict.resolution}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-3 border-t border-border pt-2 text-[10px] leading-relaxed text-faint">
        {observation.disclaimer}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------

function RuleMatches({ matches }: { matches: WorkspacePayload['ruleMatches'] }) {
  if (matches.length === 0) return null;

  return (
    <section className="rounded-lg border border-border bg-surface p-3">
      <h3 className="text-[11.5px] font-semibold text-text">Your learned strategies</h3>
      <ul className="mt-2 space-y-2">
        {matches.map((match) => (
          <li key={match.id}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium text-text">{match.name}</span>
              <span
                className={`text-[10px] tabular-nums ${match.matched ? 'text-green-500' : 'text-faint'}`}
              >
                {match.matched ? 'confirmed' : `${Math.round(match.score * 100)}% of rules`}
              </span>
            </div>
            {/* Unmet rules are shown as prominently as met ones. A setup at
                "4 of 7" is not a setup, and hiding the 3 would make it look
                like one. */}
            <ul className="mt-1 space-y-0.5">
              {match.met.map((note, i) => (
                <li key={`m${i}`} className="text-[10.5px] leading-relaxed text-muted">
                  <span className="text-green-500">✓</span> {note}
                </li>
              ))}
              {match.unmet.map((note, i) => (
                <li key={`u${i}`} className="text-[10.5px] leading-relaxed text-faint">
                  <span>✗</span> {note}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

function AnnotationList({
  annotations,
  focusedId,
  onFocus,
}: {
  annotations: ChartAnnotation[];
  focusedId: string | null;
  onFocus: (id: string | null) => void;
}) {
  if (annotations.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-surface p-3">
        <h3 className="text-[11.5px] font-semibold text-text">Annotations</h3>
        <p className="mt-1.5 text-[11px] text-muted">
          No structure met the threshold to be drawn on this series.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-3">
      <h3 className="text-[11.5px] font-semibold text-text">
        {annotations.length} annotation{annotations.length === 1 ? '' : 's'} — why each was drawn
      </h3>
      <ul className="mt-2 space-y-1.5">
        {annotations.map((annotation) => (
          <li
            key={annotation.id}
            onMouseEnter={() => onFocus(annotation.id)}
            onMouseLeave={() => onFocus(null)}
            className={`rounded border p-2 transition-colors ${
              focusedId === annotation.id ? 'border-accent/50 bg-accent/5' : 'border-border'
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-text">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: annotation.style.color }}
                />
                {annotation.label}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-faint">
                {Math.round(annotation.confidence * 100)}%
              </span>
            </div>

            <p className="mt-1 text-[10.5px] leading-relaxed text-muted">{annotation.explanation}</p>

            <p className="mt-1 text-[10px] leading-relaxed text-faint">
              <span
                className={
                  annotation.triggeredBy.origin === 'user-tradingview' ? 'font-medium text-accent' : 'font-medium'
                }
              >
                {annotation.triggeredBy.ruleName}
                {annotation.triggeredBy.origin === 'user-tradingview' && ' (your rule)'}
              </span>
              {' — '}
              {annotation.triggeredBy.conditionMet}
            </p>

            {annotation.levels.length > 0 && (
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                {annotation.levels.map((level, i) => (
                  <li key={i} className="text-[10px] tabular-nums text-muted">
                    <span className="text-faint">{level.role.replace(/-/g, ' ')}</span> {level.price.toFixed(1)}
                    {level.rMultiple !== null && <span className="text-faint"> ({level.rMultiple}R)</span>}
                  </li>
                ))}
              </ul>
            )}

            {annotation.citations.length > 0 && <Citations citations={annotation.citations} compact />}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

function AgentVerdicts({ run }: { run: ReasoningRun }) {
  const [open, setOpen] = useState(false);
  const answered = run.verdicts.filter((v) => !v.abstained);
  const abstained = run.verdicts.filter((v) => v.abstained);

  return (
    <section className="rounded-lg border border-border bg-surface p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline justify-between gap-2 text-left"
      >
        <h3 className="text-[11.5px] font-semibold text-text">
          {answered.length} agent{answered.length === 1 ? '' : 's'} answered
          {abstained.length > 0 && <span className="text-faint">, {abstained.length} abstained</span>}
        </h3>
        <span className="text-[10px] text-faint">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {answered.map((verdict) => (
            <div key={verdict.subtaskId} className="rounded border border-border p-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium text-text">{AGENT_LABELS[verdict.agent]}</span>
                <span className="text-[10px] tabular-nums text-faint">
                  {STANCE_LABELS[verdict.stance]} · {Math.round(verdict.confidence * 100)}%
                </span>
              </div>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted">{verdict.headline}</p>
              <ul className="mt-1 space-y-0.5">
                {verdict.evidence.slice(0, 4).map((item, i) => (
                  <li key={i} className="text-[10px] leading-relaxed text-faint">
                    <span className="uppercase tracking-wide">{item.kind}</span> · {item.statement}
                  </li>
                ))}
              </ul>
              {verdict.citations.length > 0 && <Citations citations={verdict.citations} compact />}
            </div>
          ))}

          {/* Abstentions are shown, not hidden: "no data" must never be
              mistaken for "nothing wrong found". */}
          {abstained.map((verdict) => (
            <div key={verdict.subtaskId} className="rounded border border-dashed border-border p-2">
              <span className="text-[11px] font-medium text-faint">{AGENT_LABELS[verdict.agent]} — abstained</span>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-faint">{verdict.abstentionReason}</p>
            </div>
          ))}

          {run.plan.skipped.map((skip) => (
            <div key={skip.agent} className="rounded border border-dashed border-border p-2">
              <span className="text-[11px] font-medium text-faint">{AGENT_LABELS[skip.agent]} — not run</span>
              <p className="mt-0.5 text-[10.5px] leading-relaxed text-faint">{skip.reason}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

/**
 * Citations back into the learned corpus.
 *
 * Shows the verbatim quote and a resolvable locator (section or page plus a
 * byte range) — the point of a citation is that a reader can go and check it,
 * which a bare source name does not allow.
 */
function Citations({ citations, compact = false }: { citations: KnowledgeCitation[]; compact?: boolean }) {
  return (
    <details className={compact ? 'mt-1' : 'mt-3'}>
      <summary className="cursor-pointer text-[10px] text-faint">
        {citations.length} citation{citations.length === 1 ? '' : 's'} ·{' '}
        {new Set(citations.map((c) => c.sourceId)).size} source
        {new Set(citations.map((c) => c.sourceId)).size === 1 ? '' : 's'}
      </summary>
      <ul className="mt-1 space-y-1.5">
        {citations.map((citation) => (
          <li key={citation.chunkId} className="border-l-2 border-border pl-2">
            <p className="text-[10px] font-medium text-muted">
              {citation.sourceTitle}
              <span className="text-faint"> — {citation.locator}</span>
              {citation.sourceKind === 'user-rule' && <span className="ml-1 text-accent">your rule</span>}
            </p>
            <p className="mt-0.5 text-[10px] italic leading-relaxed text-faint">“{citation.quote}”</p>
            <p className="mt-0.5 text-[9px] text-faint">
              {citation.sourcePath} @ {citation.charStart}–{citation.charEnd}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}
