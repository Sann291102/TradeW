'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

const NAV = [
  { label: 'Platform', href: '#platform' },
  { label: 'Intelligence', href: '#intelligence' },
  { label: 'Security', href: '#security' },
];

/**
 * Marketing header for the landing route.
 *
 * Deliberately NOT the workspace TopBar: `/` is a bare route (nav-config
 * BARE_ROUTES) precisely so the marketing surface never wears the application
 * chrome — TRADEW-OS.md §1, "never let a marketing decision propagate into the
 * application's navigation, shell, or identity". The reverse holds too, which
 * is why this is a separate, much lighter component.
 *
 * The glass treatment is driven by an IntersectionObserver on a sentinel rather
 * than a scroll listener, because on this page the scrolling element is the
 * landing container, not `window` (globals.css pins `body { overflow: hidden }`
 * for the workspace shell). A sentinel works no matter which ancestor scrolls.
 */
export function LandingHeader() {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setStuck(!entry!.isIntersecting), {
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinel} aria-hidden="true" className="h-px w-full" />
      <header
        className="sticky top-0 z-50 transition-colors duration-panel"
        style={
          stuck
            ? {
                background: 'var(--card-glass)',
                backdropFilter: 'blur(var(--glass-blur))',
                WebkitBackdropFilter: 'blur(var(--glass-blur))',
                borderBottom: '1px solid var(--glass-border)',
              }
            : { borderBottom: '1px solid transparent' }
        }
      >
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
          <Link
            href="/"
            className="text-lg font-extrabold text-navy transition-opacity hover:opacity-80"
          >
            Trade<span className="text-teal">W</span>
          </Link>

          <nav aria-label="Landing" className="ml-2 hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-hover hover:text-text"
              >
                {item.label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {/* Both scroll to the same panel — it handles sign-in and sign-up
                on one tab. Two entry points because a returning user looks for
                "Sign in" and a new one looks for "Get started", and neither
                should have to work out that they are the same control. */}
            <a
              href="#auth"
              className="rounded-lg px-3 py-2 text-sm font-medium text-text transition-colors hover:bg-hover"
            >
              Sign in
            </a>
            <a
              href="#auth"
              className="rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-bg transition-opacity hover:opacity-90"
            >
              Get started
            </a>
          </div>
        </div>
      </header>
    </>
  );
}
