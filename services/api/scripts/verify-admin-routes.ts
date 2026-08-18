/**
 * Enumerate the routes `AdminController` declares.
 *
 *   npm run verify:admin-routes -w @tradew/api
 *
 * Exists because "is the endpoint live?" is otherwise only answerable against a
 * running server, and a dev server that has not hot-reloaded returns 404 for a
 * route that is perfectly well defined. That ambiguity — route missing, or
 * server stale? — is what this removes.
 *
 * ## Why it reads decorator metadata instead of booting Nest
 *
 * The first version built a Nest application to walk the Express router. That
 * works, and it drags in the entire dependency graph behind `AdminController`
 * (Telemetry → LeaderElection, AdminGuard → Jwt, PaperExecution → Sim → EodSummary
 * → Mail …), so the probe becomes a second, drifting copy of `AppModule` — and
 * booting it for real would start schedulers and contend for the leader lease
 * with the running dev server.
 *
 * Route paths are plain decorator metadata on the class and its methods, which
 * is the thing actually being asked about. Reading it needs no container, no
 * database, no port and no lifecycle hook, so this cannot perturb anything.
 */
import 'reflect-metadata';
import { AdminController } from '../src/admin/admin.controller';

/** Nest's own metadata keys — the values `@Controller`/`@Get`/`@Post` write. */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

/** `RequestMethod` is a numeric enum; index maps to the verb. */
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** Routes this feature is responsible for. Any absence is a failure. */
const REQUIRED = [
  // Established by the paper-execution task.
  'GET /admin/execution/profiles',
  'GET /admin/execution/intents',
  'GET /admin/execution/stats',
  'GET /admin/execution/trace/:intentId',
  'GET /admin/execution/trace-by-order/:orderId',
  'POST /admin/execution/profiles/:id/enabled',
  'POST /admin/execution/profiles/:id/run',
  // Added by the account-binding task.
  'GET /admin/execution/accounts',
  'GET /admin/execution/profiles/:id/authorization',
  'POST /admin/execution/accounts/:userId/agent-trading',
  'POST /admin/execution/profiles',
];

function main() {
  const base = Reflect.getMetadata(PATH_METADATA, AdminController) as string | undefined;
  if (base == null) throw new Error('AdminController carries no @Controller path metadata.');

  const found = new Set<string>();
  const proto = AdminController.prototype as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    const handler = proto[key];
    if (typeof handler !== 'function') continue;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
    if (path == null || method == null) continue; // not a route handler
    const full = `/${base}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
    found.add(`${METHODS[method] ?? method} ${full}`);
  }

  const execution = [...found].filter((r) => r.includes('/execution')).sort();
  console.log(`AdminController declares ${found.size} routes; ${execution.length} under /execution:`);
  for (const r of execution) console.log('  ', r);

  console.log('\nRequired:');
  let missing = 0;
  for (const want of REQUIRED) {
    const ok = found.has(want);
    if (!ok) missing++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${want}`);
  }

  console.log(`\n${REQUIRED.length - missing}/${REQUIRED.length} required routes declared.`);
  // `exitCode`, not `exit()`: an explicit exit on Windows can terminate before
  // piped stdout has flushed, silently swallowing the whole report.
  process.exitCode = missing === 0 ? 0 : 1;
}

main();
