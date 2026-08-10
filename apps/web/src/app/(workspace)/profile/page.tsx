'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useSessionStore } from '@/lib/store/sessionStore';

/**
 * Profile page (Milestone 4, Step 1). Identity (`profile?.email` etc.) now
 * comes from the shared sessionStore's GET /auth/me call — this page no
 * longer makes its own duplicate /auth/me request (the milestone's "do NOT
 * duplicate auth logic" rule). It still owns GET/POST /auth/preferences
 * directly, since preferences are this page's own concern, not identity.
 */
export default function ProfilePage() {
  const router = useRouter();
  const sessionStatus = useSessionStore((s) => s.status);
  const sessionUser = useSessionStore((s) => s.user);
  const sessionOffline = useSessionStore((s) => s.offline);
  const initSession = useSessionStore((s) => s.init);
  const logout = useSessionStore((s) => s.logout);

  const [experienceLevel, setExperienceLevel] = useState('beginner');
  const [optionsFamiliarity, setOptionsFamiliarity] = useState('new');
  const [defaultInstrumentType, setDefaultInstrumentType] = useState('OPTION');
  const [message, setMessage] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);

  async function loadPreferences() {
    if (sessionUser) {
      setExperienceLevel(sessionUser.experienceLevel || 'beginner');
      setOptionsFamiliarity(sessionUser.optionsFamiliarity || 'new');
    }
    const prefs = await api('/auth/preferences');
    setDefaultInstrumentType(prefs.display?.defaultInstrumentType || 'OPTION');
  }

  async function saveProfile() {
    setMessage('');
    await api('/auth/me', { method: 'PATCH', body: JSON.stringify({ country: 'IN', experienceLevel, optionsFamiliarity }) });
    await api('/auth/preferences/display', { method: 'POST', body: JSON.stringify({ value: { defaultInstrumentType } }) });
    setMessage('Profile and preferences saved');
    await initSession(); // refresh the shared session so the new experienceLevel/optionsFamiliarity propagate everywhere it's read
  }

  async function handleLogout() {
    setLoggingOut(true);
    await logout();
    router.push('/dashboard'); // no login wall — logging out returns to the open workspace, not a forced /login redirect
  }

  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;
    loadPreferences().catch((err: any) => {
      setMessage(err?.message || 'Could not load preferences.');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus]);

  if (sessionStatus === 'idle' || sessionStatus === 'loading') {
    return <main className="min-h-screen p-6 max-w-3xl mx-auto"><p className="text-slate-400">Loading…</p></main>;
  }

  if (sessionStatus === 'unauthenticated') {
    return <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold">Profile & Preferences</h1>
      <div className="mt-8 bg-slate-900 border border-slate-700 rounded-2xl p-6">
        {sessionOffline ? (
          <p className="text-amber-400">Couldn&apos;t reach the TradeW server — try again in a moment.</p>
        ) : (
          <>
            <p className="text-slate-300">Sign in to manage your profile and preferences.</p>
            <a href="/login" className="mt-4 inline-block px-4 py-2 rounded bg-emerald-500 text-slate-950 font-semibold">Sign in</a>
          </>
        )}
      </div>
    </main>;
  }

  return <main className="min-h-screen p-6 max-w-3xl mx-auto">
    <header className="flex justify-between items-center">
      <div><p className="text-emerald-400 text-sm font-semibold">TradeW</p><h1 className="text-3xl font-bold">Profile & Preferences</h1></div>
      <div className="flex gap-2">
        <button onClick={() => router.push('/trade')} className="px-3 py-2 rounded bg-slate-800 border border-slate-700">Back to trade</button>
        <button onClick={handleLogout} disabled={loggingOut} className="px-3 py-2 rounded bg-slate-800 border border-slate-700 text-red-400 disabled:opacity-50">
          {loggingOut ? 'Signing out…' : 'Log out'}
        </button>
      </div>
    </header>

    <section className="mt-8 bg-slate-900 border border-slate-700 rounded-2xl p-6 space-y-5">
      <div>
        <label className="text-sm text-slate-400">Email</label>
        <div className="mt-1 p-3 rounded bg-slate-800 border border-slate-700">{sessionUser?.email}</div>
      </div>
      <div>
        <label className="text-sm text-slate-400">Experience level</label>
        <select className="mt-1 w-full p-3 rounded bg-slate-800 border border-slate-700" value={experienceLevel} onChange={(e)=>setExperienceLevel(e.target.value)}>
          <option value="beginner">Beginner</option>
          <option value="intermediate">Intermediate</option>
          <option value="advanced">Advanced</option>
        </select>
      </div>
      <div>
        <label className="text-sm text-slate-400">Options familiarity</label>
        <select className="mt-1 w-full p-3 rounded bg-slate-800 border border-slate-700" value={optionsFamiliarity} onChange={(e)=>setOptionsFamiliarity(e.target.value)}>
          <option value="new">New to options</option>
          <option value="basic">Basic concepts</option>
          <option value="active">Actively practicing</option>
        </select>
      </div>
      <div>
        <label className="text-sm text-slate-400">Default instrument type</label>
        <select className="mt-1 w-full p-3 rounded bg-slate-800 border border-slate-700" value={defaultInstrumentType} onChange={(e)=>setDefaultInstrumentType(e.target.value)}>
          <option value="OPTION">Options</option>
          <option value="INDEX">Indices</option>
          <option value="EQUITY">Equities</option>
        </select>
      </div>
      <button onClick={saveProfile} className="w-full p-3 rounded bg-emerald-500 text-slate-950 font-semibold">Save</button>
      {message && <p className="text-emerald-400">{message}</p>}
    </section>
  </main>;
}
