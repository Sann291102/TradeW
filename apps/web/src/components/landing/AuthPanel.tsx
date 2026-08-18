'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { API_URL, api, setSession } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';
import { CandleLoader } from '@tradew/ui';

/**
 * Sign-in / sign-up, embedded in the landing page.
 *
 * This replaced the standalone /login and /signup routes. Those paths now
 * redirect here, so bookmarks and any links already in the wild still land
 * somewhere useful rather than 404ing.
 *
 * Which tabs appear is decided by the SERVER, not by this file: `/auth/methods`
 * reports whether Google and SMS credentials are actually configured on the
 * deployment. A tab whose backend is missing renders an explanation instead of
 * a button that would 503 — the same reason the marketing copy on this page
 * does not claim certifications the platform does not hold.
 */

type Tab = 'email' | 'google' | 'phone';
type Methods = { password: boolean; google: boolean; phone: boolean };

function friendlyError(message: string): string {
  if (/fetch|network|load failed/i.test(message)) {
    return "Couldn't reach the TradeW server. Check that the API is running and NEXT_PUBLIC_API_URL is set correctly.";
  }
  return message || 'Something went wrong. Please try again.';
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'email', label: 'Email' },
  { id: 'google', label: 'Google' },
  { id: 'phone', label: 'Phone' },
];

const inputClass =
  'mt-1.5 w-full rounded-xl border border-border2 bg-bg px-3.5 py-2.5 text-fsXs text-text placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

export function AuthPanel() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('email');
  const [methods, setMethods] = useState<Methods | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Email tab
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Phone tab
  const [phone, setPhone] = useState('+91');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Unauthenticated GET — `api()` is fine, it simply sends no bearer token.
    api('/auth/methods')
      .then((m: Methods) => !cancelled && setMethods(m))
      // A failure here means the API is down. Leave `methods` null; the tabs
      // stay enabled and the real error surfaces when the user submits, which
      // is more useful than greying everything out with no explanation.
      .catch(() => !cancelled && setMethods(null));
    return () => {
      cancelled = true;
    };
  }, []);

  // Surface the reason a Google round-trip bounced (the callback redirects
  // back here with ?auth_error=…), then strip it so a refresh does not replay
  // a stale message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('auth_error');
    if (!authError) return;
    setError(authError);
    setTab('google');
    params.delete('auth_error');
    const qs = params.toString();
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
    );
  }, []);

  /**
   * Where to land after a successful sign-in.
   *
   * The middleware puts the blocked destination in `?next=`, so someone who
   * deep-linked to /sentinel gets there instead of the dashboard. Untrusted
   * input: only a same-origin absolute path is honoured. `//evil.com` is a
   * protocol-relative URL that a naive "starts with /" check would accept and
   * the browser would treat as another origin, so it is rejected explicitly.
   */
  function destination(): string {
    const next = new URLSearchParams(window.location.search).get('next');
    if (!next || !next.startsWith('/') || next.startsWith('//')) return '/dashboard';
    return next;
  }

  async function enter(accessToken: string, refreshToken?: string) {
    setSession(accessToken, refreshToken);
    // AppFrame's session init already ran on mount, before this token existed.
    // Re-init explicitly so the shell shows the real identity immediately.
    await useSessionStore.getState().init();
    router.push(destination());
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api(`/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      await enter(res.accessToken, res.refreshToken);
    } catch (err: any) {
      setError(friendlyError(err?.message));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api('/auth/phone/request', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      });
      setCodeSent(true);
      // Present only when SMS is unconfigured, so local testing works without
      // a Twilio account. With a provider configured this is always absent.
      setDevCode(res.devCode ?? null);
    } catch (err: any) {
      setError(friendlyError(err?.message));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api('/auth/phone/verify', {
        method: 'POST',
        body: JSON.stringify({ phone, code }),
      });
      await enter(res.accessToken, res.refreshToken);
    } catch (err: any) {
      setError(friendlyError(err?.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass mx-auto w-full max-w-md rounded-3xl border border-glassBorder p-7 shadow-elev2 sm:p-8">
      <div
        role="tablist"
        aria-label="Sign-in method"
        className="grid grid-cols-3 gap-1 rounded-xl border border-border p-1"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              setError('');
            }}
            className={`rounded-lg px-3 py-2 text-fs2xs font-medium transition-colors ${
              tab === t.id ? 'bg-teal text-bg' : 'text-muted hover:bg-hover hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-5 rounded-xl border border-amber/40 bg-amber-bg px-3.5 py-2.5 text-fs2xs text-amber"
        >
          {error}
        </p>
      )}

      {/* ------------------------------------------------------------- Email */}
      {tab === 'email' && (
        <form onSubmit={submitEmail} className="mt-5 space-y-4">
          <label className="block text-fs2xs">
            <span className="text-faint">Email address</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@firm.com"
              className={inputClass}
            />
          </label>

          <label className="block text-fs2xs">
            <span className="text-faint">Password</span>
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
              className={inputClass}
            />
          </label>

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-teal px-4 py-3 text-fsXs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy && <CandleLoader size="sm" decorative />}
            {busy
              ? mode === 'signup'
                ? 'Creating account…'
                : 'Signing in…'
              : mode === 'signup'
                ? 'Create account'
                : 'Sign in'}
          </button>

          <div className="flex items-center justify-between text-fs2xs">
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'signup' : 'login');
                setError('');
              }}
              className="text-teal hover:underline"
            >
              {mode === 'login' ? 'Need an account?' : 'Already have an account?'}
            </button>
            <Link href="/reset" className="text-muted hover:text-text">
              Forgot password?
            </Link>
          </div>
        </form>
      )}

      {/* ------------------------------------------------------------ Google */}
      {tab === 'google' && (
        <div className="mt-5">
          {methods && !methods.google ? (
            <p className="rounded-xl border border-border bg-card px-4 py-5 text-fs2xs leading-normal2 text-muted">
              Google sign-in is not configured on this server. Set{' '}
              <code className="text-teal">GOOGLE_CLIENT_ID</code> and{' '}
              <code className="text-teal">GOOGLE_CLIENT_SECRET</code> to enable it, or use email
              or phone.
            </p>
          ) : (
            <>
              {/* A full-page navigation, not fetch: the OAuth consent screen has
                  to own the tab, and the callback comes back as a top-level
                  redirect that XHR could never receive. */}
              <a
                href={`${API_URL}/auth/google`}
                className="flex w-full items-center justify-center gap-3 rounded-xl border border-border2 px-4 py-3 text-fsXs font-semibold text-text transition-colors hover:bg-hover"
              >
                <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M12 10.2v3.9h5.5c-.24 1.4-1.7 4.1-5.5 4.1a6.2 6.2 0 1 1 0-12.4c1.8 0 3 .8 3.7 1.4l2.5-2.4A9.6 9.6 0 0 0 12 2a10 10 0 1 0 0 20c5.8 0 9.6-4 9.6-9.8 0-.7-.1-1.2-.2-1.7H12Z"
                  />
                </svg>
                Continue with Google
              </a>
              <p className="mt-4 text-center text-fs2xs text-faint">
                We never post on your behalf or read your inbox.
              </p>
            </>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- Phone */}
      {tab === 'phone' && (
        <div className="mt-5">
          {!codeSent ? (
            <form onSubmit={sendCode} className="space-y-4">
              <label className="block text-fs2xs">
                <span className="text-faint">Mobile number</span>
                <input
                  inputMode="tel"
                  required
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ''))}
                  placeholder="+919876543210"
                  className={inputClass}
                />
                <span className="mt-1.5 block text-faint">
                  E.164 format, including country code.
                </span>
              </label>
              <button
                type="submit"
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-teal px-4 py-3 text-fsXs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy && <CandleLoader size="sm" decorative />}
                {busy ? 'Sending…' : 'Send code'}
              </button>
              {methods && !methods.phone && (
                <p className="text-fs2xs leading-normal2 text-faint">
                  SMS is not configured on this server, so the code will be shown here instead
                  of texted.
                </p>
              )}
            </form>
          ) : (
            <form onSubmit={verifyCode} className="space-y-4">
              <label className="block text-fs2xs">
                <span className="text-faint">Code sent to {phone}</span>
                <input
                  inputMode="numeric"
                  required
                  pattern="\d{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="6-digit code"
                  className={`${inputClass} text-center font-mono tracking-[0.4em]`}
                />
              </label>

              {devCode && (
                <p className="rounded-xl border border-border bg-card px-3.5 py-2.5 text-fs2xs text-muted">
                  SMS is unconfigured, so here is the code:{' '}
                  <span className="font-mono text-teal">{devCode}</span>
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-teal px-4 py-3 text-fsXs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy && <CandleLoader size="sm" decorative />}
                {busy ? 'Verifying…' : 'Verify and continue'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCodeSent(false);
                  setCode('');
                  setDevCode(null);
                  setError('');
                }}
                className="w-full text-center text-fs2xs text-muted hover:text-text"
              >
                Use a different number
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
