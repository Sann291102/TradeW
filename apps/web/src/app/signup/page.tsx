'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, Button, Badge } from '@tradew/ui';
import { api, setSession } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';

function friendlyError(message: string): string {
  if (/fetch|network|load failed/i.test(message)) {
    return "Couldn't reach the TradeW server. Check that the API is running and NEXT_PUBLIC_API_URL is set correctly — you can still explore the workspace without an account.";
  }
  return message || 'Something went wrong. Please try again.';
}

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('founder@tradew.local');
  const [password, setPassword] = useState('password123');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
      setSession(res.accessToken, res.refreshToken);
      // See login/page.tsx — AppFrame's session init already ran (with no
      // token) before this signup completed, so it needs an explicit re-init.
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
        <h1 className="mt-2 text-3xl font-bold">Create account</h1>
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
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          </label>
          {error && (
            <p className="rounded-lg border border-amber/40 bg-amber-bg px-3 py-2 text-xs text-amber">{error}</p>
          )}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Creating…' : 'Sign up'}
          </Button>
        </form>
        <div className="mt-4 flex items-center justify-between text-sm">
          <Link className="text-teal hover:underline" href="/login">
            Already have an account?
          </Link>
          <Link className="text-muted hover:text-text" href="/dashboard">
            Explore without an account →
          </Link>
        </div>
      </Card>
    </main>
  );
}
