'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { LandingHeader } from './LandingHeader';
import { MarketBackdrop } from './MarketBackdrop';
import { Mascot } from './Mascot';
import { TaraGreeter } from './TaraGreeter';
import { ASSISTANT_NAME } from '@/lib/assistant/identity';
import { AuthPanel } from './AuthPanel';
import { AUTH_COPY, readAuthMode, type AuthMode } from '@/lib/auth-mode';
import { SiteFooter } from '@/components/footer/SiteFooter';
import { NameYourAI } from './NameYourAI';
import {
  SentinelIcon,
  ResearchIcon,
  LearningIcon,
  MarketsIcon,
} from '@/components/shell/icons';
import {
  DEMO_PASSES,
  FREE_PAPER_ORDERS_PER_DAY,
  LEARNING_MONTHLY,
  SENTINEL_TERMS,
  inr,
} from '@tradew/types';

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
  /**
   * 'ssr'    — server render and first paint: VISIBLE, so the page reads with
   *            no JavaScript at all.
   * 'hidden' — client has run, this element is off screen, so it may be hidden
   *            and revealed on scroll. Nobody can see it change.
   * 'shown'  — revealed, or was already on screen when the client took over.
   */
  const [state, setState] = useState<'ssr' | 'hidden' | 'shown'>('ssr');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Anything already on screen goes straight to 'shown'. Hydration must never
    // hide something the reader can already see.
    const rect = el.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < window.innerHeight) {
      setState('shown');
      return;
    }

    setState('hidden');
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry!.isIntersecting) {
          setState('shown');
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  if (reduce) return <div className={className}>{children}</div>;

  // Two rules are load-bearing here, and each one cost a real blank-page bug.
  //
  // 1. `initial={false}` — render at the `animate` value instead of animating
  //    up from a hidden one. `initial={{ opacity: 0 }}` is what the SERVER
  //    serialises, so it shipped all 24 sections as `style="opacity:0"`, and
  //    they became visible only once React had hydrated. On a cold dev bundle
  //    that is a blank page for seconds; if hydration fails or JS is blocked it
  //    is blank permanently, with nothing in the console to explain it.
  //    Observed 2026-08-11 on `/?next=%2Fdashboard#auth` — 21 of 24 sections
  //    pinned at opacity 0, the sign-in form among them, so the page was not
  //    merely ugly, it was unusable. Content must not depend on JavaScript to
  //    be VISIBLE; motion may only ever add to markup that already reads.
  //
  // 2. The element type never changes across states. An earlier attempt at (1)
  //    rendered a plain <div> until hydration and then swapped to motion.div —
  //    which replaces the DOM node, leaving the IntersectionObserver holding a
  //    DETACHED element that can never intersect. Everything below the fold
  //    stayed invisible forever. Keep one element; vary only its animate target.
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={false}
      animate={state === 'hidden' ? { opacity: 0, y: 16 } : { opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.4, 0, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Everything below this line is the **decision brief** — the reason a visitor
 * can tell whether TradeW is for them before creating an account.
 *
 * Every claim is traceable to a binding document, so this copy can be checked
 * rather than trusted: surfaces and workspace behaviour to `TRADEW-OS.md` and
 * `docs/product-architecture/WORKSPACE-SHELL.md`; the assistant to
 * `TRADEW-ASSISTANT.md` and `TRADEW-AI.md` §3; Sentinel to `SENTINEL.md`
 * §§2–5; the curriculum to `LEARNING-HUB.md` §2; onboarding to
 * `ONBOARDING.md` §2; plans to `SUBSCRIPTIONS.md` §§1–3.
 *
 * Two rules govern edits here, and they are the same two the file already
 * followed: nothing that has not been built or specified may be described as
 * though it ships today, and no number appears that is not in one of those
 * documents. A marketing page that outruns the product is a compliance
 * exposure on a financial platform, not enthusiasm.
 */

const SURFACES = [
  {
    icon: SentinelIcon,
    name: 'Sentinel',
    premium: true,
    body: 'The premium intelligence workspace. Watches structure, liquidity and exposure in the background, and shows its reasoning whenever it raises something.',
    points: [
      'A day classification — trend, selective, choppy, trap-prone or quiet — with the signals behind it',
      'Market context: volatility, momentum, trap probability, structure',
      'A live safety feed of plain-language cards, each openable into its evidence',
      'The lesson tied to whatever today is actually teaching you',
    ],
  },
  {
    icon: ResearchIcon,
    name: 'Research',
    body: 'Catalysts, filings, sentiment and market structure gathered into one screen, with every conclusion traceable back to the evidence it came from.',
    points: [
      'Per-symbol overview, fundamentals and financials',
      'Shareholding and corporate actions',
      'News with sentiment, technicals, and stated risk factors',
      '“Explain this company” — one plain-language synthesis across all of it',
    ],
  },
  {
    icon: LearningIcon,
    name: 'Learning Hub',
    body: 'Concepts and repeatable playbooks tied to the instruments you actually trade — not a course library bolted on beside the terminal.',
    points: [
      'Ordered learning paths, not a shelf of unrelated videos',
      'Progress, bookmarks and search across every lesson',
      'Historical case studies that explain what happened and why',
      'Every lesson traces to a validated source, or it is not published',
      'Lifetime Free if you actually do the work — strategies, quizzes, participation',
    ],
  },
  {
    icon: MarketsIcon,
    name: 'Markets & Trade',
    body: 'Charts, option chains, portfolio and order entry in one continuous workspace, so moving between analysis and execution is not a context switch.',
    points: [
      'Indices, sector heatmap, movers, watchlists and a live ticker',
      'Option chain with Greeks, open interest and contract analysis',
      'Order ticket showing what a position actually blocks, not just its value',
      'Positions, holdings, orders and P&L in the same workspace',
    ],
  },
];

/**
 * The brief a visitor reads before deciding. Deliberately written as "what you
 * get", not "what we believe" — the principles section below already carries
 * the posture, and repeating it here would cost the reader the specifics.
 */
const BRIEF = [
  {
    title: 'A workspace, not a website',
    body: 'One shell for every surface: sidebar, top bar, live ticker, dockable panels, a ⌘K command palette that searches symbols and runs commands, keyboard shortcuts, and light, dark and high-contrast themes. Your layout is yours and it persists.',
  },
  {
    title: 'Paper trading from the first minute',
    body: 'Accounts start on simulated execution. Nothing you do moves real money until you connect a broker yourself, deliberately — so you can learn the platform on live prices at zero risk.',
  },
  {
    title: 'An assistant that operates the app',
    body: 'Ask for a screen and it opens it; ask what a chart or an option chain is doing and it reads it back to you in plain language. It can reach every feature your account can reach — and no order path, ever.',
  },
  {
    title: 'A second pair of eyes on your behaviour',
    body: 'Sentinel watches structure and your own trading patterns side by side — chasing, revenge trades, size drift, low-conviction breakouts — and says something before the mistake, not in the monthly review.',
  },
  {
    title: 'Learning attached to the thing you just did',
    body: 'The Learning Hub is wired to what the session showed: concepts, price action, indicators, risk, psychology and case studies, surfaced when they are relevant rather than filed away in a course catalogue.',
  },
  {
    title: 'Guardrails written into the architecture',
    body: 'No AI in this system can place, modify or cancel an order — not gated, not configurable, not present. Every intelligence surface observes and explains; converting anything into a trade is always a decision you make by hand.',
  },
];

/** TradeW AI's specialist roster — `TRADEW-AI.md` §3, verbatim in scope. */
const AI_AGENTS = [
  ['AI Researcher', 'Routes what you ask to the right specialist and holds the thread'],
  ['Technical Analysis', 'Reads chart structure — EMA, VWAP, observed support and resistance'],
  ['Option Chain Analysis', 'Explains PCR, max pain, IV skew and open-interest shifts'],
  ['Company Analysis', 'Fundamentals, financials, shareholding, corporate actions, risk factors'],
  ['News Analysis', 'Summarises and sentiment-tags what moved, and says what it cannot know'],
  ['Portfolio Insights', 'Narrates concentration, movers and sector tilt across your holdings'],
  ['Strategy Builder', 'Explains multi-leg option structures and their payoff — you add every leg'],
  ['Learning Assistant', 'Answers “what does this actually mean” anywhere in the product'],
];

/** Composite trap signals — `SENTINEL.md` §3. Never a verdict on their own. */
const TRAP_SIGNALS = [
  'Fake breakouts',
  'Bull traps',
  'Bear traps',
  'Liquidity sweeps',
  'Stop hunts',
  'FOMO entries',
  'Chasing green candles',
  'Emotional averaging down',
  'Revenge trading',
  'Low-volume breakouts',
  'News-driven volatility',
  'Expiry-day traps',
  'Gamma squeeze / IV crush',
  'High-risk market regimes',
];

/** Learning Hub taxonomy — `LEARNING-HUB.md` §2. */
const CURRICULUM = [
  'Trading Basics',
  'Advanced Concepts',
  'Price Action',
  'Indicators',
  'Market Structure',
  'Risk Management',
  'Psychology',
  'Backtesting',
  'Historical Case Studies',
  'News Analysis',
  'Interactive Lessons',
  'Concept Maps',
];

/** The onboarding sequence, in order — `ONBOARDING.md` §2. */
const ONBOARDING = [
  ['Tell us where you are', 'Experience level, what you are here for, and the markets you care about.'],
  ['Set a risk profile', 'Conservative, moderate or aggressive — the baseline Sentinel reasons from before you have any history with us.'],
  ['Choose your workspace', 'Which surface you want to open into every day.'],
  ['Take the tour', 'The shell, the search, and a straight explanation of what Sentinel is and is not — before it ever raises something.'],
  ['Start on paper', 'You land in your workspace, on simulated execution, with nothing connected to real money.'],
];

/**
 * Plans. Figures come from `SUBSCRIPTIONS.md` §§1–3 and match what the in-app
 * Settings page already shows. The "nothing is charged today" line is not a
 * softener — checkout genuinely is not built, and a page that implied
 * otherwise would be collecting intent under false terms.
 */
/**
 * Plans, read from `@tradew/types` rather than retyped.
 *
 * This block used to hold its own hardcoded figures, which is exactly how the
 * marketing page and the in-app upgrade screen end up disagreeing. The numbers
 * now come from the same list `GET /pricing` serves.
 */
const SENTINEL_CHEAPEST = SENTINEL_TERMS.reduce((a, b) => (b.monthly < a.monthly ? b : a));

const PLANS = [
  {
    name: 'Free',
    price: '₹0',
    note: 'No card required',
    points: [
      'The full workspace, watchlists and research',
      `${FREE_PAPER_ORDERS_PER_DAY} paper order executions a day`,
      'Learning Hub lessons browsable',
    ],
  },
  {
    name: 'Demo Pass',
    price: inr(DEMO_PASSES[0].price),
    note: `${DEMO_PASSES[0].term} · ${inr(DEMO_PASSES[1].price)} for ${DEMO_PASSES[1].term}`,
    points: [
      'Unlimited paper orders for the term',
      'Everything in Free',
      'For the stretch where you are practising daily',
    ],
  },
  {
    name: 'Learning Hub',
    price: inr(LEARNING_MONTHLY),
    note: 'per month',
    points: [
      'Every lesson body unlocked',
      'The full curriculum, updated as it grows',
      'Or earn Lifetime Free by finishing the work — see below',
    ],
  },
  {
    name: 'Sentinel',
    price: inr(SENTINEL_CHEAPEST.monthly),
    note: `per month on the ${SENTINEL_CHEAPEST.term.toLowerCase()} term · ${inr(
      SENTINEL_TERMS[0]!.monthly,
    )} monthly`,
    highlight: true,
    points: [
      'Live observations, day classification and trap detection',
      'The evidence panel behind every card',
      'Longer terms cost less per month',
    ],
  },
];

const FAQ = [
  {
    q: 'Will TradeW tell me what to buy?',
    a: 'No. Every intelligence surface explains what it sees and cites the evidence — “volume is below the 20-day average and open interest is declining” — and stops there. It never issues a buy or sell instruction, and it never publishes a price target. If you want a signal service, this is not one.',
  },
  {
    q: 'Can the AI place a trade for me?',
    a: 'No, and not as a setting either. No AI service in the platform can reach the order path at all; orders go through your own manual action and the platform’s own validation. Sentinel in particular runs alongside the order flow and can never block, delay or gate it.',
  },
  {
    q: 'Do I need a broker account to start?',
    a: 'No. You start on paper trading against live prices. Connecting a broker is a separate, deliberate step you take when you decide to, and until then nothing you do can move real money.',
  },
  {
    q: 'What does it actually cost to try?',
    a: `Nothing. A free account gets the workspace, research and ${FREE_PAPER_ORDERS_PER_DAY} paper executions a day. Paid plans are listed above so you know what you are walking towards — and payments are not switched on yet, so no account can be charged today.`,
  },
  {
    q: 'Which markets does it cover?',
    a: 'Indian equities, indices and F&O are the focus — NIFTY, BANKNIFTY, SENSEX, the option chain and the sector map. Crypto and forex surfaces exist in the workspace alongside them.',
  },
  {
    q: 'What happens to my data?',
    a: 'Your trading behaviour is used to give you better observations, and for nothing else — it is never sold, and there is no advertising or third-party analytics in the product. Traffic is encrypted in transit and every request passes a single audited ingress. The Security page states what is in place and, just as plainly, what is not yet; the Privacy Policy sets out what is collected and the rights you have over it.',
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

/**
 * WHAT THIS LIST MAY SAY (corrected 2026-08-20).
 *
 * Two entries here were claims the implementation does not support, found by
 * the footer/trust audit (docs/footer/FOOTER_RESEARCH_REPORT.md §4):
 *
 *  · "End-to-end encryption in transit and at rest". TLS in transit is real.
 *    Encryption AT REST is not implemented — packages/database/prisma/schema.prisma
 *    stores a broker `accessToken` in plaintext and says so in its own comment
 *    ("encryption at rest is genuinely outstanding … NOT solved by this
 *    change"). "End-to-end" was wrong as a term of art besides: TradeW can read
 *    this data.
 *  · "Two-factor authentication, including authenticator apps". A repository-wide
 *    grep for totp / authenticator / otpauth returned only this string. What
 *    exists is one-time codes over email and SMS (services/api/src/auth/otp.service.ts);
 *    the only authenticator-app step is Dhan's own, on Dhan's site.
 *
 * The at-rest gap was then FIXED (2026-08-20) rather than merely un-claimed —
 * packages/database/src/credential-crypto.ts — so the list says so again, but
 * scoped to broker credentials, which is the only thing that is encrypted. The
 * blanket version of that sentence is still false and must not come back.
 *
 * On a financial product an unearned security claim is a compliance exposure,
 * not a growth tactic — the same rule this file's header already states about
 * traction numbers and testimonials. The rule for editing this list: every
 * entry must be checkable against a file in this repository, and every entry
 * must appear in docs/security/SECURITY_CLAIMS_EVIDENCE.md §1 first. The full
 * picture, including the gaps, is /legal/security.
 */
const SECURITY = [
  'Encryption in transit — TLS everywhere, with strict transport security enforced',
  'Broker credentials encrypted at rest, bound to your account, with the key held outside the database',
  'One-time sign-in codes over email and SMS, stored hashed, expiring, and rate-limited',
  'A single audited ingress — every request passes one policy layer',
  'Session, entitlement and audit handling built into the platform core',
];

export function LandingPage() {
  /**
   * Which half of the auth panel is showing, owned HERE rather than inside the
   * panel so the section heading and the form can never contradict each other
   * (see `lib/auth-mode.ts`). Default is sign-in — the common case for a
   * returning visitor — and every route into the section that means "create an
   * account" says so, either through the URL or through the CTA below.
   */
  const [authMode, setAuthMode] = useState<AuthMode>('login');

  // A URL can ask for a mode: `/signup` redirects to `/?auth=signup#auth`, and
  // any hand-written link may carry the same parameter. Run once on mount;
  // after that the panel's own toggle is the only thing that changes it.
  useEffect(() => {
    const requested = readAuthMode(window.location.search, window.location.hash);
    if (!requested) return;
    setAuthMode(requested);
    // The browser only scrolls for a fragment that matches an id, so a URL
    // that named the mode in the query (or in a fragment of its own) would
    // otherwise leave the visitor at the top of a long marketing page with no
    // sign of the form they asked for.
    document.getElementById('auth')?.scrollIntoView({ block: 'start' });
  }, []);

  /**
   * Send a same-page CTA to the auth section in the mode it advertises.
   *
   * The href stays `#auth`, so the link still works without JavaScript and
   * still scrolls; this only makes the panel show the half the button's label
   * promised. `scroll-mt-16` on the section keeps it clear of the header.
   */
  function goToAuth(mode: AuthMode) {
    setAuthMode(mode);
  }

  return (
    <div className="h-screen overflow-y-auto overflow-x-hidden bg-bg text-text">
      <LandingHeader onAuthIntent={goToAuth} />

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

            {/* The four facts that decide it for most readers, before they have
                scrolled anywhere. Each one is expanded in a section below. */}
            <Reveal delay={0.18}>
              {/* max-w-4xl, not 3xl: the four chips measure ~785px and 3xl is
                  768px, so they wrapped 3+1 by 17 pixels. */}
              <ul className="mx-auto mt-7 flex max-w-4xl flex-wrap items-center justify-center gap-x-2 gap-y-2 text-fs2xs text-muted">
                {[
                  'Four workspaces, one login',
                  'Paper trading by default',
                  'An assistant that runs the app',
                  'No AI can place an order',
                ].map((f) => (
                  <li
                    key={f}
                    className="rounded-full border border-border2 px-3 py-1.5"
                  >
                    {f}
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal delay={0.2}>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                {/* The workspace is behind the wall now, so neither CTA can
                    promise a look inside — the honest pair is "sign up" and
                    "read on first". */}
                <a
                  href="#auth"
                  onClick={() => goToAuth('signup')}
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

            {/*
              The naming moment, in the hero and above the fold (AI-PERSONA.md
              §2). Placed here rather than beside the signup form deliberately:
              it is the product's first impression, and the point is that the
              user has a relationship with the assistant BEFORE they are asked
              for an email. The name is carried into the account by AuthPanel.
            */}
            <Reveal delay={0.25}>
              <div className="mx-auto mt-9 max-w-md text-left">
                <NameYourAI />
              </div>
            </Reveal>

            <Reveal delay={0.3}>
              <p className="mt-6 text-fs2xs text-faint">
                No card required. Paper trading by default.
              </p>
            </Reveal>
          </div>
        </section>

        {/* --------------------------------------------------------------- Brief */}
        <section id="brief" className="scroll-mt-16 border-t border-border px-6 py-24">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <p className="text-fs2xs font-semibold uppercase tracking-wideTrack text-teal">
                Before you sign up
              </p>
              <h2 className="mt-4 max-w-3xl text-balance text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
                What you are actually getting.
              </h2>
              <p className="mt-4 max-w-2xl text-fsSm leading-normal2 text-muted">
                Six things, plainly. If none of them are what you came for, you will have
                found that out in under a minute rather than after creating an account.
              </p>
            </Reveal>

            <div className="mt-14 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {BRIEF.map((b, i) => (
                <Reveal key={b.title} delay={i * 0.05}>
                  <div className="h-full border-t border-border pt-6">
                    <span className="font-mono text-fs2xs text-teal">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <h3 className="mt-3 text-fsMd font-semibold text-navy">{b.title}</h3>
                    <p className="mt-3 text-fsXs leading-normal2 text-muted">{b.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
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

                    {/* The specifics. The card above says what the surface is
                        for; this says what is actually on it, which is the
                        half a prospective user needs to judge it. */}
                    <ul className="mt-5 space-y-2.5 border-t border-border pt-5">
                      {s.points.map((p) => (
                        <li key={p} className="flex gap-2.5 text-fs2xs leading-normal2 text-muted">
                          <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-teal" />
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  </article>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------------- Assistant */}
        {/* The mascot's own section. It appears three times on this page on
            purpose — hero, here, and above the sign-up form — because it is the
            agent identity a user meets again as the floating trigger in every
            workspace once they are signed in (`components/brand/MascotMark`).
            Introducing it once and dropping it would make that trigger read as
            an unrelated widget. */}
        <section id="assistant" className="scroll-mt-16 border-t border-border px-6 py-24">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <TaraGreeter onAuthIntent={goToAuth} />
            </Reveal>

            <div className="mt-4 grid gap-4">

              <div className="space-y-4">
                <Reveal>
                  <div className="rounded-2xl border border-border bg-card p-7">
                    <h3 className="text-fsMd font-semibold text-navy">Say where you want to go</h3>
                    <p className="mt-3 text-fsXs leading-normal2 text-muted">
                      “Open the option chain.” “Show my portfolio.” “Find my losing trades.”
                      Navigation is resolved directly to the screen or action — no model
                      round-trip, so it is instant. It can open anything your account is
                      entitled to reach, and a locked feature takes you to the same upgrade
                      screen a click would, never to a dead end.
                    </p>
                  </div>
                </Reveal>

                <Reveal delay={0.06}>
                  <div className="rounded-2xl border border-border bg-card p-7">
                    <h3 className="text-fsMd font-semibold text-navy">Or ask what you are looking at</h3>
                    <p className="mt-3 text-fsXs leading-normal2 text-muted">
                      Anything that is not a command goes to a specialist that knows the
                      screen you are on — the chart, the chain, your holdings. Answers cite
                      how recent the data is and how confident the read is, and every one of
                      them ends up back in your hands to act on or ignore.
                    </p>

                    <ul className="mt-6 grid gap-x-8 gap-y-4 border-t border-border pt-6 sm:grid-cols-2">
                      {AI_AGENTS.map(([name, job]) => (
                        <li key={name}>
                          <span className="text-fs2xs font-semibold text-teal">{name}</span>
                          <p className="mt-1 text-fs2xs leading-normal2 text-muted">{job}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Reveal>

                <Reveal delay={0.12}>
                  {/* Amber, not red: this is a deliberate limit, not a failure
                      state — and red/green stay reserved for market direction
                      (DESIGN-SYSTEM.md §1). Mirrors FloatingAI's refusal card. */}
                  <div className="rounded-2xl border border-amber bg-amber-bg p-7">
                    <h3 className="text-fsMd font-semibold text-text">Where it stops</h3>
                    <p className="mt-3 text-fsXs leading-normal2 text-muted">
                      The assistant cannot place, modify or cancel an order. Not with a
                      confirmation dialog, not behind a toggle, not with your permission —
                      the capability does not exist in the system. It cannot tell you what to
                      buy, name a price target, or reach another user’s data. Every response
                      it gives carries the same line: observations only, never investment
                      advice.
                    </p>
                  </div>
                </Reveal>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ Sentinel */}
        <section id="sentinel" className="scroll-mt-16 border-t border-border px-6 py-24">
          <div className="mx-auto max-w-5xl">
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full border border-border2 px-3 py-1 text-fs2xs uppercase tracking-wideTrack text-amber">
                Premium
              </span>
              <h2 className="mt-5 text-balance text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
                Sentinel asks the question you won’t.
              </h2>
              <p className="mt-4 max-w-2xl text-fsSm leading-normal2 text-muted">
                Research answers “what does this mean?”. Sentinel answers “am I about to do
                something I’ll regret?” — reading market structure and your own trading
                behaviour together, in the background, while you work.
              </p>
            </Reveal>

            <Reveal delay={0.06} className="mt-12">
              <div className="rounded-2xl border border-border bg-card p-7">
                <p className="text-fs2xs font-semibold uppercase tracking-wideTrack text-faint">
                  What an observation sounds like
                </p>
                <p className="mt-4 text-fsSm leading-normal2 text-text">
                  “Price has broken above resistance, but volume is below the 20-day average
                  and open interest is declining. This resembles a low-conviction breakout.
                  Consider waiting for confirmation.”
                </p>
                <p className="mt-4 text-fs2xs leading-normal2 text-faint">
                  Evidence first, then the pattern it resembles, then a soft suggestion.
                  Never “don’t buy this”.
                </p>
              </div>
            </Reveal>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Reveal delay={0.1}>
                <div className="h-full rounded-2xl border border-border bg-card p-7">
                  <h3 className="text-fsMd font-semibold text-navy">Corroboration, not triggers</h3>
                  <p className="mt-3 text-fsXs leading-normal2 text-muted">
                    Each signal below is a piece of evidence, not a verdict. Sentinel only
                    raises something when several of them agree — a breakout <em>and</em> thin
                    volume <em>and</em> falling open interest — which is why it stays quiet
                    most of the day instead of crying wolf every hour.
                  </p>
                  <ul className="mt-5 flex flex-wrap gap-1.5">
                    {TRAP_SIGNALS.map((t) => (
                      <li
                        key={t}
                        className="rounded-full border border-border2 px-2.5 py-1 text-fs2xs text-muted"
                      >
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>

              <Reveal delay={0.14}>
                <div className="h-full rounded-2xl border border-border bg-card p-7">
                  <h3 className="text-fsMd font-semibold text-navy">Show me why</h3>
                  <p className="mt-3 text-fsXs leading-normal2 text-muted">
                    Every card opens into the evidence behind it: the readings it drew on,
                    how confident it is, and what kind of signal it was — structural or
                    behavioural. Nothing arrives as an assertion you are asked to take on
                    faith, and any reading without a real signal behind it is reported as
                    unavailable rather than filled in.
                  </p>
                  <p className="mt-5 rounded-xl border border-border2 px-4 py-3 text-fs2xs leading-normal2 text-muted">
                    <b className="text-text">It is never a gate.</b> Sentinel comments in
                    parallel with your order flow. It cannot block, delay or veto a trade,
                    and it never sees your order before you place it.
                  </p>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ Learning */}
        <section id="learning" className="scroll-mt-16 border-t border-border px-6 py-24">
          <div className="mx-auto max-w-5xl">
            <Reveal>
              <h2 className="text-balance text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
                Learning that knows what you just did.
              </h2>
              <p className="mt-4 max-w-2xl text-fsSm leading-normal2 text-muted">
                A full curriculum, in ordered paths rather than a shelf of unrelated
                videos — and reachable from inside the session, when the concept is the one
                you actually need.
              </p>
            </Reveal>

            <Reveal delay={0.06}>
              <ul className="mt-12 flex flex-wrap gap-2">
                {CURRICULUM.map((c) => (
                  <li
                    key={c}
                    className="rounded-xl border border-border bg-card px-4 py-2.5 text-fsXs text-text"
                  >
                    {c}
                  </li>
                ))}
              </ul>
            </Reveal>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Reveal delay={0.1}>
                <div className="h-full rounded-2xl border border-border bg-card p-7">
                  <h3 className="text-fsMd font-semibold text-navy">Nothing is published unchecked</h3>
                  <p className="mt-3 text-fsXs leading-normal2 text-muted">
                    Lessons are not written ad hoc. Each one traces back to a validated
                    concept, historical example or backtest result, and superseded versions
                    are archived rather than deleted — so what you learned last month is
                    still there to check against what changed.
                  </p>
                </div>
              </Reveal>
              <Reveal delay={0.14}>
                <div className="h-full rounded-2xl border border-border bg-card p-7">
                  <h3 className="text-fsMd font-semibold text-navy">Education, not a signal service</h3>
                  <p className="mt-3 text-fsXs leading-normal2 text-muted">
                    A case study explains what happened and why it happened. It will not tell
                    you that a pattern means buy now — the Learning Hub speaks in the same
                    observation-only voice as the rest of the platform, because the alternative
                    is a recommendation wearing a lesson’s clothes.
                  </p>
                </div>
              </Reveal>
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

        {/* --------------------------------------------------------- Getting in */}
        <section id="start" className="scroll-mt-16 border-t border-border px-6 py-24">
          <div className="mx-auto max-w-5xl">
            <Reveal>
              <h2 className="text-balance text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
                What happens after you sign up.
              </h2>
              <p className="mt-4 max-w-2xl text-fsSm leading-normal2 text-muted">
                You are not dropped into a live terminal and left to work it out. A short
                setup runs once, and it exists so the platform knows enough about you to be
                useful on day one.
              </p>
            </Reveal>

            <ol className="mt-14 space-y-px">
              {ONBOARDING.map(([title, body], i) => (
                <Reveal key={title} delay={i * 0.05}>
                  <li className="flex flex-col gap-2 border-t border-border py-6 sm:flex-row sm:gap-8">
                    <div className="flex shrink-0 items-baseline gap-3 sm:w-72">
                      <span className="font-mono text-fs2xs text-teal">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <h3 className="text-fsMd font-semibold text-navy">{title}</h3>
                    </div>
                    <p className="text-fsXs leading-normal2 text-muted">{body}</p>
                  </li>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------------------------------------------------- Pricing */}
        <section id="pricing" className="scroll-mt-16 border-t border-border px-6 py-24">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <h2 className="text-balance text-center text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
                What it costs, in full.
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-center text-fsSm leading-normal2 text-muted">
                Listed here rather than behind a “contact us”, because you should be able to
                work out the bill before you hand over an email address.
              </p>
            </Reveal>

            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {PLANS.map((p, i) => (
                <Reveal key={p.name} delay={i * 0.05}>
                  <div
                    className={`flex h-full flex-col rounded-2xl border p-7 ${
                      p.highlight ? 'border-teal bg-card shadow-glowTeal' : 'border-border bg-card'
                    }`}
                  >
                    <h3 className="text-fsXs font-semibold uppercase tracking-wideTrack text-muted">
                      {p.name}
                    </h3>
                    <p className="mt-4 font-mono text-fs2xl font-extrabold text-navy">{p.price}</p>
                    <p className="mt-2 text-fs2xs leading-normal2 text-faint">{p.note}</p>
                    <ul className="mt-6 space-y-2.5 border-t border-border pt-6">
                      {p.points.map((pt) => (
                        <li key={pt} className="flex gap-2.5 text-fs2xs leading-normal2 text-muted">
                          <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-teal" />
                          <span>{pt}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Reveal>
              ))}
            </div>

            <Reveal delay={0.2}>
              <div className="mx-auto mt-10 max-w-3xl space-y-3 text-center">
                {/* Both of these are load-bearing honesty, not fine print. The
                    first is the §7 non-goal in SUBSCRIPTIONS.md; the second is
                    simply true — checkout is not built, and a pricing table that
                    let a reader assume otherwise would be misleading them. */}
                <p className="text-fs2xs leading-normal2 text-muted">
                  Placing an order is never gated by a plan. Paying unlocks intelligence
                  surfaces and content — never the ability to trade, which is the same at
                  every tier including free.
                </p>
                <p className="text-fs2xs leading-normal2 text-faint">
                  Payments are not switched on yet. Prices are published so you know what you
                  are walking towards; no account can be charged today.
                </p>
              </div>
            </Reveal>
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
              {/* This section is a summary. The full picture — including what is
                  NOT in place, which is the half a security section usually
                  omits — is /legal/security, and this line exists to send the
                  reader there rather than let four bullet points stand as the
                  whole answer. */}
              <p className="mt-8 text-fs2xs leading-normal2 text-faint">
                TradeW is built to SEBI and DPDP expectations for observation-only platforms,
                and holds no formal security certification — the{' '}
                <a
                  href="/legal/security"
                  className="rounded-sm text-teal underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  Security page
                </a>{' '}
                lists what is in place and what is still outstanding, rather than implying
                otherwise.
              </p>
            </Reveal>
          </div>
        </section>

        {/* ----------------------------------------------------------------- FAQ */}
        {/* Native <details>, not a JS accordion: every answer stays present in
            the markup and findable by browser search even before hydration —
            the same reason Reveal renders visible on the server. */}
        <section id="faq" className="scroll-mt-16 border-t border-border px-6 py-24">
          <div className="mx-auto max-w-3xl">
            <Reveal>
              <h2 className="text-balance text-fs2xl font-bold tracking-tightTrack text-navy sm:text-fs3xl">
                The questions worth asking first.
              </h2>
            </Reveal>

            <div className="mt-12 space-y-px">
              {FAQ.map((f, i) => (
                <Reveal key={f.q} delay={i * 0.04}>
                  <details className="group border-t border-border py-5">
                    <summary className="flex cursor-pointer list-none items-start gap-4 text-fsSm font-semibold text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                      <span className="flex-1">{f.q}</span>
                      <span
                        aria-hidden="true"
                        className="mt-0.5 shrink-0 text-fsMd font-normal text-teal transition-transform duration-panel group-open:rotate-45"
                      >
                        +
                      </span>
                    </summary>
                    <p className="mt-4 pr-8 text-fsXs leading-normal2 text-muted">{f.a}</p>
                  </details>
                </Reveal>
              ))}
            </div>
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
                {AUTH_COPY[authMode].heading}
              </h2>
              <p className="mt-4 text-fsSm leading-normal2 text-muted">{AUTH_COPY[authMode].sub}</p>
            </Reveal>

            <Reveal delay={0.08} className="mt-10">
              <AuthPanel mode={authMode} onModeChange={setAuthMode} />
            </Reveal>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
