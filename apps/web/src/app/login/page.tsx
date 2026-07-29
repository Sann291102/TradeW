'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, Button, Badge } from '@tradew/ui';
import { api, setSession } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';

function friendlyError(message: string): string {
  if (/fetch|network|load failed/i.test(message)) {
    return "Couldn't reach the TradeW server. Check that the API is running and NEXT_PUBLIC_API_URL is set correctly.";
  }
  return message || 'Something went wrong. Please try again.';
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      setSession(res.accessToken, res.refreshToken);
      // AppFrame's session init only runs once on mount, which already happened
      // before this token existed — re-init explicitly so Sidebar/TopBar show
      // the real identity immediately instead of waiting for the next mount.
      await useSessionStore.getState().init();
      router.push('/dashboard');
    } catch (err: any) {
      setError(friendlyError(err?.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md p-8">
        <Badge tone="brand" className="mb-1">TradeW · AI Trading OS</Badge>
        <h1 className="mt-2 text-3xl font-bold">Log in</h1>
        <form onSubmit={submit} className="mt-6 space-y-3">
          <label className="block text-sm">
            <span className="text-faint">Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          </label>
          <label className="block text-sm">
            <span className="text-faint">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          </label>
          {error && (
            <p className="rounded-lg border border-amber/40 bg-amber-bg px-3 py-2 text-xs text-amber">{error}</p>
          )}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Signing in…' : 'Log in'}
          </Button>
        </form>
        <div className="mt-4 flex items-center justify-between text-sm">
          <Link className="text-teal hover:underline" href="/signup">
            Need an account?
          </Link>
          <Link className="text-muted hover:text-text" href="/reset">
            Forgot password?
          </Link>
        </div>
      </Card>
    </main>
  );
}
