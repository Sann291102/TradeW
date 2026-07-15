import Link from 'next/link';

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-xl w-full bg-slate-900 border border-slate-700 rounded-2xl p-8 shadow-xl">
        <p className="text-emerald-400 text-sm font-semibold">TradeW Sprint 0</p>
        <h1 className="text-4xl font-bold mt-3">Paper trading prototype</h1>
        <p className="text-slate-300 mt-4">Practice with NIFTY/BANKNIFTY instruments. No buy/sell signals. No investment advice.</p>
        <div className="flex gap-3 mt-8">
          <Link className="px-4 py-2 rounded-lg bg-emerald-500 text-slate-950 font-semibold" href="/signup">Sign up</Link>
          <Link className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700" href="/login">Log in</Link>
        </div>
      </div>
    </main>
  );
}
