'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<any>(null);
  const [experienceLevel, setExperienceLevel] = useState('beginner');
  const [optionsFamiliarity, setOptionsFamiliarity] = useState('new');
  const [defaultInstrumentType, setDefaultInstrumentType] = useState('OPTION');
  const [message, setMessage] = useState('');

  async function load() {
    const me = await api('/auth/me');
    setProfile(me);
    setExperienceLevel(me.experienceLevel || 'beginner');
    setOptionsFamiliarity(me.optionsFamiliarity || 'new');
    const prefs = await api('/auth/preferences');
    setDefaultInstrumentType(prefs.display?.defaultInstrumentType || 'OPTION');
  }

  async function saveProfile() {
    setMessage('');
    await api('/auth/me', { method: 'PATCH', body: JSON.stringify({ country: 'IN', experienceLevel, optionsFamiliarity }) });
    await api('/auth/preferences/display', { method: 'POST', body: JSON.stringify({ value: { defaultInstrumentType } }) });
    setMessage('Profile and preferences saved');
    await load();
  }

  useEffect(() => { load().catch(() => router.push('/login')); }, []);

  return <main className="min-h-screen p-6 max-w-3xl mx-auto">
    <header className="flex justify-between items-center">
      <div><p className="text-emerald-400 text-sm font-semibold">TradeW Prototype</p><h1 className="text-3xl font-bold">Profile & Preferences</h1></div>
      <button onClick={() => router.push('/trade')} className="px-3 py-2 rounded bg-slate-800 border border-slate-700">Back to trade</button>
    </header>

    <section className="mt-8 bg-slate-900 border border-slate-700 rounded-2xl p-6 space-y-5">
      <div>
        <label className="text-sm text-slate-400">Email</label>
        <div className="mt-1 p-3 rounded bg-slate-800 border border-slate-700">{profile?.email || 'Loading...'}</div>
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
