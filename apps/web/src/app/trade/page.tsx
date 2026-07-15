'use client';
import { useEffect, useState } from 'react';
import { api, clearToken, getRefreshToken } from '@/lib/api';
import { useRouter } from 'next/navigation';

type Instrument = { id: string; symbol: string; displayName: string; lotSize: number; type: string };

type Position = { id: string; symbol: string; displayName: string; quantity: number; avgPrice: number; ltp: number; pnl: number };

export default function TradePage() {
  const router = useRouter();
  const [q, setQ] = useState('NIFTY');
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selected, setSelected] = useState<Instrument | null>(null);
  const [quote, setQuote] = useState<any>(null);
  const [qty, setQty] = useState(75);
  const [positions, setPositions] = useState<Position[]>([]);
  const [message, setMessage] = useState('');

  async function search() {
    const rows = await api(`/instruments/search?q=${encodeURIComponent(q)}`);
    setInstruments(rows);
    if (rows[0]) select(rows[0]);
  }
  async function select(i: Instrument) {
    setSelected(i); setQty(i.lotSize || 1);
    const qt = await api(`/market-data/quote/${i.id}`);
    setQuote(qt);
  }
  async function place(side: 'BUY' | 'SELL') {
    if (!selected) return;
    setMessage('');
    await api('/sim/orders', { method: 'POST', body: JSON.stringify({ instrumentId: selected.id, side, quantity: Number(qty) }) });
    setMessage(`${side} order filled`);
    await loadPositions();
  }
  async function loadPositions() { setPositions(await api('/sim/positions')); }

  useEffect(() => { search().catch(()=>router.push('/login')); loadPositions().catch(()=>{}); }, []);

  return <main className="min-h-screen p-6 max-w-6xl mx-auto">
    <header className="flex justify-between items-center"><div><p className="text-emerald-400 text-sm font-semibold">TradeW Prototype</p><h1 className="text-3xl font-bold">Paper Trading</h1></div><div className="flex gap-2"><button onClick={()=>router.push('/profile')} className="px-3 py-2 rounded bg-slate-800 border border-slate-700">Profile</button><button onClick={async()=>{try{await api('/auth/logout',{method:'POST',body:JSON.stringify({refreshToken:getRefreshToken()})})}catch{} clearToken(); router.push('/')}} className="px-3 py-2 rounded bg-slate-800 border border-slate-700">Logout</button></div></header>
    <section className="grid md:grid-cols-2 gap-6 mt-8">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5">
        <h2 className="text-xl font-semibold">1. Search instrument</h2>
        <div className="flex gap-2 mt-4"><input className="flex-1 p-3 rounded bg-slate-800 border border-slate-700" value={q} onChange={e=>setQ(e.target.value)} /><button onClick={search} className="px-4 rounded bg-emerald-500 text-slate-950 font-semibold">Search</button></div>
        <div className="mt-4 space-y-2 max-h-72 overflow-auto">{instruments.map(i => <button key={i.id} onClick={()=>select(i)} className={`block w-full text-left p-3 rounded border ${selected?.id===i.id?'bg-emerald-900 border-emerald-500':'bg-slate-800 border-slate-700'}`}><b>{i.symbol}</b><span className="block text-sm text-slate-300">{i.displayName} · lot {i.lotSize}</span></button>)}</div>
      </div>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5">
        <h2 className="text-xl font-semibold">2. Quote + paper order</h2>
        {quote ? <div className="mt-4"><p className="text-slate-300">{quote.displayName}</p><p className="text-5xl font-bold mt-2">₹{quote.ltp}</p><p className="text-xs text-slate-500 mt-1">{quote.mode}</p><input className="mt-5 w-full p-3 rounded bg-slate-800 border border-slate-700" type="number" value={qty} onChange={e=>setQty(Number(e.target.value))}/><div className="grid grid-cols-2 gap-3 mt-3"><button onClick={()=>place('BUY')} className="p-3 rounded bg-emerald-500 text-slate-950 font-bold">BUY</button><button onClick={()=>place('SELL')} className="p-3 rounded bg-red-500 text-white font-bold">SELL</button></div>{message && <p className="mt-3 text-emerald-400">{message}</p>}</div> : <p className="mt-4 text-slate-400">Select an instrument</p>}
      </div>
    </section>
    <section className="bg-slate-900 border border-slate-700 rounded-2xl p-5 mt-6"><h2 className="text-xl font-semibold">3. Positions & P&L</h2><div className="mt-4 overflow-auto"><table className="w-full text-left"><thead className="text-slate-400"><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&L</th></tr></thead><tbody>{positions.map(p=><tr key={p.id} className="border-t border-slate-800"><td className="py-3">{p.symbol}</td><td>{p.quantity}</td><td>₹{p.avgPrice}</td><td>₹{p.ltp}</td><td className={p.pnl>=0?'text-emerald-400':'text-red-400'}>₹{p.pnl}</td></tr>)}</tbody></table>{positions.length===0 && <p className="text-slate-400 mt-3">No open positions yet.</p>}</div></section>
  </main>;
}
