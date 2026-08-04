'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get('from') || '/';

  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || 'Sign-in failed');
        return;
      }
      router.push(from);
      router.refresh();
    } catch {
      setError('Could not reach the admin server.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">TradeW · Operator Console</p>
        <h1 className="mb-4 text-lg font-bold text-text">Sign in</h1>

        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[11px] text-muted">Admin token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
              className="w-full rounded border border-border bg-bg px-3 py-2 text-[13px] text-text"
              placeholder="ADMIN_API_TOKEN"
            />
          </label>

          {error && <p className="text-[11.5px] text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting || token.length === 0}
            className="w-full rounded bg-accent px-3 py-2 text-[13px] font-semibold text-bg transition-opacity disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-[10.5px] leading-relaxed text-faint">
          This is the same shared operator credential that authorizes admin-only routes on services/api
          (<code className="rounded bg-bg px-1">ADMIN_API_TOKEN</code>). It is verified against a live endpoint on
          every sign-in and never stored in the browser.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary in the App Router; this page
  // has no meaningful loading state to show while that resolves, so an empty
  // fallback is correct rather than a spinner for a sub-millisecond gap.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
