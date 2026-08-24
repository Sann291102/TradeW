import { Injectable, Logger, RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * The static half of the system graph: the shape of the codebase, read out of
 * the thing that is actually running.
 *
 * ## Why the container and not a source scan
 *
 * A regex over `src/**` finds routes that were deleted, misses routes added by
 * a mixin, and cannot tell whether a controller is even wired into `AppModule`.
 * The Nest container knows exactly what booted: which modules resolved, which
 * controllers they own, which handlers those controllers declare, and which
 * guards each handler runs behind. That is the difference between "the repo
 * mentions this route" and "this API serves this route", and only the second
 * is worth drawing on an operations console.
 *
 * The same reasoning applies to tables: `Prisma.dmmf` is the schema the client
 * was generated from, including every relation, so the entity graph is read
 * rather than transcribed.
 *
 * ## What is read from disk, and why that is still real
 *
 * Three things have no runtime representation and are read from the repository
 * instead — the workspace manifest (which apps/services/packages exist), the
 * agent definitions (`agents/<system>/definitions.json`, the same files the AI
 * runtime loads), and the vault. All three are the *source* the platform boots
 * from, not a description of it. Each is read once and cached for the process
 * lifetime, because none of them can change without a restart.
 */

export type RouteAuth = 'public' | 'user' | 'capability' | 'admin' | 'operator' | 'internal';

export interface RouteInfo {
  /** `GET /admin/graph/overview` — the template, never a concrete URL. */
  method: string;
  path: string;
  controller: string;
  handler: string;
  module: string;
  /** The service (workspace package) the module belongs to. Always `api` here:
   *  this container is `services/api`. Other services are declared, not walked. */
  service: string;
  /** Coarse authentication/authorization posture, from the guards on the
   *  handler and its controller. See `authOf`. */
  auth: RouteAuth;
  /** Guard class names, in the order Nest will run them. */
  guards: string[];
  /** Capability required by `@RequiresCapability`, when one is declared. */
  capability?: string;
}

export interface ControllerInfo {
  name: string;
  module: string;
  service: string;
  basePath: string;
  routeCount: number;
}

export interface ModuleInfo {
  name: string;
  service: string;
  controllers: string[];
  providerCount: number;
  /** Names of the modules this module imports — a real dependency edge. */
  imports: string[];
}

export interface TableInfo {
  name: string;
  fieldCount: number;
  /** Related model names, from the DMMF relation fields. */
  relations: Array<{ to: string; field: string; list: boolean }>;
  /** Indexed/unique field names — a rough proxy for how hot the table is. */
  keyFields: string[];
}

export interface WorkspaceUnit {
  /** `web`, `api`, `ai-core` … the directory name. */
  name: string;
  kind: 'app' | 'service' | 'package';
  /** Declared package name, e.g. `@tradew/api`. */
  packageName: string;
  description?: string;
  /** Workspace siblings this unit depends on — a real `depends_on` edge. */
  dependsOn: string[];
}

export interface AgentInfo {
  name: string;
  system: string;
  description: string;
  tier?: string;
  guardrails: string[];
  allowedTools: string[];
}

/** Nest's own metadata keys. Same values the framework writes; see also
 *  `scripts/verify-admin-routes.ts`, which reads them for the same reason. */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const GUARDS_METADATA = '__guards__';
const CAPABILITY_METADATA = 'required_capability';

/** `RequestMethod` is a numeric enum; the index is the verb. */
const METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

@Injectable()
export class TopologyService {
  private readonly logger = new Logger(TopologyService.name);

  private routesCache: RouteInfo[] | null = null;
  private modulesCache: ModuleInfo[] | null = null;
  private controllersCache: ControllerInfo[] | null = null;
  private tablesCache: TableInfo[] | null = null;
  private workspaceCache: WorkspaceUnit[] | null = null;
  private agentsCache: AgentInfo[] | null = null;

  /** Repository root, resolved from this file's location at build output depth.
   *  `services/api/dist/(src/)graph` → four or five levels up. Both layouts
   *  exist (see services/api/tsconfig.json), so probe rather than assume. */
  private readonly repoRoot = resolveRepoRoot();

  constructor(private readonly modules: ModulesContainer) {}

  // ------------------------------------------------------------ the container

  /**
   * Every module the container resolved, with its real import edges.
   *
   * Anonymous/internal modules (Nest's own `InternalCoreModule`, and the
   * dynamic wrappers `forRoot` produces) are kept out: they are framework
   * plumbing, not this platform's structure, and drawing them buries the nine
   * modules an operator cares about under twenty they cannot act on.
   */
  nestModules(): ModuleInfo[] {
    if (this.modulesCache) return this.modulesCache;
    const out: ModuleInfo[] = [];
    for (const module of this.modules.values()) {
      const name = module.metatype?.name;
      if (!name || isFrameworkModule(name)) continue;
      out.push({
        name,
        service: 'api',
        controllers: [...module.controllers.values()]
          .map((wrapper) => wrapper.metatype?.name)
          .filter((n): n is string => Boolean(n)),
        providerCount: module.providers.size,
        imports: [...module.imports]
          .map((imported) => imported.metatype?.name)
          .filter((n): n is string => Boolean(n) && !isFrameworkModule(n)),
      });
    }
    this.modulesCache = out.sort((a, b) => a.name.localeCompare(b.name));
    return this.modulesCache;
  }

  controllers(): ControllerInfo[] {
    if (this.controllersCache) return this.controllersCache;
    this.buildRoutes();
    return this.controllersCache ?? [];
  }

  /**
   * Every HTTP route this API serves, as a route TEMPLATE.
   *
   * Templates, not URLs, for the same reason `ApiCallInterceptor` records
   * templates: `/market-data/quote/:symbol` is one node with traffic, while
   * `/market-data/quote/NIFTY` is a thousand nodes with one request each, and
   * the second drags identifiers onto a screen an operator reads casually.
   * That shared choice is also what lets route nodes JOIN to `ApiCallLog.path`
   * with no normalisation step in between.
   */
  routes(): RouteInfo[] {
    if (this.routesCache) return this.routesCache;
    this.buildRoutes();
    return this.routesCache ?? [];
  }

  private buildRoutes(): void {
    const routes: RouteInfo[] = [];
    const controllers: ControllerInfo[] = [];

    for (const module of this.modules.values()) {
      const moduleName = module.metatype?.name;
      if (!moduleName || isFrameworkModule(moduleName)) continue;

      for (const wrapper of module.controllers.values()) {
        const metatype = wrapper.metatype;
        if (typeof metatype !== 'function') continue;
        const controllerName = metatype.name;

        const basePath = normalisePath(
          (Reflect.getMetadata(PATH_METADATA, metatype) as string | undefined) ?? '',
        );
        const classGuards = guardNames(Reflect.getMetadata(GUARDS_METADATA, metatype));
        const classCapability = Reflect.getMetadata(CAPABILITY_METADATA, metatype) as string | undefined;

        let count = 0;
        const proto = metatype.prototype as Record<string, unknown> | undefined;
        if (proto) {
          for (const key of Object.getOwnPropertyNames(proto)) {
            if (key === 'constructor') continue;
            const handler = proto[key];
            if (typeof handler !== 'function') continue;

            const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
            if (sub === undefined) continue; // not a route handler
            const verbIndex = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;

            const handlerGuards = guardNames(Reflect.getMetadata(GUARDS_METADATA, handler));
            const guards = [...classGuards, ...handlerGuards];
            const capability =
              (Reflect.getMetadata(CAPABILITY_METADATA, handler) as string | undefined) ?? classCapability;

            routes.push({
              method: METHOD_NAMES[verbIndex ?? 0] ?? 'GET',
              path: joinPath(basePath, normalisePath(sub)),
              controller: controllerName,
              handler: key,
              module: moduleName,
              service: 'api',
              auth: authOf(guards, capability),
              guards,
              capability,
            });
            count += 1;
          }
        }

        controllers.push({
          name: controllerName,
          module: moduleName,
          service: 'api',
          basePath: basePath ? `/${basePath}` : '/',
          routeCount: count,
        });
      }
    }

    this.routesCache = routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    this.controllersCache = controllers.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------------------- prisma

  /**
   * Database tables and their real relations, from the generated client's DMMF.
   *
   * This is the schema the API is actually talking to — if a migration has not
   * been applied, the DMMF still describes what this process believes, which is
   * the honest thing to draw next to code that was compiled against it.
   */
  tables(): TableInfo[] {
    if (this.tablesCache) return this.tablesCache;
    try {
      const models = Prisma.dmmf.datamodel.models;
      this.tablesCache = models.map((model) => ({
        name: model.name,
        fieldCount: model.fields.length,
        relations: model.fields
          .filter((field) => Boolean(field.relationName))
          .map((field) => ({ to: field.type, field: field.name, list: field.isList })),
        keyFields: model.fields.filter((field) => field.isId || field.isUnique).map((field) => field.name),
      }));
    } catch (err) {
      // A client generated without DMMF (or not generated at all) must not take
      // the console down — the rest of the graph is still real.
      this.logger.warn(`prisma DMMF unavailable, table nodes omitted: ${String(err)}`);
      this.tablesCache = [];
    }
    return this.tablesCache;
  }

  // -------------------------------------------------------------- repository

  /**
   * The workspace manifest: which apps, services and packages exist, and which
   * of them depend on which.
   *
   * Read from each unit's own `package.json` rather than from a hand-kept list,
   * so a new service appears on the graph the first time it is committed.
   */
  async workspace(): Promise<WorkspaceUnit[]> {
    if (this.workspaceCache) return this.workspaceCache;
    const units: WorkspaceUnit[] = [];
    const groups: Array<{ dir: string; kind: WorkspaceUnit['kind'] }> = [
      { dir: 'apps', kind: 'app' },
      { dir: 'services', kind: 'service' },
      { dir: 'packages', kind: 'package' },
    ];

    for (const group of groups) {
      const base = path.join(this.repoRoot, group.dir);
      let entries: string[];
      try {
        entries = (await fs.readdir(base, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue; // group absent in this deployment (a service image ships one app)
      }
      for (const name of entries) {
        try {
          const raw = await fs.readFile(path.join(base, name, 'package.json'), 'utf8');
          const pkg = JSON.parse(raw) as {
            name?: string;
            description?: string;
            dependencies?: Record<string, string>;
          };
          units.push({
            name,
            kind: group.kind,
            packageName: pkg.name ?? name,
            description: pkg.description,
            dependsOn: Object.keys(pkg.dependencies ?? {})
              .filter((dep) => dep.startsWith('@tradew/'))
              .map((dep) => dep.replace('@tradew/', '')),
          });
        } catch {
          /* a directory without a package.json is not a workspace unit */
        }
      }
    }

    this.workspaceCache = units;
    return units;
  }

  /**
   * The agent roster — the same `agents/<system>/definitions.json` files the AI
   * runtime loads, so an agent on the graph is an agent that can actually run.
   */
  async agents(): Promise<AgentInfo[]> {
    if (this.agentsCache) return this.agentsCache;
    const out: AgentInfo[] = [];
    const base = path.join(this.repoRoot, 'agents');
    let systems: string[] = [];
    try {
      systems = (await fs.readdir(base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      this.agentsCache = [];
      return [];
    }

    for (const system of systems) {
      try {
        const raw = await fs.readFile(path.join(base, system, 'definitions.json'), 'utf8');
        const parsed = JSON.parse(raw) as { agents?: Array<Record<string, unknown>> };
        for (const agent of parsed.agents ?? []) {
          const name = typeof agent.name === 'string' ? agent.name : null;
          if (!name) continue;
          out.push({
            name,
            system: typeof agent.system === 'string' ? agent.system : system,
            description: typeof agent.description === 'string' ? agent.description : '',
            tier: typeof agent.tier === 'string' ? agent.tier : undefined,
            guardrails: Array.isArray(agent.guardrails) ? agent.guardrails.filter(isString) : [],
            allowedTools: Array.isArray(agent.allowedTools) ? agent.allowedTools.filter(isString) : [],
          });
        }
      } catch {
        /* a system directory without definitions is not an agent system */
      }
    }

    this.agentsCache = out;
    return out;
  }

  /**
   * External data providers this deployment is actually configured for.
   *
   * Presence of the credential is the test, not presence of the integration
   * code: an unconfigured provider is a code path that cannot run, and drawing
   * it as a live source would be the exact fabrication this graph forbids.
   * Only the variable NAME is ever read — never its value.
   */
  externalSources(): Array<{ id: string; label: string; env: string; configured: boolean; kind: string }> {
    const declared: Array<{ id: string; label: string; env: string; kind: string }> = [
      { id: 'dhan', label: 'Dhan (broker + market data)', env: 'DHAN_CLIENT_ID', kind: 'broker' },
      { id: 'nse', label: 'NSE India public datasets', env: 'NSE_BASE_URL', kind: 'exchange' },
      { id: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY', kind: 'llm' },
      { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY', kind: 'llm' },
      { id: 'google-ai', label: 'Google AI', env: 'GOOGLE_AI_API_KEY', kind: 'llm' },
      { id: 'fmp', label: 'Financial Modeling Prep', env: 'FMP_API_KEY', kind: 'fundamentals' },
      { id: 'binance', label: 'Binance', env: 'BINANCE_API_KEY', kind: 'crypto' },
      { id: 'razorpay', label: 'Razorpay', env: 'RAZORPAY_KEY_ID', kind: 'payments' },
      { id: 'resend', label: 'Transactional email', env: 'RESEND_API_KEY', kind: 'email' },
      { id: 'twilio', label: 'Twilio SMS', env: 'TWILIO_ACCOUNT_SID', kind: 'sms' },
    ];
    return declared.map((source) => ({
      ...source,
      configured: Boolean(process.env[source.env]?.trim()),
    }));
  }

  /** Where this process thinks the repository root is. Exposed for the vault
   *  reader and for diagnostics, not for building paths from user input. */
  get root(): string {
    return this.repoRoot;
  }
}

// ---------------------------------------------------------------------------
// pure helpers — unit-tested in graph.projection.spec.ts
// ---------------------------------------------------------------------------

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Framework and dynamic-module noise. Matched by name because that is all the
 * container exposes: Nest's internals are anonymous classes with stable names,
 * and third-party dynamic modules end in the same suffixes.
 */
export function isFrameworkModule(name: string): boolean {
  return (
    name === 'InternalCoreModule' ||
    name === 'DiscoveryModule' ||
    name.startsWith('Internal') ||
    name === 'JwtModule' ||
    name === 'ThrottlerModule'
  );
}

/** Strip leading/trailing slashes so segments can be joined unambiguously. */
export function normalisePath(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

export function joinPath(base: string, sub: string): string {
  const parts = [base, sub].filter((part) => part.length > 0);
  return `/${parts.join('/')}`;
}

export function guardNames(guards: unknown): string[] {
  if (!Array.isArray(guards)) return [];
  return guards
    .map((guard) => {
      if (typeof guard === 'function') return guard.name;
      if (guard && typeof guard === 'object') return guard.constructor?.name ?? null;
      return null;
    })
    .filter((name): name is string => Boolean(name));
}

/**
 * Reduce a guard stack to the posture an operator reasons about.
 *
 * Ordered most-privileged first: a route behind both `AuthGuard` and
 * `AdminAccessGuard` is an operator route, and calling it merely
 * "authenticated" on a security-review screen would understate it. The
 * fall-through is `public`, which is the correct default to display — a route
 * with no guards IS reachable unauthenticated, and that is exactly the fact
 * worth surfacing.
 */
export function authOf(guards: string[], capability?: string): RouteAuth {
  const has = (needle: string) => guards.some((name) => name.includes(needle));
  if (has('Control')) return 'internal';
  if (has('AdminAccess') || has('AdminGuard') || has('AdminToken')) return has('AdminToken') && !has('AdminAccess') ? 'operator' : 'admin';
  if (capability || has('Capability')) return 'capability';
  if (has('Auth')) return 'user';
  return 'public';
}

/**
 * Find the repository root by walking up from this file looking for the
 * workspace manifest.
 *
 * Probed rather than computed because the compiled output lives at two
 * different depths depending on which tsconfig produced it (dist/graph in
 * production, dist/src/graph under `nest start --watch` — see
 * services/api/tsconfig.json), and a hardcoded `../../../..` is silently wrong
 * in exactly one of them.
 */
function resolveRepoRoot(): string {
  let dir = __dirname;
  for (let up = 0; up < 8; up += 1) {
    try {
      const manifest = require(path.join(dir, 'package.json')) as { workspaces?: unknown };
      if (Array.isArray(manifest.workspaces)) return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: the process's own cwd. Wrong only if the API is started from
  // somewhere other than the repo, in which case the disk-backed sources
  // degrade to empty and say so rather than inventing entries.
  return process.cwd();
}
