/**
 * Cognition — the four-layer perceptor network.
 *
 *   L1 Perception    percept.ts   sensors, the registry, salience gating
 *   L2 Encoding      layers.ts    signatures + embeddings
 *   L3 Association   layers.ts    learned / semantic / graph activation
 *   L4 Consolidation layers.ts    promotion to memory, operator proposals
 *   weights.ts                    the learned parameters and the update rule
 *   network.ts                    the loop: forward pass + outcome feedback
 *   langchain-adapter.ts          structural LangChain interop, no dependency
 *
 * Read `network.ts` first — it is the only file that composes the others, and
 * its class comment explains why the forward and feedback halves live together.
 */

export * from './percept';
export * from './weights';
export * from './layers';
export * from './network';
export * from './langchain-adapter';
