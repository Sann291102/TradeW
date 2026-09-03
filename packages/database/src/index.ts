/**
 * `@tradew/database` runtime exports.
 *
 * This package has always owned the Prisma schema and its migrations. It now
 * also owns the STORAGE FORMAT of one column — `BrokerCredential.accessToken` —
 * because the format of a column belongs with the schema that declares it, not
 * with whichever service happened to need it first.
 *
 * Both consumers import from here: `services/api` writes credentials,
 * `services/market-data` reads them for the feed bridge. One module, one
 * format, no chance of the two drifting into incompatible envelopes.
 */
export * from './credential-crypto';
export * from './migration-manifest';
