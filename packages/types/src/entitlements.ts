/**
 * Subscription & Entitlement domain (locked decision Q7, upgraded scope).
 *
 * Separation of concerns:
 *   Authentication  — who you are            (services/api auth module)
 *   Subscription    — what plan you're on    (this domain)
 *   Billing         — how you pay            (NOT built yet; adapters plug in later)
 *   Entitlements    — what features you get  (this domain, derived from plan + overrides)
 *   Usage limits    — how much you may use   (this domain, quota definitions)
 *   Permissions     — what actions you may take (auth guards, informed by entitlements)
 *
 * Access to any premium AI capability is decided by the centralized
 * EntitlementService — never by hardcoded plan checks at call sites.
 */

/** Capability keys — feature-level entitlements. Extend freely; never repurpose. */
export enum Capability {
  SENTINEL = 'sentinel',
  AI_RESEARCH = 'ai_research',
  NEURAL_BRAIN = 'neural_brain',
  ADVANCED_MARKET_INTELLIGENCE = 'advanced_market_intelligence',
  PORTFOLIO_INTELLIGENCE = 'portfolio_intelligence',
  PREMIUM_AGENTS = 'premium_agents',
  PAPER_TRADING = 'paper_trading',
}

/** Known plan codes. Plans are DB rows, not logic — these are just well-known ids. */
export enum PlanCode {
  FREE = 'free',
  TRADEW_PRO = 'tradew_pro',
  SENTINEL_PRO = 'sentinel_pro',
  TRADEW_ULTIMATE = 'tradew_ultimate',
  ENTERPRISE = 'enterprise',
}

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due' // payment failed, inside grace period
  | 'grace' // expired but within configured grace window
  | 'canceled'
  | 'expired';

export interface PlanCapabilityGrant {
  capability: Capability | string;
  /** optional usage quota attached to the grant (e.g. AI requests/day) */
  quota?: UsageQuota;
}

export interface Plan {
  id: string;
  code: PlanCode | string;
  name: string;
  description: string;
  grants: PlanCapabilityGrant[];
  /** days of trial offered on first subscribe; 0 = no trial */
  trialDays: number;
  /** days of grace after expiry before entitlements are cut */
  graceDays: number;
  active: boolean;
}

export interface UsageQuota {
  /** e.g. 'ai_requests', 'research_runs', 'observations' */
  metric: string;
  limit: number;
  period: 'day' | 'month' | 'billing_cycle';
}

export interface Subscription {
  id: string;
  userId: string;
  /** future: org/team subscriptions set organizationId instead */
  organizationId?: string | null;
  planId: string;
  status: SubscriptionStatus;
  startedAt: Date;
  /** null = open-ended until canceled */
  expiresAt: Date | null;
  trialEndsAt: Date | null;
  canceledAt: Date | null;
  /** which billing provider manages it, once billing lands ('none' until then) */
  billingProvider: string;
  billingReference?: string | null;
}

/** Admin/manual grant that bypasses plan derivation (support cases, testing, promos). */
export interface EntitlementOverride {
  id: string;
  userId: string;
  capability: Capability | string;
  granted: boolean;
  reason: string;
  grantedBy: string;
  expiresAt: Date | null;
}

/** The resolved answer to "can this user use this capability right now?" */
export interface EntitlementDecision {
  userId: string;
  capability: Capability | string;
  allowed: boolean;
  /** why — for support, audit and UI upsell messaging */
  reason:
    | 'plan_grant'
    | 'trial'
    | 'grace_period'
    | 'override'
    | 'no_subscription'
    | 'plan_lacks_capability'
    | 'subscription_expired'
    | 'quota_exhausted'
    | 'override_revoked';
  quota?: { metric: string; limit: number; used: number; period: string };
  decidedAt: Date;
}

/**
 * Centralized entitlement check — the ONLY way any service decides premium access.
 * Sentinel calls this before every premium AI request.
 */
export interface EntitlementService {
  check(userId: string, capability: Capability | string): Promise<EntitlementDecision>;
  /** all capabilities the user currently holds (for UI feature flags) */
  capabilitiesOf(userId: string): Promise<(Capability | string)[]>;
  /** record usage against a quota metric (no-op if unmetered) */
  recordUsage(userId: string, metric: string, amount?: number): Promise<void>;
}

/**
 * Billing integration boundary — a future Stripe/Razorpay adapter implements
 * this to drive subscription state. Nothing else in the system may mutate
 * subscriptions.
 */
export interface SubscriptionLifecycle {
  activate(userId: string, planCode: string, opts?: { trial?: boolean; expiresAt?: Date | null }): Promise<Subscription>;
  renew(subscriptionId: string, newExpiry: Date): Promise<Subscription>;
  markPastDue(subscriptionId: string): Promise<Subscription>;
  cancel(subscriptionId: string, atPeriodEnd?: boolean): Promise<Subscription>;
  expire(subscriptionId: string): Promise<Subscription>;
}
