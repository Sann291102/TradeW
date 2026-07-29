'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, Button, Badge } from '@tradew/ui';
import { api } from '@/lib/api';

/**
 * Password reset via email OTP.
 *
 * Two steps in one screen. Step 1 requests a code for the email; step 2 takes
 * the code plus a new password. The backend is enumeration-safe (identical
 * response whether or not the account exists), so this UI likewise never tells
 * the user whether the address was found — it just says "if that email exists,
 * a code is on its way." In dev the API returns a `devCode` (no SMTP), which we
 * prefill so the flow is testable without a mailbox.
 */
export default function ResetPage() {
  const router = useRouter();
  const [step, setStep] = useState<'request' | 'verify'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const res = await api('/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email }) });
      // devCode only comes back in dev (SMTP unconfigured) — prefill it so the
      // reset can be completed locally without a real inbox.
      if (res?.devCode) setCode(res.devCode);
      setNotice('If that email is registered, a 6-digit code is on its way. Enter it below.');
      setStep('verify');
    } catch (err: any) {
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/auth/password/reset', {
        method: 'POST',
        body: JSON.stringify({ email, code, newPassword }),
      });
      router.push('/login?reset=1');
    } catch (err: any) {
      setError(err?.message || 'That code is invalid or has expired.');
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    'mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2.5 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md p-8">
        <Badge tone="brand" className="mb-1">TradeW · AI Trading OS</Badge>
        <h1 className="mt-2 text-3xl font-bold">Reset password</h1>

        {step === 'request' ? (
          <form onSubmit={requestCode} className="mt-6 space-y-3">
            <label className="block text-sm">
              <span className="text-faint">Email</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
            </label>
            {error && <p className="rounded-lg border border-amber/40 bg-amber-bg px-3 py-2 text-xs text-amber">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Sending…' : 'Send reset code'}
            </Button>
          </form>
        ) : (
          <form onSubmit={submitReset} className="mt-6 space-y-3">
            {notice && <p className="rounded-lg border border-teal/40 bg-panel px-3 py-2 text-xs text-faint">{notice}</p>}
            <label className="block text-sm">
              <span className="text-faint">6-digit code</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block text-sm">
              <span className="text-faint">New password</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={inputClass}
              />
            </label>
            {error && <p className="rounded-lg border border-amber/40 bg-amber-bg px-3 py-2 text-xs text-amber">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Updating…' : 'Set new password'}
            </Button>
          </form>
        )}

        <div className="mt-4 text-sm">
          <Link className="text-teal hover:underline" href="/login">
            ← Back to log in
          </Link>
        </div>
      </Card>
    </main>
  );
}
