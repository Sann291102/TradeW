import { Sidebar } from '@/components/shell/Sidebar';

/**
 * Wraps every module page (the route group `(console)`, which does not add a
 * URL segment) with the sidebar shell. `/login` sits OUTSIDE this group at
 * `src/app/login/`, so it renders without the sidebar and without needing an
 * authenticated session — `middleware.ts` is what actually enforces auth, not
 * this layout; this only supplies the chrome once the middleware has already
 * let the request through.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
