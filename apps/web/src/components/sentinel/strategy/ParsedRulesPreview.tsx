'use client';

import { Badge, cn } from '@tradew/ui';
import type { ParsedStrategy } from '@/lib/sentinel/strategyApi';
import { isWatchable, ruleCounts } from '@/lib/sentinel/watchModel';

/**
 * What Sentinel understood from the user's text — the confirmation step.
 *
 * Shown BEFORE anything is saved. The parser is deterministic (regex and
 * keywords, no model), so this preview is exactly what will be watched: every
 * mandatory condition here must be met for the watch to reach CONFIRMED, and
 * nothing that is not here is ever watched for.
 *
 * Warnings are rendered as prominently as the rules. A strategy the parser
 * found nothing in is still saveable — the raw text is kept — but it would sit
 * at IDLE forever, and the user learns that here rather than by waiting.
 */
export function ParsedRulesPreview({ parsed, warnings }: { parsed: ParsedStrategy; warnings: string[] }) {
  const counts = ruleCounts(parsed);
  const watchable = isWatchable(parsed);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Sentinel understood</span>
        {parsed.timeframe && (
          <Badge tone="neutral" className="px-2 py-0 text-[10px]">
            {parsed.timeframe} reference
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-muted">
          {counts.mandatory} mandatory
          {counts.optional > 0 && ` · ${counts.optional} optional`}
        </span>
      </div>

      {warnings.length > 0 && (
        <ul className="space-y-1.5 rounded-lg border border-amber bg-amber-bg p-2.5">
          {warnings.map((w) => (
            <li key={w} className="text-[11.5px] leading-relaxed text-amber">
              {w}
            </li>
          ))}
        </ul>
      )}

      {counts.total === 0 ? (
        <p className="py-2 text-[12px] leading-relaxed text-muted">
          No conditions were recognised in this text. You can still save it — your words are kept exactly as written —
          but a watch on it will stay idle, because there is nothing for Sentinel to check.
        </p>
      ) : (
        <ul className="space-y-2">
          {parsed.rules.map((rule) => (
            <li key={rule.id} className="flex items-start gap-2.5">
              <Badge
                tone={rule.mandatory ? 'brand' : 'neutral'}
                className="mt-0.5 shrink-0 px-1.5 py-0 text-[9px] uppercase"
              >
                {rule.mandatory ? 'Must' : 'Optional'}
              </Badge>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold leading-snug text-text">{rule.description}</p>
                <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint">{rule.condition}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 text-[11.5px]">
        <Detail label="Long when" value={parsed.entry.long} />
        <Detail label="Short when" value={parsed.entry.short} />
        <Detail label="Levels" value={parsed.levels.length > 0 ? parsed.levels.join(', ') : null} />
        <Detail
          label="Invalidation"
          value={parsed.riskManagement.stopLoss}
          hint="The level your own words placed the idea's invalidation at."
        />
        <Detail
          label="Projections"
          value={parsed.riskManagement.targets.length > 0 ? parsed.riskManagement.targets.join(' · ') : null}
        />
      </dl>

      {!watchable && counts.total > 0 && (
        <p className="text-[11px] leading-relaxed text-amber">
          Every condition found is optional, so this strategy has nothing that must be true — a watch on it will not
          confirm.
        </p>
      )}
    </div>
  );
}

function Detail({ label, value, hint }: { label: string; value?: string | null; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-faint" title={hint}>
        {label}
      </dt>
      <dd className={cn('mt-0.5 truncate font-mono text-[11px]', value ? 'text-text' : 'text-faint')}>
        {value || 'not specified'}
      </dd>
    </div>
  );
}
