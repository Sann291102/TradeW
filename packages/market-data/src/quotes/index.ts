/**
 * Last-valid-price primitives.
 *
 * The one answer to "what is this instrument worth right now" when the market
 * is shut, the feed is quiet, or the packet that just arrived carried nothing.
 * See last-price.ts for the invariant and the defect it ends.
 */
export * from './last-price';
export * from './last-price-store';
