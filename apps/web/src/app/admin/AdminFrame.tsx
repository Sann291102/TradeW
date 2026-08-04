'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { admin, clearAdminToken, getAdminToken, setAdminToken, AdminApiError } from '@/lib/admin/api';
import { getToken } from '@/lib/api';
import { AdminGate } from './AdminGate';

const SECTIONS = [
  { href: '/admin', label: 'Overview', exact: true },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/ai', label: 'AI & Sentinel' },
  { href: '/admin/knowledge', label: 'Knowledge' },
  { href: '/admin/system', label: 'Users & System' },
];

type Access = 'checking' | 'granted' | 'denied' | 'no-session';

/**
 * The portal shell: background, header, section nav — and the client-side gate.
 *
 * **The gate is a convenience, not a security boundary.** Every byte of data
 * this portal displays comes from `/admin/*`, and every one of those endpoints
 * independently enforces both factors server-side. A user who bypasses this
 * component — by disabling JS, editing state, or requesting the route
 * directly — reaches a shell that can fetch nothing. That is the actual
 * protection; this component exists so an admin sees a clear "enter your
 * operator token" instead of a page of failed requests.
 *
 * Access is verified by calling a real endpoint rather than by inspecting a
 * token locally. Only the server knows whether this user has `isAdmin`, and
 * only the server knows whether the operator token is the current one.
 */
export function AdminFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const [access, setAccess] = useState<Access>('checking');
  const [error, setError] = useState<string | null>(null);

  const verify = useCallback(async () => {
    if (!getToken()) {
      setAccess('no-session');
      return;
    }
    if (!getAdminToken()) {
      setAccess('denied');
      setError(null);
      return;
    }
    try {
      await admin.overview(1);
      setAccess('granted');
      setError(null);
    } catch (err) {
      // A rejected token is stale or wrong; drop it so the gate does not
      // re-submit the same failing value on every reload.
      if (err instanceof AdminApiError && (err.status === 401 || err.status === 403)) clearAdminToken();
      setAccess('denied');
      setError(err instanceof Error ? err.message : 'Access check failed');
    }
  }, []);

  useEffect(() => {
    void verify();
  }, [verify]);

  const submitToken = async (token: string) => {
    setAdminToken(token);
    setAccess('checking');
    await verify();
  };

  return (
    <div className="admin-root relative flex h-screen flex-col overflow-hidden bg-[#04070c] text-text">
      <Backdrop />

      {access === 'granted' ? (
        <>
          <header className="relative z-10 flex shrink-0 items-center gap-6 border-b border-white/5 bg-black/30 px-6 py-3 backdrop-blur">
            <div className="flex items-center gap-3">
              <span className="admin-orb admin-orb--thinking block h-3 w-3" aria-hidden />
              <div>
                <div className="text-[13px] font-semibold tracking-wide">TradeW Admin</div>
                <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted">Operator console</div>
              </div>
            </div>

            <nav className="flex flex-1 items-center gap-1">
              {SECTIONS.map((section) => {
                const active = section.exact ? pathname === section.href : pathname.startsWith(section.href);
                return (
                  <Link
                    key={section.href}
                    href={section.href}
                    className={`relative rounded-md px-3 py-1.5 text-[12.5px] transition-colors ${
                      active ? 'text-teal' : 'text-muted hover:text-text'
                    }`}
                  >
                    {section.label}
                    {active && (
                      <motion.span
                        layoutId="admin-nav-underline"
                        className="absolute inset-x-2 -bottom-[13px] h-px bg-teal"
                        transition={{ duration: reduce ? 0 : 0.25 }}
                      />
                    )}
                  </Link>
                );
              })}
            </nav>

            <button
              type="button"
              onClick={() => {
                clearAdminToken();
                setAccess('denied');
              }}
              className="rounded-md border border-white/10 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-white/20 hover:text-text"
            >
              Lock console
            </button>
          </header>

          <main className="relative z-10 min-h-0 flex-1 overflow-auto">
            <AnimatePresence mode="wait">
              <motion.div
                key={pathname}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
                className="h-full"
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </main>
        </>
      ) : (
        <AdminGate state={access} error={error} onSubmit={submitToken} />
      )}
    </div>
  );
}

/**
 * The layered 3D backdrop. Sits behind everything at z-0 and is
 * `pointer-events: none`, so it never intercepts a click meant for a table.
 */
function Backdrop() {
  return (
    <div className="admin-space" aria-hidden>
      <div className="admin-space__grid" />
      <div className="admin-space__haze" />
    </div>
  );
}
