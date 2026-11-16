'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Card, CandleLoader, buttonClasses } from '@tradew/ui';
import { ApiError, api, getToken } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';

type State =
  | { kind: 'verifying' }
  | { kind: 'verified' }
  | { kind: 'already' }
  | { kind: 'expired' }
  | { kind: 'invalid'; message: string }
  | { kind: 'pending' };

/**
 * `/verify-email`. Public on purpose: the link is often opened on a different
 * device or browser from the one that registered, with no session.
 *
 *  · `?token=` → redeem it. Verified, already verified, expired and invalid
 *    each get their own clear message; expired and invalid offer a resend.
 *  · `?sent=1` → the "check your inbox" step right after registration. The
 *    address (and, only when the server has no mail provider, the dev link)
 *    is handed over in sessionStorage, never in the URL.
 */
function readPending(): { email: string; devVerifyUrl: string | null } {
  if (typeof window === 'undefined') return { email: '', devVerifyUrl: null };
  try {
    const raw = sessionStorage.getItem('tw_verify_pending');
    const v = raw ? (JSON.parse(raw) as { email?: string; devVerifyUrl?: string | null }) : {};
    return { email: v.email ?? '', devVerifyUrl: v.devVerifyUrl ?? null };
  } catch {
    return { email: '', devVerifyUrl: null };
  }
}

export function VerifyEmailClient() {
  const params = useSearchParams();
  const token = params.get('token');
  // Read after mount: sessionStorage does not exist during server rendering,
  // and reading it in the first render would make the two disagree.
  const [{ email: initialEmail, devVerifyUrl: devUrl }, setPending] = useState<{ email: string; devVerifyUrl: string | null }>({
    email: '',
    devVerifyUrl: null,
  });
  const [state, setState] = useState<State>(token ? { kind: 'verifying' } : { kind: 'pending' });
  const [email, setEmail] = useState('');
  const [resendMsg, setResendMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [resendDev, setResendDev] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    const p = readPending();
    setPending(p);
    if (p.email) setEmail((cur) => cur || p.email);
  }, []);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true; // React strict mode runs effects twice in dev; the token is single-use.
    (async () => {
      try {
        const res = await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });
        setEmail(res.email ?? '');
        setState(res.status === 'already_verified' ? { kind: 'already' } : { kind: 'verified' });
        try {
          sessionStorage.removeItem('tw_verify_pending');
        } catch {
          /* ignore */
        }
        if (getToken()) await useSessionStore.getState().init();
      } catch (err) {
        if (err instanceof ApiError && err.status === 410) setState({ kind: 'expired' });
        else setState({ kind: 'invalid', message: err instanceof Error ? err.message : 'This link is not valid.' });
      }
    })();
  }, [token]);

  async function resend(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResendMsg(null);
    try {
      const res = await api('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
      setResendDev(res.devVerifyUrl ?? null);
      setResendMsg({ ok: true, text: 'If that address has an account waiting for verification, a new link is on its way. Earlier links no longer work.' });
    } catch (err) {
      setResendMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not send a new link. Try again shortly.' });
    } finally {
      setBusy(false);
    }
  }

  const resendForm = (
    <form onSubmit={resend} className="mt-5 space-y-3" aria-label="Send a new verification link">
      <label className="block text-sm">
        <span className="text-faint">Email address</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border border-border2 bg-bg px-3 py-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
      </label>
      <button type="submit" disabled={busy || !email} className={buttonClasses({ variant: 'outline', className: 'w-full' })}>
        {busy ? 'Sending…' : 'Send a new link'}
      </button>
      {resendMsg && (
        <p role="status" className={`text-xs ${resendMsg.ok ? 'text-up' : 'text-down'}`}>
          {resendMsg.text}
        </p>
      )}
      {resendDev && <DevLink url={resendDev} />}
    </form>
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <Card className="w-full max-w-md">
        <div className="p-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-teal">TradeW account</p>

          {state.kind === 'verifying' && (
            <div className="mt-4 flex items-center gap-3" role="status" aria-live="polite">
              <CandleLoader size="sm" decorative />
              <p className="text-sm text-muted">Verifying your email…</p>
            </div>
          )}

          {(state.kind === 'verified' || state.kind === 'already') && (
            <div role="status" aria-live="polite">
              <h1 className="mt-2 text-xl font-bold text-text">
                {state.kind === 'verified' ? 'Email verified' : 'Already verified'}
              </h1>
              <p className="mt-2 text-sm text-muted">
                {state.kind === 'verified'
                  ? `Thanks${email ? `, ${email} is confirmed` : ''}. Billing and the rest of your account are unlocked.`
                  : 'This address was already confirmed. Nothing else to do.'}
              </p>
              <div className="mt-5 flex gap-2">
                <Link href={getToken() ? '/dashboard' : '/#auth'} className={buttonClasses({ className: 'flex-1' })}>
                  {getToken() ? 'Go to dashboard' : 'Sign in'}
                </Link>
                {getToken() && (
                  <Link href="/settings/billing" className={buttonClasses({ variant: 'outline', className: 'flex-1' })}>
                    Billing
                  </Link>
                )}
              </div>
            </div>
          )}

          {state.kind === 'expired' && (
            <div role="alert">
              <h1 className="mt-2 text-xl font-bold text-text">This link has expired</h1>
              <p className="mt-2 text-sm text-muted">Verification links last 24 hours. Ask for a new one below.</p>
              {resendForm}
            </div>
          )}

          {state.kind === 'invalid' && (
            <div role="alert">
              <h1 className="mt-2 text-xl font-bold text-text">This link doesn&apos;t work</h1>
              <p className="mt-2 text-sm text-muted">{state.message}</p>
              {resendForm}
            </div>
          )}

          {state.kind === 'pending' && (
            <div>
              <h1 className="mt-2 text-xl font-bold text-text">Check your inbox</h1>
              <p className="mt-2 text-sm text-muted">
                We sent a verification link{initialEmail ? ` to ${initialEmail}` : ''}. Open it to confirm your address.
                Until then you can look around, but billing stays locked.
              </p>
              {devUrl && <DevLink url={devUrl} />}
              <p className="mt-5 text-xs text-faint">Didn&apos;t get it? Check spam, or send a new one.</p>
              {resendForm}
              {getToken() && (
                <Link href="/dashboard" className="mt-4 block text-center text-sm text-teal hover:underline">
                  Continue to the dashboard
                </Link>
              )}
            </div>
          )}
        </div>
      </Card>
    </main>
  );
}

/** Development only: the server returns the link when no mail provider is configured. */
function DevLink({ url }: { url: string }) {
  let href = url;
  try {
    // Keep the browser on this origin even if FRONTEND_URL differs locally.
    const u = new URL(url);
    href = `${u.pathname}${u.search}`;
  } catch {
    /* keep as given */
  }
  return (
    <p className="mt-4 rounded-lg border border-amber/40 bg-amber-bg px-3 py-2 text-xs text-amber">
      No mail provider is configured on this server, so the link was logged instead of sent.{' '}
      <a href={href} className="font-semibold underline">
        Open the verification link
      </a>
    </p>
  );
}
