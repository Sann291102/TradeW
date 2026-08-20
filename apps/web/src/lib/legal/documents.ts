/**
 * TradeW's legal and trust surface, as data.
 *
 * ── WHY THESE PAGES EXIST ──────────────────────────────────────────────────
 *
 * Before 2026-08-20 this repository contained no legal surface at all: no
 * privacy policy, no terms, no cookie policy, no risk disclosure, no disclaimer
 * page, no security page. For a platform that holds broker credentials and
 * publishes market observations to Indian F&O traders, that is not a missing
 * page — it is a missing boundary.
 *
 * ── WHAT THEY ARE BUILT FROM ───────────────────────────────────────────────
 *
 * Every factual claim below was taken from the implementation and can be
 * checked against it. Where the implementation does not support a claim the
 * page says so rather than reaching for the sentence a template would use:
 *
 *   · Encryption at rest is NOT claimed. `packages/database/prisma/schema.prisma`
 *     stores a broker `accessToken` in plaintext and says so in its own comment.
 *   · Authenticator-app 2FA is NOT claimed. A repository-wide grep for `totp`,
 *     `authenticator` and `otpauth` returns nothing; what exists is one-time
 *     codes over email and SMS (`services/api/src/auth/otp.service.ts`).
 *   · No certification, uptime figure, SLA or penetration-test result is
 *     claimed, because none exists.
 *   · No contact address is printed, because none is monitored. An unread
 *     address is worse than an absent one.
 *
 * The full audit, with the regulatory sources these documents are structured
 * against (SEBI's 2024–25 IA/RA amendments; the DPDP Rules, 2025, whose
 * substantive obligations commence 13 May 2027), is in
 * `docs/footer/LEGAL_SURFACE_REQUIREMENTS.md`.
 *
 * ── WHAT THEY ARE NOT ──────────────────────────────────────────────────────
 *
 * Not legal advice, and not final. Each document carries a `pendingReview`
 * note naming the professional review it still needs, rendered on the page
 * rather than hidden in a repository. §8 of the requirements document lists
 * which reviewer answers which question.
 *
 * ── EDITING RULES ──────────────────────────────────────────────────────────
 *
 * 1. Do not add a claim you cannot point at a file for.
 * 2. Do not remove a `pendingReview` note without the review having happened.
 * 3. Bump `effectiveDate` when the substance changes, not when a typo is fixed.
 * 4. The product posture is fixed and appears in several documents on purpose:
 *    TradeW provides observations and information; it does not provide
 *    investment advice; it does not guarantee outcomes; it does not represent
 *    that AI observations are always correct; it does not remove the risks of
 *    trading. Those five sentences are a compliance boundary, not copy.
 */

export type LegalBlock =
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  /** A boxed note. `outstanding` is used for a gap TradeW is admitting to. */
  | { kind: 'note'; tone: 'info' | 'outstanding'; text: string };

export interface LegalSection {
  /** Anchor id. Stable — footer and cross-links depend on these. */
  id: string;
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalDocument {
  slug: string;
  /** Full document title. */
  title: string;
  /** Short label for the legal-surface index and cross-links. */
  navLabel: string;
  /** <meta name="description">. */
  description: string;
  effectiveDate: string;
  /** One paragraph, above the fold: what this document says, in plain words. */
  summary: string;
  /** The professional review this document still needs. Rendered on the page. */
  pendingReview: string;
  sections: LegalSection[];
}

/** Repeated verbatim wherever the boundary has to be restated. */
const OBSERVATION_ONLY =
  'TradeW provides observations and information. TradeW does not provide investment advice, ' +
  'does not guarantee outcomes, does not represent that its AI observations are always correct, ' +
  'and does not remove the risks associated with trading.';

const disclaimer: LegalDocument = {
  slug: 'disclaimer',
  title: 'Disclaimer',
  navLabel: 'Disclaimer',
  description:
    'What TradeW is and is not. TradeW provides observations and information, never investment advice.',
  effectiveDate: '2026-08-20',
  summary:
    'TradeW is an information and observation platform. It is not an adviser, not a broker, and not a signal service. This page states that boundary in full, because every other page depends on it.',
  pendingReview:
    'Requires review by a SEBI-qualified adviser, specifically on whether the observation-only framing holds once observations are paid for.',
  sections: [
    {
      id: 'what-tradew-is',
      heading: 'What TradeW is',
      blocks: [
        { kind: 'p', text: OBSERVATION_ONLY },
        {
          kind: 'p',
          text: 'TradeW is a workspace for people who trade their own money. It brings market data, charts, research, a learning curriculum and AI-generated observations into one place. Every conclusion it reaches is presented with the evidence behind it, so that you can disagree with it.',
        },
      ],
    },
    {
      id: 'not-advice',
      heading: 'TradeW does not give investment advice',
      blocks: [
        {
          kind: 'p',
          text: 'No surface in TradeW issues a buy or sell instruction, publishes a price target, recommends a position size, or tells you what to hold. Sentinel, Tara and every other intelligence surface describe what they observe — "volume is below the 20-day average and open interest is declining" — and stop there.',
        },
        {
          kind: 'p',
          text: 'This is an architectural rule rather than a setting, and it is asserted by the test suite: the components that render Sentinel\'s readings are tested to fail if they name a recommendation. If you want a signal service, TradeW is not one.',
        },
        {
          kind: 'p',
          text: 'TradeW is not registered with the Securities and Exchange Board of India as an Investment Adviser or as a Research Analyst, and does not hold itself out as either. Nothing in the platform should be read as a personal recommendation. Decisions about your money are yours, and you are responsible for them.',
        },
      ],
    },
    {
      id: 'ai-limits',
      heading: 'The AI can be wrong',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW\'s observations are produced by automated systems reading market data. Those systems can be wrong, can be confidently wrong, and can be wrong in ways that look reasonable. An observation is a reading of the past and present, never a prediction of the future.',
        },
        {
          kind: 'ul',
          items: [
            'Model output may be incomplete, mistaken, or based on data that was itself late or wrong.',
            'A pattern the platform names may not repeat, and historical precedent is not a forecast.',
            'Confidence indicators describe the system\'s own certainty, not the probability of an outcome.',
            'Nothing produced by an AI surface has been reviewed by a human before you see it.',
          ],
        },
      ],
    },
    {
      id: 'no-execution',
      heading: 'TradeW does not trade for you',
      blocks: [
        {
          kind: 'p',
          text: 'No AI service in the platform can reach the order path. Orders result from your own manual action and pass the platform\'s own validation. Sentinel in particular runs alongside the order flow and can never place, block, delay or gate an order.',
        },
        {
          kind: 'p',
          text: 'TradeW is not a broker and does not execute trades. Where you connect a broker, the trading relationship is between you and that broker, on their terms.',
        },
      ],
    },
    {
      id: 'no-guarantee',
      heading: 'No guarantee of outcome',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW makes no representation that use of the platform will be profitable, that any observation will prove accurate, or that the service will be available when you need it. Past performance — yours, the market\'s, or a strategy\'s — does not indicate future results.',
        },
        {
          kind: 'p',
          text: 'Read the Risk Disclosure alongside this page. It is the more important of the two.',
        },
      ],
    },
  ],
};

const riskDisclosure: LegalDocument = {
  slug: 'risk-disclosure',
  title: 'Risk Disclosure',
  navLabel: 'Risk Disclosure',
  description:
    'The risks of trading equities and derivatives, and the specific ways TradeW cannot protect you from them.',
  effectiveDate: '2026-08-20',
  summary:
    'Trading can lose you money, and derivatives can lose you more money than you put in. This page states the risks plainly, including the ones specific to using a platform like this one.',
  pendingReview:
    'Requires review by a SEBI-qualified adviser on sufficiency for F&O, and on whether a signed acknowledgement should be required before derivative surfaces are used.',
  sections: [
    {
      id: 'capital-risk',
      heading: 'You can lose money',
      blocks: [
        {
          kind: 'p',
          text: 'Trading in securities involves risk of loss. Prices move against positions, sometimes quickly and sometimes without a reason visible beforehand. You should not trade with money you cannot afford to lose.',
        },
      ],
    },
    {
      id: 'derivatives',
      heading: 'Derivatives can lose more than you commit',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW\'s focus includes Indian index and equity futures and options. Derivatives are leveraged instruments, which means the loss on a position is not bounded by the amount you put up for it.',
        },
        {
          kind: 'ul',
          items: [
            'A written (short) option position has a loss that is theoretically unlimited.',
            'Leverage magnifies losses on the same terms it magnifies gains.',
            'Margin calls can force a position to be closed at the worst available price.',
            'Options lose value with time even when the underlying does not move against you.',
            'Illiquid strikes can be impossible to exit at a price near the last traded one.',
          ],
        },
      ],
    },
    {
      id: 'paper-vs-live',
      heading: 'Paper results do not transfer to live markets',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW puts you on simulated execution by default, and that is the right place to learn. It is not a rehearsal of live trading, and a paper track record should not be read as evidence that a strategy works.',
        },
        {
          kind: 'ul',
          items: [
            'Simulated orders fill at prices a real order might not have reached.',
            'Slippage, partial fills, rejections and queue position are not fully reproduced.',
            'Simulated trading has no emotional cost, and the emotional cost is a large part of live trading.',
            'Impact — the effect your own order has on the price — is not modelled.',
          ],
        },
      ],
    },
    {
      id: 'data-risk',
      heading: 'Market data can be late, gapped or wrong',
      blocks: [
        {
          kind: 'p',
          text: 'Prices, option chains and derived indicators reach TradeW through third-party providers and broker feeds. A feed can be delayed, can drop ticks, can reconnect having missed a move, or can be wrong. Anything computed from that data inherits the fault.',
        },
        {
          kind: 'p',
          text: 'Do not rely on TradeW as your only source of price truth for a decision that matters. Confirm with your broker before acting.',
        },
      ],
    },
    {
      id: 'availability-risk',
      heading: 'The platform can be unavailable',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW does not offer an availability guarantee and nothing in the platform currently measures one. Outages of TradeW, of a data provider, of your broker, or of your own connection can occur during market hours and can prevent you from seeing a position or acting on it.',
        },
        {
          kind: 'p',
          text: 'Because TradeW does not place trades on your behalf, an outage of TradeW does not by itself close or open a position. Your broker remains the venue of record, and their controls are the ones that will still be there.',
        },
      ],
    },
    {
      id: 'observation-risk',
      heading: 'Acting on an observation is your decision',
      blocks: [
        { kind: 'p', text: OBSERVATION_ONLY },
        {
          kind: 'p',
          text: 'An observation that turns out to be accurate does not make the next one accurate. A confidence indicator is not a probability of profit. See the Disclaimer for what the intelligence surfaces do and do not claim.',
        },
      ],
    },
  ],
};

const terms: LegalDocument = {
  slug: 'terms',
  title: 'Terms & Conditions',
  navLabel: 'Terms',
  description: 'The terms on which TradeW is offered and used.',
  effectiveDate: '2026-08-20',
  summary:
    'The agreement between you and TradeW: who may use it, what it does and does not do, what you are responsible for, and what happens when things go wrong.',
  pendingReview:
    'Requires review by commercial counsel on limitation of liability, governing law and jurisdiction. The contracting entity is not yet named — see the note in section 1.',
  sections: [
    {
      id: 'parties',
      heading: '1. Who these terms are between',
      blocks: [
        {
          kind: 'p',
          text: 'These terms govern your use of the TradeW platform. By creating an account or using the service you agree to them, together with the Privacy Policy, Cookie Policy, Risk Disclosure and Disclaimer, which form part of them.',
        },
        {
          kind: 'note',
          tone: 'outstanding',
          text: 'The contracting legal entity, its registered address and the governing jurisdiction are not yet stated here. That is a company-formation matter, not a drafting one, and it is tracked as an open item rather than filled with a placeholder.',
        },
      ],
    },
    {
      id: 'eligibility',
      heading: '2. Eligibility',
      blocks: [
        {
          kind: 'p',
          text: 'You must be at least 18 years old and legally capable of entering a contract. You must use TradeW only where it is lawful for you to do so, and you are responsible for compliance with the rules that apply to you — including any restrictions your employer or a regulator places on your trading.',
        },
      ],
    },
    {
      id: 'what-we-provide',
      heading: '3. What TradeW provides',
      blocks: [
        { kind: 'p', text: OBSERVATION_ONLY },
        {
          kind: 'p',
          text: 'TradeW is not a broker, is not an exchange, does not hold client funds or securities, and does not execute trades. Where you connect a broker, that relationship is between you and the broker, on their terms, and TradeW is not a party to it.',
        },
      ],
    },
    {
      id: 'your-account',
      heading: '4. Your account',
      blocks: [
        {
          kind: 'p',
          text: 'You are responsible for the security of your account and for everything done through it. Do not share your credentials. Tell us promptly if you believe your account has been accessed by someone else.',
        },
        {
          kind: 'p',
          text: 'One person, one account. Accounts are not transferable.',
        },
      ],
    },
    {
      id: 'acceptable-use',
      heading: '5. Acceptable use',
      blocks: [
        { kind: 'p', text: 'You agree not to:' },
        {
          kind: 'ul',
          items: [
            'Scrape, resell, redistribute or republish market data or platform content.',
            'Attempt to access accounts, data or systems that are not yours.',
            'Interfere with the platform\'s operation, or with other users\' use of it.',
            'Use the platform to give investment advice to others, or to present its output as advice.',
            'Use automated means to place orders or extract data other than as the platform expressly permits.',
          ],
        },
      ],
    },
    {
      id: 'subscriptions',
      heading: '6. Plans and payment',
      blocks: [
        {
          kind: 'p',
          text: 'A free account includes the workspace, market data, research and a daily allowance of simulated order executions. Paid plans unlock intelligence surfaces and learning content.',
        },
        {
          kind: 'p',
          text: 'Placing an order is never gated by a plan. Paying unlocks information, never the ability to trade — that is the same at every tier, including free.',
        },
        {
          kind: 'note',
          tone: 'info',
          text: 'Payments are not switched on. Prices are published so you know what you are walking towards; no account can be charged today. Refund, renewal and cancellation terms will be stated here before the first charge is possible, and no charge will be made under terms you have not seen.',
        },
      ],
    },
    {
      id: 'availability',
      heading: '7. Availability',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW is provided as it is and as it is available. No service level, uptime figure or response time is offered, because nothing in the platform currently measures one. Features may change, and surfaces marked as unfinished may change substantially.',
        },
      ],
    },
    {
      id: 'liability',
      heading: '8. Liability',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW is not liable for trading losses. Decisions about your money are yours, taken on your own judgement, and TradeW neither makes them nor executes them. To the extent permitted by law, TradeW is not liable for indirect or consequential loss, for lost profits, or for loss arising from data that was delayed, gapped or wrong.',
        },
        {
          kind: 'p',
          text: 'Nothing here limits liability that cannot lawfully be limited.',
        },
      ],
    },
    {
      id: 'termination',
      heading: '9. Suspension and termination',
      blocks: [
        {
          kind: 'p',
          text: 'You may stop using TradeW and close your account at any time. TradeW may suspend or close an account that breaches these terms, or where required by law. Where a paid plan is in force, unused paid time will be dealt with under the refund terms in force at that point.',
        },
      ],
    },
    {
      id: 'changes',
      heading: '10. Changes to these terms',
      blocks: [
        {
          kind: 'p',
          text: 'These terms may change. Where a change is material you will be told before it takes effect, and the effective date at the top of this page will move. Continuing to use TradeW after that date means the new terms apply.',
        },
      ],
    },
  ],
};

const privacy: LegalDocument = {
  slug: 'privacy',
  title: 'Privacy Policy',
  navLabel: 'Privacy',
  description:
    'What personal data TradeW collects, why, how long it is kept, and the rights you have over it.',
  effectiveDate: '2026-08-20',
  summary:
    'What TradeW collects, why it collects it, who it goes to, and how you get it back or get it deleted. Structured to the notice requirements of the Digital Personal Data Protection Rules, 2025.',
  pendingReview:
    'Requires review by privacy counsel competent in the DPDP Act 2023 and the DPDP Rules 2025, whose substantive obligations commence 13 May 2027. Notice completeness, the retention schedule, the transfer basis and the grievance mechanism are the specific questions.',
  sections: [
    {
      id: 'what-we-collect',
      heading: 'What we collect',
      blocks: [
        {
          kind: 'table',
          head: ['Category', 'Examples', 'Why'],
          rows: [
            ['Account', 'Email address, phone number, name', 'To create and secure your account, and to send one-time sign-in codes'],
            ['Profile', 'Experience level, risk profile, markets of interest, workspace preference', 'Set during onboarding so the platform is useful on day one, and so observations are framed for your stated risk posture'],
            ['Activity', 'Simulated orders, watchlists, strategies, learning progress, discipline limits', 'To operate the features you are using and to show you your own history'],
            ['Broker connection', 'Broker client identifier and an access token, where you connect a broker', 'To fetch your data from that broker at your instruction'],
            ['Technical', 'Request logs, device and browser information, error reports', 'To keep the service running and to investigate faults and abuse'],
          ],
        },
        {
          kind: 'p',
          text: 'TradeW does not collect your bank details. Payments are not switched on; when they are, card details will be handled by the payment provider and will not reach TradeW\'s systems.',
        },
      ],
    },
    {
      id: 'why-we-use-it',
      heading: 'Why we use it',
      blocks: [
        {
          kind: 'p',
          text: 'To provide the service you asked for, to keep your account secure, to meet legal obligations, and to make the platform better at what it does. Your trading behaviour is used to give you better observations, and for nothing else.',
        },
        {
          kind: 'p',
          text: 'TradeW does not sell personal data. TradeW does not use your data for advertising, and does not share it with advertising networks.',
        },
      ],
    },
    {
      id: 'consent',
      heading: 'Consent, and withdrawing it',
      blocks: [
        {
          kind: 'p',
          text: 'Where processing rests on your consent, that consent is asked for specifically, in plain language, and can be withdrawn. Withdrawing consent does not undo processing that already happened lawfully, and withdrawing consent for something the service depends on may mean the service can no longer be provided.',
        },
      ],
    },
    {
      id: 'sharing',
      heading: 'Who else sees it',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW depends on third parties to operate. Data reaches them only to the extent the function requires:',
        },
        {
          kind: 'table',
          head: ['Party', 'Function', 'What reaches them'],
          rows: [
            ['Broker (Dhan)', 'Market data and, where you connect an account, your broker data', 'The credentials and instructions needed for the connection you authorised'],
            ['Market data providers', 'Global market prices', 'No personal data — these are read-only price feeds'],
            ['Cloud hosting', 'Running the platform', 'Everything the platform stores, as its host'],
            ['Email and SMS providers', 'Delivering one-time codes and account mail', 'Your email address or phone number, and the message'],
            ['Payment provider', 'Not yet in use — payments are not switched on', 'Nothing today'],
          ],
        },
        {
          kind: 'note',
          tone: 'outstanding',
          text: 'A named sub-processor list, with the legal basis for any transfer outside India, is outstanding and will be published here. It is required before the DPDP Rules\' substantive obligations commence on 13 May 2027.',
        },
      ],
    },
    {
      id: 'retention',
      heading: 'How long it is kept',
      blocks: [
        {
          kind: 'p',
          text: 'Account and activity data is kept while your account is open. When you close your account it is deleted or anonymised, except where a legal obligation requires it to be retained for longer.',
        },
        {
          kind: 'note',
          tone: 'outstanding',
          text: 'A per-category retention schedule with specific periods is outstanding. Until it is published, treat the paragraph above as the operating rule rather than as a complete statement.',
        },
      ],
    },
    {
      id: 'security',
      heading: 'How it is protected',
      blocks: [
        {
          kind: 'p',
          text: 'Traffic is encrypted in transit. Sign-in codes are stored hashed, expire, and are rate-limited. Every request passes a single audited ingress that checks the caller before any data is read. The Security page states what is in place — and, just as importantly, what is not yet.',
        },
        {
          kind: 'note',
          tone: 'outstanding',
          text: 'Encryption at rest is not yet implemented across all stored credentials. This is stated plainly rather than glossed, and the Security page gives the detail.',
        },
      ],
    },
    {
      id: 'your-rights',
      heading: 'Your rights',
      blocks: [
        {
          kind: 'p',
          text: 'Under the Digital Personal Data Protection Act, 2023 and the Rules made under it, you have the following rights over your personal data:',
        },
        {
          kind: 'ul',
          items: [
            'Access — a summary of the personal data being processed and the processing activities.',
            'Correction — to have inaccurate or misleading data corrected, and incomplete data completed.',
            'Erasure — to have your personal data deleted, subject to any legal retention obligation.',
            'Grievance redressal — to raise a complaint about how your data has been handled, and to have it answered.',
            'Nomination — to nominate another person to exercise these rights on your behalf in the event of your death or incapacity.',
            'Complaint to the Data Protection Board of India, if a grievance is not resolved.',
          ],
        },
        {
          kind: 'p',
          text: 'Account and profile data can be viewed and corrected from your account settings today. Erasure is handled by closing your account.',
        },
        {
          kind: 'note',
          tone: 'outstanding',
          text: 'A named grievance officer, a monitored contact address and a stated response window are outstanding. Publishing an address that nobody reads would be worse than publishing none, so none is published until one is monitored. This is the single highest-priority open item on the legal surface.',
        },
      ],
    },
    {
      id: 'children',
      heading: 'Children',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW is not intended for anyone under 18 and accounts are not knowingly created for children. If you believe a child has created an account, tell us and it will be closed and the data deleted.',
        },
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to this notice',
      blocks: [
        {
          kind: 'p',
          text: 'This notice will change as the platform and the law do — the DPDP Rules were notified on 13 November 2025 and their substantive obligations commence on 13 May 2027. Material changes will be notified before they take effect, and the effective date at the top of this page will move.',
        },
      ],
    },
  ],
};

const cookies: LegalDocument = {
  slug: 'cookies',
  title: 'Cookie Policy',
  navLabel: 'Cookies',
  description:
    'Everything TradeW stores in your browser, what each item is for, and how long it lasts.',
  effectiveDate: '2026-08-20',
  summary:
    'Everything TradeW stores in your browser is there to make the product work — signing you in, keeping two tabs from displacing each other, and remembering your theme. There are no advertising cookies and no third-party tracking.',
  pendingReview:
    'Requires review by privacy counsel on whether consent is required for the functional preference item under the DPDP Rules.',
  sections: [
    {
      id: 'what-is-stored',
      heading: 'What is stored',
      blocks: [
        {
          kind: 'table',
          head: ['Item', 'Kind', 'Purpose', 'Lifetime', 'Essential'],
          rows: [
            ['tw_auth', 'Cookie', 'A valueless marker telling the app which pages to route you to. It is not a credential and proves nothing on its own.', 'Until you sign out', 'Yes'],
            ['tradew_token / tradew_refresh_token', 'Session storage', 'Your actual sign-in credential. Kept per browser tab so two accounts open in two tabs cannot displace each other.', 'Until the tab is closed', 'Yes'],
            ['tradew_tab_claimed', 'Session storage', 'Marks a tab as having taken its own session, so a sign-in elsewhere cannot change who this tab is signed in as.', 'Until the tab is closed', 'Yes'],
            ['tradew-workspace-v1', 'Local storage', 'Your theme and workspace layout, applied before the page paints so it does not flash.', 'Until you clear it', 'Functional'],
            ['tradew-trade-basket-v1', 'Local storage', 'The contents of your trade basket, so it survives a reload.', 'Until you clear it', 'Functional'],
          ],
        },
      ],
    },
    {
      id: 'what-is-not',
      heading: 'What is not stored',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW sets no advertising cookies, no cross-site tracking cookies, and no third-party analytics cookies. There is no analytics provider embedded in the web application at all.',
        },
        {
          kind: 'p',
          text: 'The payment provider\'s checkout script sets its own cookies while a payment is in progress. Payments are not switched on, so that script does not run today.',
        },
      ],
    },
    {
      id: 'managing',
      heading: 'Managing what is stored',
      blocks: [
        {
          kind: 'p',
          text: 'Your browser can clear all of it, and TradeW clears the session items when you sign out. Clearing the essential items signs you out; clearing the functional ones resets your theme and layout to their defaults. Nothing else breaks.',
        },
      ],
    },
  ],
};

const security: LegalDocument = {
  slug: 'security',
  title: 'Security',
  navLabel: 'Security',
  description:
    'What TradeW has in place to protect your account and your data — and what it does not yet have.',
  effectiveDate: '2026-08-20',
  summary:
    'What is actually implemented, stated without embellishment, followed by the gaps. A security page that overstates is the one page where overstating is unforgivable, so this one names what is missing.',
  pendingReview:
    'Requires sign-off from the security lead on every claim below, and a published disclosure route before the reporting section can be completed.',
  sections: [
    {
      id: 'in-place',
      heading: 'What is in place',
      blocks: [
        {
          kind: 'ul',
          items: [
            'Encryption in transit. All traffic is served over TLS, with strict transport security and insecure requests upgraded.',
            'A single audited ingress. Every request from the browser reaches one service that checks the caller before any data is read; the market-data bridge is not publicly addressable and its proxy forwards an explicit allowlist of read-only routes rather than everything it exposes.',
            'An enforced content security policy, including a default-src of self, no plugin content, a locked base URI, form submission restricted to this origin, and framing denied outright.',
            'One-time sign-in codes over email and SMS. Codes are stored hashed, expire in ten minutes, allow five attempts, cannot be requested repeatedly to widen the valid set, and reveal nothing about whether an account exists.',
            'Per-tab session isolation, so two accounts signed in on one device cannot displace each other.',
            'Google sign-in, for accounts that prefer it.',
            'A separate operator boundary. The administrative console is a different application with its own session and is not reachable from the trading workspace.',
            'No AI service can reach the order path — a security property as much as a product one.',
          ],
        },
      ],
    },
    {
      id: 'not-in-place',
      heading: 'What is not in place',
      blocks: [
        {
          kind: 'p',
          text: 'These are stated because you should be able to decide with the real picture, and because a page that listed only the first section would be misleading by omission.',
        },
        {
          kind: 'ul',
          items: [
            'Encryption at rest is not implemented for all stored credentials. Broker access tokens are currently stored unencrypted; the work needs a key-management decision and is tracked.',
            'There is no authenticator-app two-factor authentication. What exists is one-time codes over email and SMS. Where your broker requires its own two-factor step, that happens on the broker\'s site.',
            'TradeW holds no security certification. No ISO 27001, no SOC 2, no PCI DSS. None is claimed anywhere in the product.',
            'No independent penetration test has been published.',
            'The content security policy permits inline scripts, because the application framework injects them. This is a genuine limitation of the policy and is stated rather than hidden behind the policy\'s existence.',
            'No uptime or availability figure is offered, because nothing measures one.',
          ],
        },
      ],
    },
    {
      id: 'your-part',
      heading: 'What you can do',
      blocks: [
        {
          kind: 'ul',
          items: [
            'Use an email account you control and can recover, since sign-in codes go there.',
            'Do not share your account. Sign out on shared devices.',
            'Connect a broker only when you mean to. Nothing moves real money until you do.',
            'Treat any message asking for a TradeW code as an attack. Codes are never requested by a person.',
          ],
        },
      ],
    },
    {
      id: 'reporting',
      heading: 'Reporting a vulnerability',
      blocks: [
        {
          kind: 'note',
          tone: 'outstanding',
          text: 'There is currently no published route for reporting a security vulnerability to TradeW — no security address, no security.txt, and no public tracker. This is a real gap, it is the highest-priority open item on this surface, and it is stated here rather than papered over with an address nobody monitors. Until a route is published, please do not disclose a finding publicly; hold it until this page names a contact.',
        },
      ],
    },
  ],
};

const responsibleTrading: LegalDocument = {
  slug: 'responsible-trading',
  title: 'Responsible Trading',
  navLabel: 'Responsible Trading',
  description:
    'The limits TradeW gives you, how to use them, and the signs that trading has stopped being a decision.',
  effectiveDate: '2026-08-20',
  summary:
    'TradeW ships tools for setting your own limits before the market opens, because the moment you most need a limit is the moment you are least able to set one. This page explains them and says plainly when to stop.',
  pendingReview:
    'Requires review by product and counsel jointly, on the boundary between guidance and advice.',
  sections: [
    {
      id: 'tools',
      heading: 'What the platform gives you',
      blocks: [
        {
          kind: 'p',
          text: 'TradeW has a discipline surface, and it is not decoration. You can set a session budget and daily limits, and the platform will interrupt you when you cross them.',
        },
        {
          kind: 'ul',
          items: [
            'Session budgets — a loss figure for the day, decided before the day starts.',
            'Friction prompts — a deliberate pause when you are about to do something your own limits said you would not.',
            'Simulated execution by default, so practice costs nothing but time.',
            'A daily allowance on simulated orders in the free plan, which is itself a limit.',
          ],
        },
        {
          kind: 'p',
          text: 'These limits are yours. TradeW does not enforce them against your will, does not trade for you, and cannot stop you overriding them. What it can do is make sure the override is a decision rather than a reflex.',
        },
      ],
    },
    {
      id: 'practice-first',
      heading: 'Practise before you commit money',
      blocks: [
        {
          kind: 'p',
          text: 'You start on paper against live prices, and nothing you do can move real money until you connect a broker yourself. Use that. Read the Risk Disclosure on why paper results do not transfer cleanly — the difference is mostly psychological, and that is exactly the part worth learning about yourself.',
        },
      ],
    },
    {
      id: 'warning-signs',
      heading: 'Signs worth taking seriously',
      blocks: [
        {
          kind: 'ul',
          items: [
            'Increasing position size to recover a loss.',
            'Trading money set aside for something else, or money that is borrowed.',
            'Trading more often after a losing day rather than less.',
            'Hiding the size or frequency of your trading from people close to you.',
            'Being unable to stop for a day when you have decided to.',
            'Relief rather than judgement as the reason for entering a position.',
          ],
        },
        {
          kind: 'p',
          text: 'None of these is about skill. They are about a decision loop that has stopped closing, and more screen time makes them worse rather than better.',
        },
      ],
    },
    {
      id: 'getting-help',
      heading: 'If it has stopped being a decision',
      blocks: [
        {
          kind: 'p',
          text: 'Trading can become compulsive in the same way gambling can. TradeW is a trading platform and is not equipped to help with that — it is not a substitute for professional support, and nothing on this page is clinical guidance.',
        },
        {
          kind: 'p',
          text: 'If any of the signs above describe you, step away from the screen and talk to a doctor, a qualified counsellor, or a trusted person before your next session. Closing your TradeW account is always available to you and takes effect immediately.',
        },
      ],
    },
  ],
};

/**
 * Order matters: it is the order of the Legal & Trust footer column and of the
 * cross-link strip at the foot of every legal page. Disclaimer and Risk
 * Disclosure sit high because they are the two a trader most needs.
 */
export const LEGAL_DOCUMENTS: LegalDocument[] = [
  privacy,
  terms,
  cookies,
  riskDisclosure,
  disclaimer,
  security,
  responsibleTrading,
];

export const LEGAL_SLUGS = LEGAL_DOCUMENTS.map((d) => d.slug);

export function getLegalDocument(slug: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((d) => d.slug === slug);
}
