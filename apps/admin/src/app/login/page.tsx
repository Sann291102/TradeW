'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get('from') || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Credentials go to this app's OWN server-side login, never to
      // services/api directly. The browser gets back only a sealed session
      // cookie — no operator assertion, no ADMIN_API_TOKEN.
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
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
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">TradeW · Operator Console</p>
        <h1 className="mb-4 text-lg font-bold text-text">Sign in</h1>

        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[11px] text-muted">Operator email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              autoComplete="username"
              className="w-full rounded border border-border bg-bg px-3 py-2 text-[13px] text-text"
              placeholder="you@tradew.io"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] text-muted">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded border border-border bg-bg px-3 py-2 text-[13px] text-text"
              placeholder="••••••••••••"
            />
          </label>

          {error && <p className="text-[11.5px] text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting || email.length === 0 || password.length === 0}
            className="w-full rounded bg-teal px-3 py-2 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-[10.5px] leading-relaxed text-faint">
          Sign in with your operator account. Credentials are verified server-side against services/api, which also
          requires the deployment&rsquo;s <code className="rounded bg-bg px-1">ADMIN_API_TOKEN</code> as a second
          factor. The browser only ever receives a sealed session cookie &mdash; never your assertion or the token.
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
