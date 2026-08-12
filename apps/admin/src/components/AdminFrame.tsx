'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { admin, AdminApiError } from '@/lib/api';

const SECTIONS = [
  { href: '/', label: 'Overview', exact: true },
  { href: '/orders', label: 'Orders' },
  { href: '/ai', label: 'AI & Sentinel' },
  { href: '/cognition', label: 'Perceptors & Neural' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/system', label: 'Users & System' },
];

type Access = 'checking' | 'granted' | 'denied';

/**
 * The operator console shell: background, header, nav — and cookie auth check.
 *
 * Auth is cookie-based: the /login page verified the operator token and set an
 * HMAC-signed session cookie. This component verifies that cookie is still live
 * by calling a real API endpoint. If the cookie is missing or expired, the
 * operator is redirected to /login — there is no in-page re-auth form, because
 * the credential is always the same shared secret and re-entering it here rather
 * than at the login page provides no additional security.
 */
export function AdminFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const reduce = useReducedMotion();
  const [access, setAccess] = useState<Access>('checking');

  const verify = useCallback(async () => {
    try {
      await admin.overview(1);
      setAccess('granted');
    } catch (err) {
      if (err instanceof AdminApiError && (err.status === 401 || err.status === 403)) {
        setAccess('denied');
      } else {
        // Network error or services/api down — show denied so the operator
        // knows something is wrong, but don't clear the session cookie.
        setAccess('denied');
      }
    }
  }, []);

  useEffect(() => { void verify(); }, [verify]);

  useEffect(() => {
    if (access === 'denied') {
      router.replace(`/login?from=${encodeURIComponent(pathname)}`);
    }
  }, [access, pathname, router]);

  const lockConsole = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
    router.replace('/login');
  };

  return (
    <div className="admin-root relative flex h-screen flex-col overflow-hidden bg-[#04070c] text-text">
      <Backdrop />

      {access === 'checking' && (
        <div className="relative z-10 flex flex-1 items-center justify-center">
          <div className="flex items-center gap-3 text-muted">
            <span className="admin-orb admin-orb--thinking block h-3 w-3" aria-hidden />
            <span className="text-[12.5px]">Verifying session…</span>
          </div>
        </div>
      )}

      {access === 'granted' && (
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
              onClick={() => void lockConsole()}
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
      )}
    </div>
  );
}

function Backdrop() {
  return (
    <div className="admin-space" aria-hidden>
      <div className="admin-space__grid" />
      <div className="admin-space__haze" />
    </div>
  );
}
