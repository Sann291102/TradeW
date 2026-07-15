'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, setSession } from '@/lib/api';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('founder@tradew.local');
  const [password, setPassword] = useState('password123');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    try {
      const res = await api('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
      setSession(res.accessToken, res.refreshToken);
      router.push('/trade');
    } catch (err: any) { setError(err.message); }
  }

  return <main className="min-h-screen flex items-center justify-center p-6"><form onSubmit={submit} className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-8"><h1 className="text-3xl font-bold">Create account</h1><input className="mt-6 w-full p-3 rounded bg-slate-800 border border-slate-700" value={email} onChange={(e)=>setEmail(e.target.value)} /><input className="mt-3 w-full p-3 rounded bg-slate-800 border border-slate-700" type="password" value={password} onChange={(e)=>setPassword(e.target.value)} />{error && <p className="text-red-400 mt-3">{error}</p>}<button className="mt-6 w-full p-3 rounded bg-emerald-500 text-slate-950 font-semibold">Sign up</button><Link className="text-emerald-400 mt-4 block text-sm" href="/login">Already have an account?</Link></form></main>;
}
