'use client';

import { useState } from 'react';
import { Button } from '@tradew/ui';
import { ApiError } from '@/lib/api';
import { parseStrategyText, type ParsedStrategy, type UserStrategy } from '@/lib/sentinel/strategyApi';
import { suggestStrategyName } from '@/lib/sentinel/watchModel';
import { ParsedRulesPreview } from './ParsedRulesPreview';

/**
 * Write a strategy in your own words, see what Sentinel understood, then save.
 *
 * Three steps, deliberately separate:
 *   1. the user's text, exactly as they wrote it
 *   2. `POST /strategies/parse` — a preview that saves NOTHING
 *   3. `POST /strategies` — persists the text AND the confirmed rules
 *
 * The parse step exists so nothing is ever watched that the user did not
 * confirm. Editing the text after a parse discards the preview rather than
 * letting a stale rule set be saved under new words — that mismatch would be
 * invisible afterwards, since only the saved rules are ever evaluated.
 */
export function StrategyComposer({
  onSave,
  onSaved,
}: {
  onSave: (input: { name: string; rawInput: string; rules: ParsedStrategy }) => Promise<UserStrategy>;
  onSaved?: (strategy: UserStrategy) => void;
}) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [preview, setPreview] = useState<{ parsed: ParsedStrategy; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState<'parsing' | 'saving' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveName = nameTouched ? name : suggestStrategyName(text);

  const handleTextChange = (next: string) => {
    setText(next);
    // The preview belongs to the text it was parsed from.
    if (preview) setPreview(null);
    setError(null);
  };

  const handleParse = async () => {
    if (!text.trim()) return;
    setBusy('parsing');
    setError(null);
    try {
      const result = await parseStrategyText(text);
      setPreview({ parsed: result.parsed, warnings: result.warnings });
    } catch (err) {
      setError(describe(err, 'Sentinel could not read that strategy right now.'));
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    if (!preview) return;
    const finalName = effectiveName.trim();
    if (!finalName) {
      setError('Give this strategy a name so you can recognise it later.');
      return;
    }
    setBusy('saving');
    setError(null);
    try {
      const saved = await onSave({ name: finalName, rawInput: text, rules: preview.parsed });
      // Only cleared once the server has confirmed the write — a failed save
      // must never cost the user the text they wrote.
      setText('');
      setName('');
      setNameTouched(false);
      setPreview(null);
      onSaved?.(saved);
    } catch (err) {
      setError(describe(err, 'The strategy could not be saved.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="strategy-text" className="text-[11px] font-semibold uppercase tracking-wide text-faint">
          Describe your strategy
        </label>
        <textarea
          id="strategy-text"
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          rows={3}
          placeholder="e.g. First 15 min high low breakout with retest, SL at low, target 1:3"
          className="mt-1.5 w-full resize-y rounded-xl border border-border bg-bg px-3 py-2.5 text-[13px] leading-relaxed text-text placeholder:text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
        <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
          Plain English. Sentinel reads it with a fixed set of rules — no model, no guessing — and shows you exactly
          what it understood before anything is saved.
        </p>
      </div>

      {!preview ? (
        <Button size="sm" onClick={handleParse} disabled={!text.trim() || busy !== null}>
          {busy === 'parsing' ? 'Reading…' : 'Parse'}
        </Button>
      ) : (
        <>
          <ParsedRulesPreview parsed={preview.parsed} warnings={preview.warnings} />

          <div>
            <label htmlFor="strategy-name" className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              Name
            </label>
            <input
              id="strategy-name"
              value={effectiveName}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
              maxLength={80}
              className="mt-1.5 w-full rounded-xl border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              placeholder="Name this strategy"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={handleSave} disabled={busy !== null}>
              {busy === 'saving' ? 'Saving…' : 'Confirm & save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)} disabled={busy !== null}>
              Edit the text
            </Button>
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-down bg-down-bg px-3 py-2 text-[11.5px] text-down">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The server's own message when it sent one — "Sentinel strategy service is
 * not reachable" and "you are not entitled" are different problems, and a
 * single generic string would hide which one the user hit.
 */
function describe(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session has expired. Sign in again to save this strategy.';
    if (err.status === 403) return 'This account does not have Sentinel Pro active.';
    return err.message || fallback;
  }
  return `${fallback} The TradeW API could not be reached.`;
}
