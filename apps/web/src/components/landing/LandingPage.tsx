'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { LandingHeader } from './LandingHeader';
import { MarketBackdrop } from './MarketBackdrop';
import { Mascot } from './Mascot';
import { AuthPanel } from './AuthPanel';
import {
  SentinelIcon,
  ResearchIcon,
  LearningIcon,
  MarketsIcon,
} from '@/components/shell/icons';

/**
 * The TradeW marketing landing page — the first surface a visitor who is not
 * yet a user sees.
 *
 * Scope is set by TRADEW-OS.md §1: a marketing surface is "fine and expected"
 * because it reaches people who are not yet users, but the rule binds from
 * sign-in onward — so this page never wears the workspace chrome, and anyone
 * already signed in is sent straight to `/dashboard` by the route (page.tsx)
 * rather than being made to walk past a brochure to reach their terminal.
 *
 * Copy discipline: no invented traction numbers, no testimonials from people
 * who do not exist, and no certification claims the platform does not hold.
 * On a financial product those are a compliance exposure, not a growth tactic,
 * and §5's "observation, never advice" posture is a stronger differentiator
 * than borrowed credibility anyway.
 *
 * Scrolling: `body` is pinned `overflow:hidden` in globals.css for the
 * workspace shell, so this page owns its own scroll container.
 */

/**
 * Section reveal. Fast on purpose — a reveal the reader can outrun feels
 * broken, and slow fades were the most visible flaw in the reference build.
 *
 * Uses an explicit IntersectionObserver rather than framer-motion's
 * `whileInView`. That is not a style preference: `whileInView` did not fire
 * for an element that was ALREADY intersecting when it mounted, which is
 * exactly what happens when someone lands on `/#auth` and the browser jumps
 * straight to the sign-in panel. The result was opacity stuck at 0 — the
 * whole sign-in form invisible, permanently, with no error anywhere.
 *
 * IntersectionObserver is specified to deliver an initial callback for every
 * target when you observe it, whether or not it is already in view, so that
 * failure mode cannot recur. A decorative animation must never be the reason
 * a control is unreachable.
 */
function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry!.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  if (reduce) return <div className={className}>{children}</div>;

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 16 }}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
      transition={{ duration: 0.45, delay, ease: [0.4, 0, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

const SURFACES = [
  {
    icon: SentinelIcon,
    name: 'Sentinel',
    premium: true,
    body: 'The premium intelligence workspace. Watches structure, liquidity and exposure in the background, and shows its reasoning whenever it raises something.',
  },
  {
    icon: ResearchIcon,
    name: 'Research',
    body: 'Catalysts, filings, sentiment and market structure gathered into one screen, with every conclusion traceable back to the evidence it came from.',
  },
  {
    icon: LearningIcon,
    name: 'Learning Hub',
    body: 'Concepts and repeatable playbooks tied to the instruments you actually trade — not a course library bolted on beside the terminal.',
  },
  {
    icon: MarketsIcon,
    name: 'Markets & Trade',
    body: 'Charts, option chains, portfolio and order entry in one continuous workspace, so moving between analysis and execution is not a context switch.',
  },
];

const PRINCIPLES = [
  {
    title: 'Observation, never advice',
    body: 'TradeW explains what it sees and why it matters. It never issues buy or sell instructions, and no AI in the system can place an order on your behalf. That is a hard architectural rule, not a setting.',
  },
  {
    title: 'Everything premium is explainable',
    body: 'Any conclusion the platform reaches can show its reasoning, evidence, historical precedent, confidence and what changed since last time. If it cannot be explained, it does not ship.',
  },
  {
    title: 'One workspace, many surfaces',
    body: 'Markets, research, risk and learning share the same chrome, state and memory. Moving between them should never feel like leaving the platform.',
  },
];

const SECURITY = [
  'End-to-end encryption in transit and at rest',
  'Two-factor authentication, including authenticator apps',
  'A single audited ingress — every request passes one policy layer',
  'Session, entitlement and audit handling built into the platform core',
];

export function LandingPage() {
  return (
    <div className="h-screen overflow-y-auto overflow-x-hidden bg-bg text-text">
      <LandingHeader />

      <main>
        {/* ---------------------------------------------------------------- Hero */}
        <section className="relative flex min-h-[86vh] items-center px-6 pb-24 pt-10">
          <MarketBackdrop />

          <div className="relative mx-auto w-full max-w-4xl text-center">
            <Reveal className="flex justify-center">
              <Mascot size={132} />
            </Reveal>

            <Reveal delay={0.05}>
              <span className="mt-4 inline-flex items-center gap-2 rounded-full border border-border2 px-3 py-1 text-xs uppercase tracking-wideTrack text-muted">
                <span className="size-1.5 rounded-full bg-teal" />
                AI trading operating system
              </span>
            </Reveal>

            <Reveal delay={0.1}>
              <h1 className="mt-6 text-balance text-5xl font-extrabold leading-tight2 tracking-tightTrack text-navy sm:text-6xl">
                An operating system for
                <br className="hidden sm:block" /> the way you <span className="text-teal">trade</span>.
              </h1>
            </Reveal>

            <Reveal delay={0.15}>
              <p className="mx-auto mt-6 max-w-2xl text-pretty text-fsMd leading-normal2 text-muted">
                One workspace for markets, research, risk and learning — with intelligence
                that explains what it sees, and never tells you what to buy.
              </p>
            </Reveal>

            <Reveal delay={0.2}>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                {/* The workspace is behind the wall now, so neither CTA can
                    promise a look inside — the honest pair is "sign up" and
                    "read on first". */}
                <a
                  href="#auth"
                  className="rounded-xl bg-teal px-6 py-3 text-fsSm font-semibold text-bg shadow-glowTeal transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  Create your account
                </a>
                <a
                  href="#platform"
                  className="rounded-xl border border-border2 px-6 py-3 text-fsSm font-semibold text-text transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  See what&rsquo;s inside
                </a>
              </div>
            </Reveal>

            <Reveal delay={0.25}>
              <p className="mt-6 text-fs2xs text-faint">
                No card required. Paper trading by default.
              </p>
            </Reveal>
          </div>
        </section>

        {/* ------------------------------------------------------------ Platform */}
        <section id="platform" className="scroll-mt-16 border-t border-border px-6 py-24">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <h2 className="text-balance text-center text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
                Four surfaces. One continuous workspace.
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-center text-fsSm leading-normal2 text-muted">
                Each does one job well. None of them are separate products bolted together.
              </p>
            </Reveal>

            <div className="mt-14 grid gap-4 sm:grid-cols-2">
              {SURFACES.map((s, i) => (
                <Reveal key={s.name} delay={i * 0.06}>
                  <article
                    className="group h-full rounded-2xl border border-glassBorder p-7 shadow-elev1 transition-shadow duration-panel ease-standard hover:shadow-elev2"
                    style={{
                      background: 'var(--card-glass)',
                      backdropFilter: 'blur(var(--glass-blur))',
                      WebkitBackdropFilter: 'blur(var(--glass-blur))',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="grid size-10 place-items-center rounded-xl bg-teal-bg text-teal">
                        <s.icon width={20} height={20} />
                      </span>
                      <h3 className="text-fsMd font-semibold text-navy">{s.name}</h3>
                      {s.premium && (
                        <span className="rounded-full border border-border2 px-2 py-0.5 text-[10px] uppercase tracking-wideTrack text-amber">
                          Premium
                        </span>
                      )}
                    </div>
                    <p className="mt-4 text-fsXs leading-normal2 text-muted">{s.body}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- Intelligence */}
        <section id="intelligence" className="scroll-mt-16 border-t border-border px-6 py-24">
          <div className="mx-auto max-w-5xl">
            <Reveal>
              <h2 className="text-balance text-center text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
                Intelligence you can argue with.
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-center text-fsSm leading-normal2 text-muted">
                Three commitments the platform is built around — and cannot quietly drop.
              </p>
            </Reveal>

            <div className="mt-14 space-y-3">
              {PRINCIPLES.map((p, i) => (
                <Reveal key={p.title} delay={i * 0.07}>
                  <div className="rounded-2xl border border-border bg-card p-7 sm:flex sm:gap-8">
                    <h3 className="shrink-0 text-fsMd font-semibold text-teal sm:w-64">
                      {p.title}
                    </h3>
                    <p className="mt-3 text-fsXs leading-normal2 text-muted sm:mt-0">{p.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ Security */}
        <section id="security" className="scroll-mt-16 border-t border-border px-6 py-24">
          <div className="mx-auto max-w-5xl">
            <Reveal>
              <h2 className="text-balance text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
                Security is the product, not a page.
              </h2>
              <p className="mt-4 max-w-2xl text-fsSm leading-normal2 text-muted">
                Your capital, credentials and strategy stay yours. What is in place today:
              </p>
            </Reveal>

            <div className="mt-12 grid gap-3 sm:grid-cols-2">
              {SECURITY.map((item, i) => (
                <Reveal key={item} delay={i * 0.05}>
                  <div className="flex h-full items-start gap-3 rounded-2xl border border-border bg-card px-5 py-5">
                    <svg
                      viewBox="0 0 24 24"
                      width={18}
                      height={18}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mt-0.5 shrink-0 text-teal"
                      aria-hidden="true"
                    >
                      <path d="m4 12.5 5 5L20 6.5" />
                    </svg>
                    <span className="text-fsXs leading-normal2 text-text">{item}</span>
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal>
              <p className="mt-8 text-fs2xs leading-normal2 text-faint">
                TradeW is built to SEBI and DPDP expectations for observation-only platforms.
                Where a formal certification is not yet held, this page says so rather than
                implying otherwise.
              </p>
            </Reveal>
          </div>
        </section>

        {/* ---------------------------------------------------------------- Auth */}
        <section
          id="auth"
          className="relative scroll-mt-16 overflow-hidden border-t border-border px-6 py-28"
        >
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse 50% 60% at 50% 100%, var(--teal-bg), transparent 70%)',
            }}
            aria-hidden="true"
          />
          <div className="relative mx-auto max-w-md">
            <Reveal className="text-center">
              <Mascot size={92} className="mx-auto" />
              <h2 className="mt-6 text-balance text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
                Create your TradeW account.
              </h2>
              <p className="mt-4 text-fsSm leading-normal2 text-muted">
                Choose how you&rsquo;d like to begin. Paper trading by default — nothing moves
                real money until you connect a broker yourself.
              </p>
            </Reveal>

            <Reveal delay={0.08} className="mt-10">
              <AuthPanel />
            </Reveal>
          </div>
        </section>
      </main>

      {/* -------------------------------------------------------------- Footer */}
      <footer className="border-t border-border px-6 py-14">
        <div className="mx-auto flex max-w-6xl flex-col gap-10 sm:flex-row sm:justify-between">
          <div className="max-w-xs">
            <span className="text-lg font-extrabold text-navy">
              Trade<span className="text-teal">W</span>
            </span>
            <p className="mt-3 text-fs2xs leading-normal2 text-muted">
              An AI trading operating system. Observations only — never investment advice.
            </p>
          </div>

          {/* Every link here resolves for a SIGNED-OUT reader, which is the only
              kind of reader this page has. Pointing at /dashboard or /sentinel
              would bounce them straight back to this page by the middleware —
              a loop that reads as a broken link. So the Platform column links
              to the sections above, and Account links to the form below. */}
          <nav aria-label="Footer" className="flex gap-14">
            <div>
              <h3 className="text-fs2xs font-semibold uppercase tracking-wideTrack text-faint">
                Platform
              </h3>
              <ul className="mt-4 space-y-2.5 text-fsXs">
                <li>
                  <a href="#platform" className="text-muted transition-colors hover:text-text">
                    Surfaces
                  </a>
                </li>
                <li>
                  <a href="#intelligence" className="text-muted transition-colors hover:text-text">
                    Intelligence
                  </a>
                </li>
                <li>
                  <a href="#security" className="text-muted transition-colors hover:text-text">
                    Security
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-fs2xs font-semibold uppercase tracking-wideTrack text-faint">
                Account
              </h3>
              <ul className="mt-4 space-y-2.5 text-fsXs">
                <li>
                  <a href="#auth" className="text-muted transition-colors hover:text-text">
                    Sign in
                  </a>
                </li>
                <li>
                  <a href="#auth" className="text-muted transition-colors hover:text-text">
                    Create account
                  </a>
                </li>
                <li>
                  <Link href="/reset" className="text-muted transition-colors hover:text-text">
                    Reset password
                  </Link>
                </li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="mx-auto mt-12 max-w-6xl border-t border-border pt-6 text-fs2xs text-faint">
          TradeW does not provide investment advice and does not place trades on your behalf.
          Markets carry risk — trade responsibly.
        </div>
      </footer>
    </div>
  );
}
