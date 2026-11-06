/**
 * Who produced an order — a person or a Sentinel paper-execution agent — and
 * which side of the agent's trade it is.
 *
 * ## Derived, never stored
 *
 * `Order.executionIntentId` (the entry an agent submitted) and
 * `Order.exitOfIntentId` (the order that closed an agent's position) already
 * make "was this agent-generated?" a structural fact. This module only turns
 * those two links into the labels the order book shows. Adding a `source`
 * column would be a second copy of a fact the links already hold, and the two
 * would be able to disagree.
 *
 * Pure and dependency-free so the labelling rules can be asserted without a
 * database, like `applyFill`.
 */

export type OrderSource = 'AGENT' | 'MANUAL';
export type OrderRole = 'ENTRY' | 'EXIT';

/** Why an agent closed a position, as recorded on `ExecutionOutcome.exitReason`. */
export type AgentExitReason =
  | 'STOP'
  | 'TARGET'
  | 'TRAIL'
  | 'INVALIDATED'
  | 'SQUARE_OFF'
  | 'EMERGENCY'
  | 'EXPIRY'
  | 'PENDING'
  | (string & {});

export interface OrderAttributionInput {
  executionIntentId: string | null;
  exitOfIntentId: string | null;
  /** The profile behind the entry intent, when that relation was loaded. */
  entryIntent?: { profile: { name: string; agent: string }; outcome?: { exitReason: string } | null } | null;
  /** The profile behind the intent this order closes, when loaded. */
  exitIntent?: { profile: { name: string; agent: string }; outcome?: { exitReason: string } | null } | null;
}

export interface OrderAttribution {
  source: OrderSource;
  /** Sentinel agent identity, e.g. `sentinel-alpha`. Null for a manual order. */
  agent: string | null;
  /** The execution profile's display name. Null for a manual order. */
  profileName: string | null;
  /** ENTRY opens the agent's position, EXIT closes it. Null for a manual order. */
  role: OrderRole | null;
  /** Why the agent exited. Null for an entry or a manual order. */
  exitReason: string | null;
}

const MANUAL: OrderAttribution = { source: 'MANUAL', agent: null, profileName: null, role: null, exitReason: null };

export function attributeOrder(order: OrderAttributionInput): OrderAttribution {
  // An exit is checked first: an order can carry both links only if a future
  // change lets one order close one intent while opening another, and the
  // exit is the more specific statement about what this order did.
  if (order.exitOfIntentId) {
    const intent = order.exitIntent;
    const reason = intent?.outcome?.exitReason ?? null;
    return {
      source: 'AGENT',
      agent: intent?.profile.agent ?? null,
      profileName: intent?.profile.name ?? null,
      role: 'EXIT',
      // PENDING means "nobody has recorded a reason yet" — showing it would
      // read as a reason in its own right.
      exitReason: reason && reason !== 'PENDING' ? reason : null,
    };
  }
  if (order.executionIntentId) {
    const intent = order.entryIntent;
    return {
      source: 'AGENT',
      agent: intent?.profile.agent ?? null,
      profileName: intent?.profile.name ?? null,
      role: 'ENTRY',
      exitReason: null,
    };
  }
  return { ...MANUAL };
}

/** The Prisma `include` that loads exactly what `attributeOrder` reads. */
export const ATTRIBUTION_INCLUDE = {
  executionIntent: { select: { profile: { select: { name: true, agent: true } } } },
  exitOfIntent: {
    select: { profile: { select: { name: true, agent: true } }, outcome: { select: { exitReason: true } } },
  },
} as const;

/** Adapter from the Prisma row shape (`executionIntent` / `exitOfIntent`) to the
 *  helper's input, so callers do not repeat the field renames. */
export function attributionOf(row: {
  executionIntentId: string | null;
  exitOfIntentId: string | null;
  executionIntent?: OrderAttributionInput['entryIntent'];
  exitOfIntent?: OrderAttributionInput['exitIntent'];
}): OrderAttribution {
  return attributeOrder({
    executionIntentId: row.executionIntentId,
    exitOfIntentId: row.exitOfIntentId,
    entryIntent: row.executionIntent,
    exitIntent: row.exitOfIntent,
  });
}
