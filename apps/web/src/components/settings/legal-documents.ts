/**
 * TradeW's legal and policy documents.
 *
 * ── READ THIS BEFORE EDITING ───────────────────────────────────────────────
 *
 * None of the text below has been reviewed by a lawyer. It exists so the
 * product has the right STRUCTURE — a document per policy, each at its own
 * URL, each linked from Settings — and so a reader can see what TradeW's
 * position on a topic will be. Every document therefore renders with an
 * "awaiting legal review" banner, and that banner is not decoration: it is the
 * accurate status.
 *
 * Two rules:
 *
 *  1. Do NOT claim compliance with a named regulation (SEBI, GDPR, DPDP Act,
 *     PCI-DSS, anything) here. A compliance claim is a legal representation,
 *     it has to be verified by someone qualified, and none of these have been.
 *     Where a regulation is relevant, the text says the question is open.
 *  2. Do NOT describe behaviour the software does not have. These documents
 *     describe TradeW as it actually is — a paper-trading and market-
 *     observation product — and the risk and AI disclosures in particular are
 *     the ones a user is most likely to rely on.
 *
 * When real legal copy arrives it replaces `body` and the reviewed flag flips.
 */

export interface LegalDocument {
  slug: string;
  title: string;
  /** One line, used on the cards in Settings. */
  summary: string;
  /**
   * Whether a qualified reviewer has approved this text. Every document is
   * false today. The banner is driven by this flag, so flipping it is a
   * deliberate act, not something that happens by editing prose.
   */
  reviewed: boolean;
  /** Sections, rendered in order. Plain text — no HTML, nothing injected. */
  body: Array<{ heading: string; paragraphs: string[] }>;
}

const OBSERVATION_ONLY =
  'TradeW is an observation and education product. Nothing it produces — including AI Sentinel output, research, learning material or any figure on any screen — is investment advice, a recommendation, or a solicitation to buy or sell any security.';

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    slug: 'user-agreement',
    title: 'User Agreement',
    summary: 'The terms that govern your use of TradeW.',
    reviewed: false,
    body: [
      {
        heading: 'What this agreement covers',
        paragraphs: [
          'This agreement governs your access to and use of TradeW: the web application, its APIs, and the intelligence products offered within it.',
          'By creating an account you accept these terms. If you do not accept them, do not use the service.',
        ],
      },
      {
        heading: 'What TradeW is',
        paragraphs: [
          OBSERVATION_ONLY,
          'Order placement in TradeW is PAPER trading. Orders are matched by a simulated engine against market data; they are not routed to an exchange, no money changes hands, and no position you hold in TradeW is a position in any real market.',
          'Where TradeW connects to a broker, that connection is used to read market data and account information. Any change to that scope would be a material change to this agreement.',
        ],
      },
      {
        heading: 'Your account',
        paragraphs: [
          'You are responsible for keeping your credentials secure and for activity that occurs under your account. Tell us immediately if you believe your account has been accessed by someone else.',
          'One person, one account. Do not share credentials or use another person’s account.',
        ],
      },
      {
        heading: 'Acceptable use',
        paragraphs: [
          'Do not attempt to disrupt the service, circumvent its limits, extract data at a scale the interface does not offer, or use it to break the law or the rules of any exchange or broker.',
        ],
      },
      {
        heading: 'Termination',
        paragraphs: [
          'You may stop using TradeW at any time. We may suspend or terminate access where these terms are broken or where continuing to serve an account would be unlawful or unsafe.',
        ],
      },
      {
        heading: 'Open items',
        paragraphs: [
          'Governing law, dispute resolution, limitation of liability and warranty disclaimers are not stated here. They require legal drafting and are deliberately absent rather than guessed at.',
        ],
      },
    ],
  },
  {
    slug: 'privacy-policy',
    title: 'Privacy Policy',
    summary: 'What TradeW collects about you, and why.',
    reviewed: false,
    body: [
      {
        heading: 'What we collect',
        paragraphs: [
          'Account identity: your email address, and — if you choose to use them — a linked Google identity or a verified phone number.',
          'Profile and preferences: the onboarding answers you give (experience level, options familiarity, country) and the settings you save.',
          'Activity on your account: paper orders, fills, positions, holdings, journal entries, learning progress and notifications.',
          'Technical records: request logs including IP address and user agent, and security events such as sign-ins and password changes. These exist so that "what happened to my order" and "was that sign-in me" have answers.',
        ],
      },
      {
        heading: 'Why we collect it',
        paragraphs: [
          'To operate your account, to run the paper-trading engine, to produce the observations and analysis you ask for, to secure the account, and to diagnose failures.',
        ],
      },
      {
        heading: 'Third parties',
        paragraphs: [
          'Market data, news and broker connectivity are provided by third parties. Requests TradeW makes on your behalf reach those providers.',
          'The exact list of processors, what each receives, and where each stores it has not been compiled for publication. That work is outstanding and this document does not claim otherwise.',
        ],
      },
      {
        heading: 'Your data',
        paragraphs: [
          'You can export your account data from Settings → Privacy & Security. That export is built from the endpoints your account can already read; it does not include internal server-side logs, which are not exposed to account holders.',
          'Account deletion is not yet available in the product. Settings → Privacy & Security says so plainly rather than offering a control that does nothing.',
        ],
      },
      {
        heading: 'Open items',
        paragraphs: [
          'Retention periods, the legal basis for each category of processing, cross-border transfer arrangements, and rights under any specific data-protection regime are not stated here and have not been assessed.',
        ],
      },
    ],
  },
  {
    slug: 'risk-disclosure',
    title: 'Risk Disclosure',
    summary: 'Trading and investing involve risk. Read this one.',
    reviewed: false,
    body: [
      {
        heading: 'Trading involves risk of loss',
        paragraphs: [
          'Trading and investing in securities, derivatives, currencies and digital assets carries a substantial risk of loss. You can lose more than your initial outlay in leveraged and derivative positions. Past performance does not indicate future results.',
        ],
      },
      {
        heading: 'Derivatives',
        paragraphs: [
          'Options and futures are leveraged instruments. A small move in the underlying can produce a total loss of premium, and a short option position can lose far more than the premium received. Understand the payoff and the margin requirement of a position before taking it.',
        ],
      },
      {
        heading: 'Paper results are not real results',
        paragraphs: [
          'TradeW fills orders in a simulated engine. Simulated fills do not include the queue position, partial fills, slippage, latency, liquidity constraints and rejections that a live order encounters. A strategy that is profitable on paper may not be profitable live.',
        ],
      },
      {
        heading: 'Nothing here is advice',
        paragraphs: [
          OBSERVATION_ONLY,
          'TradeW does not know your financial position, obligations or objectives, and nothing it shows is tailored to them. Decisions you take are yours. Consider taking advice from someone qualified and regulated to give it.',
        ],
      },
    ],
  },
  {
    slug: 'ai-disclosure',
    title: 'AI & Sentinel Disclosure',
    summary: 'What the AI does, what it cannot do, and where it can be wrong.',
    reviewed: false,
    body: [
      {
        heading: 'What AI Sentinel is',
        paragraphs: [
          'AI Sentinel observes market conditions and the strategies you have defined, and describes what it sees. It is an observer.',
          'It does not place orders on your behalf, and it does not accept buy or sell commands. That boundary is enforced in the software, not just stated here.',
        ],
      },
      {
        heading: 'How it can be wrong',
        paragraphs: [
          'Observations are generated by statistical models and language models. They can be confidently incorrect, can misread context, can lag the market, and can be affected by missing or delayed data.',
          'An observation is a prompt to look, not a conclusion to act on. Treat a confident-sounding statement about the market exactly as sceptically as you would treat one from a stranger.',
        ],
      },
      {
        heading: 'Your data and the models',
        paragraphs: [
          'Producing an observation may involve sending market context and details of the strategy being watched to a model provider. Credentials and passwords are never part of that context.',
        ],
      },
      {
        heading: 'Not advice',
        paragraphs: [OBSERVATION_ONLY],
      },
    ],
  },
  {
    slug: 'application-policy',
    title: 'Application Policy',
    summary: 'Platform rules and acceptable use.',
    reviewed: false,
    body: [
      {
        heading: 'Fair use',
        paragraphs: [
          'TradeW is rate-limited per account and per IP. Automating the interface to exceed those limits, or scraping market data through it for redistribution, is not permitted — the data is licensed to TradeW, not to you.',
        ],
      },
      {
        heading: 'Security',
        paragraphs: [
          'Do not probe, scan or test the security of the service without written permission. If you find a vulnerability, report it (Settings → Help & Support) rather than exploiting it.',
        ],
      },
      {
        heading: 'Content and conduct',
        paragraphs: [
          'Content you create in TradeW — journal entries, strategy descriptions, feedback — must be lawful. Do not use the service to harass anyone or to distribute malware.',
          'Community features are not built yet. When they exist, this policy will need moderation rules that it does not currently contain.',
        ],
      },
      {
        heading: 'Automation',
        paragraphs: [
          'Agent-driven paper trading is available only on accounts where it has been explicitly granted, and is recorded as a consent event with a timestamp. It is off by default and is never enabled by signing up.',
        ],
      },
    ],
  },
  {
    slug: 'data-policy',
    title: 'Data Policy',
    summary: 'How data is handled, stored and processed.',
    reviewed: false,
    body: [
      {
        heading: 'Where data lives',
        paragraphs: [
          'Account, trading and preference data is stored in TradeW’s primary database. Market data is fetched from providers and cached for short periods so that a provider outage does not blank a screen that was correct moments earlier.',
        ],
      },
      {
        heading: 'Credentials',
        paragraphs: [
          'Passwords are stored only as bcrypt hashes and are never logged. Broker access tokens are stored against your account and are never rendered in the interface.',
          'Session refresh tokens are stored as hashes; the value itself exists only in your browser.',
        ],
      },
      {
        heading: 'Access',
        paragraphs: [
          'Every API route that reads or writes account data is scoped to the authenticated user. There is no route that lets one account read or modify another’s preferences, orders or positions.',
          'Operator access to the admin surface requires both a per-user flag on the account and a separate operator token.',
        ],
      },
      {
        heading: 'Open items',
        paragraphs: [
          'Retention schedules, backup locations and deletion procedures are not documented here. They are outstanding engineering and legal work, and account deletion is not yet implemented in the product.',
        ],
      },
    ],
  },
  {
    slug: 'cookie-policy',
    title: 'Cookie Policy',
    summary: 'The one cookie TradeW sets, and what it is for.',
    reviewed: false,
    body: [
      {
        heading: 'What TradeW sets',
        paragraphs: [
          'TradeW sets a single cookie, `tw_auth`. It holds no value beyond its own presence: it exists so the server can decide, before rendering, whether to show the workspace or the landing page. It is not an identifier, it proves nothing, and forging it grants no access — every real authorisation decision is made against the bearer token.',
          'The Google sign-in flow sets a short-lived state cookie for the duration of that round trip.',
        ],
      },
      {
        heading: 'What else is stored in your browser',
        paragraphs: [
          'Your session token, your workspace layout and a copy of your chart colours are kept in browser storage, not cookies. They are cleared when you sign out.',
        ],
      },
      {
        heading: 'Third-party cookies',
        paragraphs: [
          'TradeW does not set advertising or cross-site tracking cookies. Whether embedded third-party content sets any has not been audited, and this document does not claim it has.',
        ],
      },
    ],
  },
];

export function findLegalDocument(slug: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((d) => d.slug === slug);
}
