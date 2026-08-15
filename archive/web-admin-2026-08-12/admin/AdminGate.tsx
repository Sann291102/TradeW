'use client';

import { useState, type FormEvent } from 'react';

/**
 * What an unauthorised visitor sees.
 *
 * The copy is deliberately flat and uninformative. It does not say whether the
 * account exists, whether it lacks `isAdmin`, or whether the operator token was
 * merely wrong — all three render the same. Distinguishing them would turn this
 * screen into an oracle for probing who has admin on the platform.
 *
 * The token field is `type="password"` and `autoComplete="off"`: the operator
 * secret should not be offered to a password manager or left in a form-restore
 * cache on a shared machine.
 */
export function AdminGate({
  state,
  error,
  onSubmit,
}: {
  state: 'checking' | 'denied' | 'no-session';
  error: string | null;
  onSubmit: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    await onSubmit(token.trim());
    setBusy(false);
    setToken('');
  };

  return (
    <div className="relative z-10 flex flex-1 items-center justify-center px-6">
      <div className="admin-card w-full max-w-sm rounded-2xl border border-white/10 bg-black/40 p-7 shadow-elev3 backdrop-blur-xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="admin-core h-10 w-10">
            <span className="admin-core__band admin-core__band--a" />
            <span className="admin-core__band admin-core__band--b" />
          </div>
          <div>
            <div className="text-[14px] font-semibold">TradeW Admin</div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted">Restricted console</div>
          </div>
        </div>

        {state === 'checking' && <p className="text-[12.5px] text-muted">Verifying access…</p>}

        {state === 'no-session' && (
          <p className="text-[12.5px] leading-relaxed text-muted">
            Sign in to TradeW first, then return to this URL. The console needs both a signed-in account and an
            operator token.
          </p>
        )}

        {state === 'denied' && (
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-[11.5px] uppercase tracking-[0.12em] text-muted" htmlFor="admin-token">
              Operator token
            </label>
            <input
              id="admin-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="••••••••••••••••"
              className="w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 font-mono text-[13px] outline-none ring-focus transition-colors focus:border-teal focus:ring-1"
            />
            <button
              type="submit"
              disabled={busy || !token.trim()}
              className="w-full rounded-lg bg-teal px-3 py-2 text-[13px] font-medium text-black transition-opacity disabled:opacity-40"
            >
              {busy ? 'Checking…' : 'Unlock'}
            </button>
            {error && <p className="text-[11.5px] text-down">Access denied.</p>}
            <p className="pt-1 text-[11px] leading-relaxed text-faint">
              Held for this tab only, and cleared when it closes.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
