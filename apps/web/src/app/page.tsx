import { redirect } from 'next/navigation';

// TradeW opens directly into the workspace (like opening VS Code / a terminal,
// not a broker marketing site — TRADEW-OS.md §1). Root routes straight to the
// dashboard; there is no login wall in front of the Phase-1 workspace, which
// runs on mock data without the backend. Auth-gated pages (Profile, live
// Sentinel data) degrade gracefully when the API is offline rather than
// bouncing here.
export default function Home() {
  redirect('/dashboard');
}
