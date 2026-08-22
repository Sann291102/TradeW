'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Card, CandleLoader, buttonClasses, cn } from '@tradew/ui';
import { api, getRefreshToken } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';
import { initials } from '@/lib/format';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingRow, Select, TextField, SignInRequired } from '@/components/settings/controls';

/**
 * Settings → Account: identity, and the security operations that act on it.
 *
 * ── EVERY WRITE ON THIS PAGE IS REAL ───────────────────────────────────────
 *
 * · Profile      → PATCH /auth/me            (existing route)
 * · Password     → POST  /auth/password/change
 * · Sessions     → GET   /auth/sessions, POST /auth/sessions/revoke-others
 *
 * The password form in particular is the reason `POST /auth/password/change`
 * was added to services/api rather than faked here: the endpoint verifies the
 * current password with bcrypt, writes a new hash, revokes every refresh token
 * and sends the account's security email. A form that showed "Password
 * changed" without doing that would be the single most harmful thing this
 * screen could contain.
 *
 * Two-factor authentication is NOT offered. The app has phone OTP as a way to
 * sign IN, but nothing that requires a second factor on top of a password, no
 * enrolment state on the user, and no recovery codes. A toggle here would be a
 * claim about the account's security that is not true, so the card says what
 * exists and what does not instead.
 */
interface SessionRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export function AccountSection() {
  const status = useSessionStore((s) => s.status);
  const user = useSessionStore((s) => s.user);
  const initSession = useSessionStore((s) => s.init);
  const signedIn = status === 'authenticated';

  // ---- profile ------------------------------------------------------------
  const [experienceLevel, setExperienceLevel] = useState('beginner');
  const [optionsFamiliarity, setOptionsFamiliarity] = useState('new');
  const [profileState, setProfileState] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    if (!user) return;
    setExperienceLevel(user.experienceLevel || 'beginner');
    setOptionsFamiliarity(user.optionsFamiliarity || 'new');
  }, [user]);

  async function saveProfile() {
    setSavingProfile(true);
    setProfileState(null);
    try {
      await api('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({ experienceLevel, optionsFamiliarity }),
      });
      // Re-read the session so every other surface sees the new values rather
      // than this page holding a private, newer copy.
      await initSession();
      setProfileState({ ok: true, text: 'Profile saved to your account.' });
    } catch (err) {
      setProfileState({ ok: false, text: err instanceof Error ? err.message : 'Could not save your profile.' });
    } finally {
      setSavingProfile(false);
    }
  }

  // ---- password -----------------------------------------------------------
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordState, setPasswordState] = useState<{ ok: boolean; text: string } | null>(null);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordState(null);
    if (newPassword.length < 6) {
      setPasswordState({ ok: false, text: 'Your new password must be at least 6 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordState({ ok: false, text: 'The two new-password fields do not match.' });
      return;
    }
    setChangingPassword(true);
    try {
      await api('/auth/password/change', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordState({
        ok: true,
        // Say what actually happened server-side, including the consequence
        // the user will notice on their other devices.
        text: 'Password changed. Every other session has been signed out and a confirmation email has been sent.',
      });
      void loadSessions();
    } catch (err) {
      setPasswordState({
        ok: false,
        text: err instanceof Error ? err.message : 'Could not change your password.',
      });
    } finally {
      setChangingPassword(false);
    }
  }

  // ---- sessions -----------------------------------------------------------
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const loadSessions = useCallback(async () => {
    setSessionsError(null);
    try {
      // The refresh token is sent so the server can flag which row is this
      // browser. It is a credential this tab already holds; it grants nothing
      // it did not already have.
      const refreshToken = getRefreshToken();
      const query = refreshToken ? `?refreshToken=${encodeURIComponent(refreshToken)}` : '';
      const res = (await api(`/auth/sessions${query}`)) as { sessions: SessionRow[] };
      setSessions(res.sessions);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : 'Could not load your sessions.');
    }
  }, []);

  useEffect(() => {
    if (signedIn) void loadSessions();
  }, [signedIn, loadSessions]);

  async function revokeOthers() {
    setRevoking(true);
    setSessionsError(null);
    try {
      await api('/auth/sessions/revoke-others', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: getRefreshToken() }),
      });
      await loadSessions();
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : 'Could not sign the other sessions out.');
    } finally {
      setRevoking(false);
    }
  }

  if (!signedIn) {
    return (
      <SettingsSection title="Account" description="Your profile and the security of your TradeW account.">
        <SignInRequired what="manage your account" />
      </SettingsSection>
    );
  }

  const otherSessions = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <SettingsSection title="Account" description="Your profile and the security of your TradeW account.">
      <Card title="Profile">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-teal text-sm font-bold text-white">
            {user ? initials(user.email) : '??'}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-text">{user?.email}</div>
            <div className="text-[11px] text-faint">
              Joined{' '}
              {user?.createdAt
                ? new Date(user.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })
                : '—'}
            </div>
          </div>
        </div>

        <SettingRow
          label="Email address"
          hint="Your sign-in identity. Changing it is not supported — there is no route to change an email, and offering a field that silently did nothing would be worse than saying so."
          control={<span className="block truncate text-sm text-muted">{user?.email}</span>}
        />
        <SettingRow
          label="Profile photo"
          hint="TradeW does not store avatars. Your initials are derived from your email address."
          unavailable="No avatar storage exists — there is no upload endpoint and no field on the account."
          control={
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-teal text-xs font-bold text-white">
              {user ? initials(user.email) : '??'}
            </span>
          }
        />
        <SettingRow
          label="Experience level"
          htmlFor="experience-level"
          hint="Used to pitch explanations and learning material at the right level."
          control={
            <Select
              id="experience-level"
              label="Experience level"
              value={experienceLevel}
              onChange={setExperienceLevel}
              options={[
                { value: 'beginner', label: 'Beginner' },
                { value: 'intermediate', label: 'Intermediate' },
                { value: 'advanced', label: 'Advanced' },
              ]}
            />
          }
        />
        <SettingRow
          label="Options familiarity"
          htmlFor="options-familiarity"
          hint="How much the option-chain and contract surfaces explain as they go."
          control={
            <Select
              id="options-familiarity"
              label="Options familiarity"
              value={optionsFamiliarity}
              onChange={setOptionsFamiliarity}
              options={[
                { value: 'new', label: 'New to options' },
                { value: 'basic', label: 'Basic concepts' },
                { value: 'active', label: 'Actively practising' },
              ]}
            />
          }
        />
        <SettingRow
          label="Account type"
          hint="Every TradeW account is a paper-trading account. Orders are matched by a simulated engine and never routed to an exchange."
          control={
            <Badge tone="warning" className="px-1.5 py-0 text-[9px]">
              PAPER
            </Badge>
          }
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={savingProfile}
            onClick={() => void saveProfile()}
            className={buttonClasses({ variant: 'primary', size: 'sm' })}
          >
            {savingProfile ? 'Saving…' : 'Save profile'}
          </button>
          {profileState && (
            <span className={cn('text-[11px] font-semibold', profileState.ok ? 'text-up' : 'text-down')}>
              {profileState.text}
            </span>
          )}
        </div>
      </Card>

      {/* ── Password ─────────────────────────────────────────────────────── */}
      <Card id="password" title="Change password" subtitle="· signs out every other device">
        <form onSubmit={changePassword} className="max-w-md space-y-3">
          <div>
            <label htmlFor="current-password" className="text-xs font-semibold text-faint">
              Current password
            </label>
            <div className="mt-1">
              <TextField
                id="current-password"
                label="Current password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={setCurrentPassword}
              />
            </div>
          </div>
          <div>
            <label htmlFor="new-password" className="text-xs font-semibold text-faint">
              New password
            </label>
            <div className="mt-1">
              <TextField
                id="new-password"
                label="New password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={setNewPassword}
              />
            </div>
          </div>
          <div>
            <label htmlFor="confirm-password" className="text-xs font-semibold text-faint">
              Confirm new password
            </label>
            <div className="mt-1">
              <TextField
                id="confirm-password"
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={setConfirmPassword}
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={changingPassword || !currentPassword || !newPassword}
            className={buttonClasses({ variant: 'primary', size: 'sm' })}
          >
            {changingPassword ? 'Changing…' : 'Change password'}
          </button>
          {passwordState && (
            <p className={cn('text-xs font-semibold', passwordState.ok ? 'text-up' : 'text-down')}>
              {passwordState.text}
            </p>
          )}
        </form>
        <p className="mt-3 text-[11px] text-faint">
          Signed in with Google or a phone code and have no password?{' '}
          <Link href="/reset" className="text-teal hover:underline">
            Set one through the reset flow
          </Link>
          .
        </p>
      </Card>

      {/* ── Two-factor ───────────────────────────────────────────────────── */}
      <Card title="Two-factor authentication">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" className="px-1.5 py-0 text-[9px]">NOT AVAILABLE</Badge>
          <span className="text-sm font-semibold text-text">No second factor is enforced on TradeW accounts.</span>
        </div>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          TradeW can send a one-time code to a verified phone, but only as a way to sign IN on its
          own — not as a second step after a password. There is no enrolment state on the account,
          no authenticator-app support and no recovery codes, so there is nothing here to switch on.
          This card exists so the gap is visible rather than being discovered later.
        </p>
      </Card>

      {/* ── Sessions ─────────────────────────────────────────────────────── */}
      <Card
        id="sessions"
        title="Active sessions"
        subtitle={sessions ? `· ${sessions.length} live` : undefined}
        actions={
          otherSessions > 0 ? (
            <button
              type="button"
              disabled={revoking}
              onClick={() => void revokeOthers()}
              className={buttonClasses({ variant: 'outline', size: 'sm' })}
            >
              {revoking ? 'Signing out…' : `Sign out ${otherSessions} other session${otherSessions === 1 ? '' : 's'}`}
            </button>
          ) : undefined
        }
      >
        {sessionsError ? (
          <p className="text-xs font-semibold text-down">{sessionsError}</p>
        ) : sessions === null ? (
          <div className="flex justify-center py-4">
            <CandleLoader size="sm" label="Loading your sessions" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-muted">No live sessions were returned for this account.</p>
        ) : (
          <ul className="divide-y divide-border">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text">
                    Signed in {new Date(s.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                  </div>
                  <div className="text-[11px] text-faint">
                    Valid until {new Date(s.expiresAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
                  </div>
                </div>
                {s.current && (
                  <Badge tone="positive" className="px-1.5 py-0 text-[9px]">
                    THIS DEVICE
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-faint">
          A session is a sign-in that is still valid. TradeW does not record the device or location
          a session was created from — those columns do not exist — so no row here claims to name a
          device. Signing the others out revokes their refresh tokens immediately.
        </p>
      </Card>
    </SettingsSection>
  );
}
