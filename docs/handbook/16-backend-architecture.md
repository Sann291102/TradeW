# Chapter 16 — Backend Architecture

**Status: 🟢 for `services/api` (90 files, 8 modules) and `services/sentinel`. 🟡 for `services/market-data`. 🔵 for rate limiting, background jobs, queues, tracing.**

---

## 16.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 20+ | LTS; native `fetch`; the whole stack is TypeScript |
| Framework | NestJS 10 | DI, guards, pipes, modules — the structure a growing service needs before it needs it |
| ORM | Prisma 5.22 | typed client generated from one schema; migrations as reviewable SQL |
| Database | PostgreSQL 16 + pgvector | one store for relational *and* vector data |
| Auth | `@nestjs/jwt` + bcryptjs | — |
| Validation | class-validator + class-transformer | declarative DTOs at the controller boundary |
| HTTP | Express (via `@nestjs/platform-express`) | — |

### 16.1.1 Why NestJS and not bare Express or Fastify

The honest answer is *structure*. Express gives you a router; every other decision — where does auth live, how do you compose middleware, how do you inject a database client, how do you test a service without a server — is yours to make and re-make.

NestJS's DI container is what makes the patterns in this handbook enforceable: `ServiceTokenGuard`, `CapabilityGuard`, and `ValidationPipe` are *declarative* and therefore auditable. You can grep for `@UseGuards` and know the protection surface. You cannot grep an Express app for "did someone remember the auth middleware on this route."

The cost is a heavier framework and decorator-based magic. For a service that will be read by a compliance reviewer, the trade favours the framework.

---

## 16.2 Module structure

```
services/api/src/
├── app.module.ts            composition root — imports every feature module
├── main.ts                  bootstrap: CORS, ValidationPipe, port
├── health.controller.ts     GET /health (unauthenticated, by design)
├── prisma/                  PrismaService — one client, module-scoped
├── auth/                    AuthGuard · AuthService · AuthController
├── entitlements/            EntitlementsService · CapabilityGuard · Controller
├── instruments/             search
├── market-data/             quote reads
├── knowledge/               vault viewer + KnowledgeGuard
├── sentinel/                proxy to services/sentinel
└── sim/                     the paper OMS (7 files — Chapter 11)
```

### 16.2.1 The module rules

| Rule | Reason |
|---|---|
| One module per bounded context | a module is the unit of extraction (§5.7) |
| A module exports only its service, never its repository | callers depend on behaviour, not on Prisma |
| Controllers are thin: validate → delegate → return | business logic in a controller cannot be reused or tested |
| Guards at the controller, never inside a service | the protection surface must be greppable |
| No cross-module imports of another module's internals | import the module, inject the exported service |

### 16.2.2 `PrismaService`

One `PrismaClient` instance, module-scoped, injected everywhere. Not a new client per service.

> ⚠️ Prisma opens a connection pool per client. Instantiating `new PrismaClient()` inside a service — a mistake that looks harmless — multiplies your connection count by the number of services and exhausts Postgres's `max_connections` under load.

---

## 16.3 Bootstrap

```ts
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',').map(s => s.trim()).filter(Boolean);
  const isProd = process.env.NODE_ENV === 'production';

  app.enableCors({
    origin: isProd
      ? allowedOrigins                                   // strict allowlist
      : (origin, cb) => cb(null,
          !origin ||                                     // non-browser tools
          allowedOrigins.includes(origin) ||
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)),
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(Number(process.env.PORT || 4000));
}
```

### 16.3.1 The environment-split CORS policy 🔒

Production gets a **strict allowlist**. Development additionally accepts any localhost port and requests with no `Origin` header, with the reasoning in the code:

> *"the web dev server uses a dynamic port … so the frontend can reach the API regardless of which port the dev server landed on."*

This is the right shape for an environment-dependent security control: **the permissive branch is unreachable in production**, gated on `NODE_ENV`, not on a config flag someone could set wrong. A single `origin: true` would have been one line and a genuine vulnerability.

### 16.3.2 `whitelist: true` is a security control, not a convenience 🔒

```ts
new ValidationPipe({ whitelist: true, transform: true })
```

**`whitelist: true` strips any property not declared on the DTO.** Without it, a request body carrying `{ symbol, side, quantity, userId: '<someone-else>' }` would pass an unknown `userId` straight into a service — and mass-assignment vulnerabilities are exactly this shape.

`transform: true` converts payloads into DTO class instances so `@IsEnum` and friends actually run against typed values.

---

## 16.4 API design

### 16.4.1 Conventions

| Convention | Example |
|---|---|
| Resource-noun paths | `/sim/orders`, `/entitlements/plans` |
| HTTP verbs carry the semantics | `POST` create, `GET` read, `PATCH` modify, `DELETE` cancel |
| Domain-prefixed, not versioned in the path | `/sim/*`, `/sentinel/*`, `/market-data/*` |
| Plural collections, singular by id | `/sim/orders`, `/sim/orders/:id` |
| Sub-resources for actions that are not CRUD | `POST /sim/positions/:id/exit` |
| Admin routes namespaced | `/entitlements/admin/*` |

**No `/v1` prefix.** The API has exactly one consumer (`apps/web`) shipped from the same repository at the same time. Versioning is a cost paid to support consumers you cannot deploy in lockstep, and we have none. The trigger to add it is `packages/sdk` shipping to external developers (Phase 3).

### 16.4.2 The full endpoint surface 🟢

**Auth** — `/auth`
```
POST   /signup              email + password → token pair
POST   /login               → token pair
POST   /refresh             rotate: revoke presented, issue new
POST   /logout              revoke (one token, or all sessions)
GET    /me                  profile
PATCH  /me                  update profile
GET    /preferences         all preferences
POST   /preferences/:key    upsert one (JSON value)
```

**Entitlements** — `/entitlements`
```
GET    /me                            effective capabilities
GET    /me/check/:capability          single check with reason
GET    /plans                         catalogue
POST   /admin/subscriptions           grant
POST   /admin/subscriptions/:id/cancel
POST   /admin/overrides               per-user grant/revoke with a reason
GET    /admin/users/:userId/capabilities
```

**Paper OMS** — `/sim` (Chapter 11 §11.11) — 11 endpoints

**Market data** — `/market-data`
```
GET    /quote/:instrumentId
GET    /quote-by-symbol/:symbol
GET    /quotes                        batch
GET    /indices
```

**Instruments** — `GET /instruments/search`

**Sentinel** — `/sentinel`
```
POST   /observe              the primary entrypoint
POST   /explain              explainability contract
POST   /brain/search
GET    /brain/strategy
GET    /observations
GET    /session-summary
GET    /journal
POST   /journal
```

**Knowledge** — `/knowledge` — `tree`, `file`, `recent`, `search`, `graph`, `activity`

**Health** — `GET /health` (unauthenticated)

### 16.4.3 Error shape

NestJS exceptions produce a consistent envelope. The `CapabilityGuard` extends it with domain context:

```json
{
  "statusCode": 403,
  "message": "Missing entitlement: sentinel",
  "capability": "sentinel",
  "reason": "quota_exhausted",
  "quota": { "metric": "ai_requests", "limit": 50, "used": 50, "period": "2026-07" }
}
```

**The `reason` and `quota` fields are what let the UI render the right screen** (Chapter 4 §4.17). A bare 403 tells the client to show a lock; this tells it *which* lock.

---

## 16.5 Authentication 🟢🔒

### 16.5.1 `AuthService`

```ts
async login(email: string, password: string, meta: RequestMeta = {}) {
  const user = await this.prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (!user) {
    await this.audit('user.login.failure', null, meta, { email: … });
    throw new UnauthorizedException('Invalid credentials');
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await this.audit('user.login.failure', user.id, meta);
    throw new UnauthorizedException('Invalid credentials');
  }
  await this.audit('user.login.success', user.id, meta);
  return this.issue(user.id, user.email);
}
```

Four properties worth naming:

| Property | Detail |
|---|---|
| **Uniform error message** 🔒 | Unknown email and wrong password both return `'Invalid credentials'` — no user enumeration |
| **Email normalised** | `.trim().toLowerCase()` on both write and read, so `Foo@Bar.com` and `foo@bar.com` are one account |
| **Both failure branches audited** ⚖️ | With the attempted email on the unknown-user branch, `null` userId — which is why `AuditEvent.userId` is nullable |
| **Audit before throw** | The `await this.audit(...)` precedes the exception, so a failed login is always recorded |

### 16.5.2 Refresh-token rotation 🔒

```ts
async refresh(refreshToken: string, meta) {
  const tokenHash = this.hash(refreshToken);
  const row = await this.prisma.refreshToken.findUnique({
    where: { tokenHash }, include: { user: true },
  });
  if (!row || row.revokedAt || row.expiresAt < new Date()) {
    await this.audit('session.refresh.failure', row?.userId ?? null, meta);
    throw new UnauthorizedException('Invalid refresh token');
  }
  await this.prisma.refreshToken.update({
    where: { id: row.id }, data: { revokedAt: new Date() },   // ← rotate
  });
  return this.issue(row.user.id, row.user.email);
}
```

| Property | Security value |
|---|---|
| **Stored hashed** (`tokenHash` `@unique`) | a database dump yields no usable sessions |
| **Rotated on every use** | a stolen token is valid for at most one refresh |
| **Revoked, not deleted** | leaves the audit trail intact — and enables reuse detection |
| **Three-way validity check** | not found · revoked · expired all fail identically |

🔵 **The gap: no reuse detection.** Because revoked rows are retained, a presented token that is already revoked is a strong signal of theft — the legitimate client and an attacker both hold it. The correct response is to revoke the entire token family and force re-authentication. The data is there; the logic is not. Tracked as SEC-1.

### 16.5.3 `AuthGuard`

```ts
canActivate(context: ExecutionContext): boolean {
  const header = context.switchToHttp().getRequest().headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new UnauthorizedException('Missing bearer token');
  try {
    req.user = this.jwt.verify(token);
    return true;
  } catch {
    throw new UnauthorizedException('Invalid token');
  }
}
```

Twenty lines. **`req.user.sub` is the only source of user identity in the entire codebase** — no controller ever reads a `userId` from a body or a query parameter. That single discipline eliminates the "user A operates on user B's account" class of bug outright.

> ⚠️ **Never accept a `userId` from the request.** If you find yourself writing `@Body() { userId }`, stop. It is in the token.

### 16.5.4 bcrypt cost

```ts
const passwordHash = await bcrypt.hash(password, 10);
```

Cost factor **10**. NFR-S2 specifies **≥12**. This is a real, small, non-urgent gap: cost 10 is roughly 4× faster to brute-force than cost 12.

The fix is a rehash-on-login migration — verify against the old cost, and if it is below target, rehash with the new cost and store. No mass migration, no forced password resets. Tracked as SEC-2.

---

## 16.6 Authorization

### 16.6.1 Two guards, composed

```ts
@UseGuards(AuthGuard, CapabilityGuard)
@RequiresCapability('sentinel')
@Post('observe')
observe(@Req() req, @Body() body: ObserveDto) { … }
```

Order matters: `AuthGuard` populates `req.user`; `CapabilityGuard` reads `req.user.sub`.

### 16.6.2 `CapabilityGuard`

```ts
async canActivate(context: ExecutionContext): Promise<boolean> {
  const capability = this.reflector.getAllAndOverride<string | undefined>(
    CAPABILITY_KEY, [context.getHandler(), context.getClass()],
  );
  if (!capability) return true;                       // no decorator → no check

  const userId = context.switchToHttp().getRequest().user?.sub;
  if (!userId) throw new UnauthorizedException('Capability check requires an authenticated user');

  const decision = await this.entitlements.check(userId, capability);
  req.entitlement = decision;                          // ← attached for handlers
  if (!decision.allowed) {
    throw new ForbiddenException({
      message: `Missing entitlement: ${capability}`,
      capability, reason: decision.reason,
      ...(decision.quota ? { quota: decision.quota } : {}),
    });
  }
  return true;
}
```

Three design details:

1. **`getAllAndOverride` checks the handler then the class** — a controller-level capability applies to every route, and a route-level one overrides it.
2. **The decision is attached to the request** (`req.entitlement`) so a handler that succeeded can still report remaining quota without a second lookup.
3. **The 403 body carries `reason` and `quota`** — the client can distinguish "start a trial" from "quota exhausted" from "payment failed."

### 16.6.3 RBAC 🔵

There are no roles today. `/entitlements/admin/*` endpoints exist and are protected by `AuthGuard` only.

> 🔒 **This is the most significant open security gap in the backend.** Any authenticated user can currently call the admin entitlement endpoints and grant themselves any capability. It is acceptable only because the platform has never been deployed. It is a **release blocker** for v0.8.

Specified design:

```prisma
model User { role String @default("user") }   // user | support | admin | superadmin
```

```ts
@UseGuards(AuthGuard, RolesGuard)
@RequiresRole('admin')
@Post('admin/overrides')
```

| Role | May |
|---|---|
| `user` | own data only |
| `support` | read any user's entitlements and audit trail; grant temporary overrides ≤7 days |
| `admin` | full entitlement and subscription administration |
| `superadmin` | role assignment, feature flags |

⚖️ Every admin action must write an `AuditEvent` with the acting user, the target user, and a mandatory reason. `EntitlementOverride` already requires `reason` and `grantedBy` — the pattern to follow.

### 16.6.4 The `KnowledgeGuard` 🟢

Dev-gated: the knowledge vault viewer serves filesystem content and is disabled outside development. A good example of a capability that should simply not exist in production rather than being permission-checked in production.

---

## 16.7 Service-to-service authentication 🔒

```ts
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.SERVICE_TOKEN;
    if (!expected) throw new UnauthorizedException('SERVICE_TOKEN not configured');
    const req = context.switchToHttp().getRequest();
    if (req.headers['x-service-token'] !== expected) {
      throw new UnauthorizedException('Invalid service token');
    }
    return true;
  }
}
```

| Property | |
|---|---|
| **Fails closed on missing config** | a misconfigured deployment is unreachable, not open |
| **Not applied to `/health`** | your orchestrator must be able to distinguish unhealthy from unauthorised |
| **Never an end-user JWT** | a compromised user token cannot reach an internal service |

🔵 **Two hardenings, in order:**
1. **Timing-safe comparison.** `!==` on strings is theoretically timing-attackable. `crypto.timingSafeEqual` is one line and removes the argument.
2. **mTLS** once infra supports it. The guard is the seam where that swap happens.

---

## 16.8 Rate limiting 🔵

**Status: not implemented.** A release blocker for v0.8 alongside RBAC.

### 16.8.1 The specified tiers

| Scope | Limit | Window | Rationale |
|---|---|---|---|
| Per IP, unauthenticated | 20 req | 1 min | signup/login abuse |
| Per IP, `POST /auth/login` | 5 req | 15 min | 🔒 credential stuffing |
| Per user, general | 300 req | 1 min | a terminal polls |
| Per user, `POST /sim/orders` | 60 req | 1 min | order spam |
| Per user, `POST /sentinel/observe` | 120 req | 1 min | expensive path |
| Per user, AI research | quota'd | `UsageCounter` | already modelled |

### 16.8.2 Design

Sliding window in Redis, applied as a global guard at `services/api`. **One place, per ARCH-1** — internal services need no rate limiting of their own because they are unreachable except through the ingress that already limits.

```
   Response headers on every limited route:
     X-RateLimit-Limit      300
     X-RateLimit-Remaining  247
     X-RateLimit-Reset      1721721600
   On breach: 429 + Retry-After
```

**The login limiter is the security-critical one** and must key on *both* IP and attempted email — IP-only is defeated by a botnet, email-only by rotating targets.

---

## 16.9 Caching 🟡

| Layer | Status | Where |
|---|---|---|
| In-process snapshot (2 s) | 🟢 | `MarketPriceService` |
| Quote hot cache | 🟢 | `packages/market-data` |
| Redis shared cache | 🔵 | — |
| HTTP `Cache-Control` | 🔵 | — |
| Entitlement decision cache | 🔵 | — |

### 16.9.1 The entitlement cache 🔵

`EntitlementsService.check()` runs up to three queries (override, subscriptions with grants, usage counter). It is called on **every guarded request**, which makes it the most frequently executed database work in the API.

```
   key    entitlement:{userId}:{capability}
   TTL    60 s
   bust   on subscription change, override change, plan change
```

**The bust list is the hard part**, and getting it wrong means a user who upgraded waits a minute for access — or, worse, a user whose subscription was cancelled keeps access. The 60 s TTL bounds the damage in the second case, which is why it is short.

**Never cache the quota branch.** `UsageCounter` is the thing being metered; a cached quota decision lets a user exceed their limit by the cache TTL times their request rate.

---

## 16.10 Background jobs 🟡

### 16.10.1 What runs today

| Job | Mechanism | Cadence |
|---|---|---|
| Order matching | `setInterval` + Nest lifecycle | 3 s |
| Sentinel research trigger | fire-and-forget on `/observe` | organic |
| Sentinel outcome learning | fire-and-forget on `/observe` | organic, batch of 5 |

### 16.10.2 ⚠️ The replica problem

```ts
onModuleInit() { this.timer = setInterval(() => void this.tick(), POLL_MS); }
```

**With N replicas of `services/api`, the matching engine runs N times**, each loading the same resting orders and racing to fill them.

The transaction boundaries mean a double-fill is unlikely rather than impossible — two ticks can both read an `OPEN` order before either updates it.

🔵 **The fix is a Redis leader lock:**

```
   every tick:  SET matching-engine:leader <instanceId> NX PX 10000
                → acquired or already-mine?  run the tick
                → someone else holds it?     skip
```

Ten lines. **A release blocker for any multi-replica deployment**, and currently invisible because the platform runs single-replica. Tracked as OPS-1.

### 16.10.3 The specified queue 🔵

```
   Redis Streams (not Kafka — Principle 7)

   PRODUCERS                    CONSUMERS
   services/api ──┐          ┌──► notification  (email/push/Slack)
   trading-engine ┼──► bus ──┼──► analytics     (recompute)
   market-data ───┘          ├──► sentinel      (observe, non-blocking)
                             └──► learning      (validation pipeline)

   Job types: email, push, EOD summary, report generation,
              historical backfill, ontology reseed, concept promotion review
```

### 16.10.4 The scheduler 🔵

The fire-and-forget piggyback pattern cannot do anything time-bound (Chapter 9 §9.8.4). Needed for: EOD session summaries (15:30 IST), overnight promotion review, weekly behavioural reports, stale-memory expiry.

**Design: a single leader-elected scheduler publishing to the queue; any instance consumes.** Never `@nestjs/schedule` on every replica — that runs the job N times, which is the §16.10.2 bug with a different name.

---

## 16.11 WebSockets and streaming 🔵

**Nothing is real-time today.** The frontend polls.

### 16.11.1 The specified architecture

```
   market-data (singleton)
        │  ticks
        ▼
   Redis pub/sub or Streams
        │
        ▼
   services/api  ◄── the ONLY thing a browser connects to (ARCH-1)
        │  · authenticates the connection (JWT on upgrade)
        │  · checks entitlement per subscription
        │  · filters to what THIS user subscribed to
        ▼
   SSE (quotes, observations) │ WebSocket (bidirectional, later)
        │
        ▼
   apps/web
```

### 16.11.2 Why SSE before WebSockets

| | SSE | WebSocket |
|---|---|---|
| Direction | server → client | bidirectional |
| Protocol | plain HTTP | upgrade |
| Reconnect | **automatic, built into the browser** | you write it |
| Proxy/CDN | just works | needs configuration |
| Auth | standard headers/cookies | custom handshake |

**Everything the terminal needs today is server → client**: quotes, observations, order updates, notifications. SSE gives all of it with automatic reconnection and no infrastructure work. WebSockets become justified when the client needs to *send* on the same channel — which, so far, it does not.

### 16.11.3 ⚖️ Entitlement on the stream, not just on connect

A subscription that lapses mid-session must stop delivering premium reasoning **at the next event**, not at the next page load. The check belongs in the fan-out, per event, not only in the upgrade handshake.

---

## 16.12 Logging 🟡

### 16.12.1 Today

NestJS's built-in `Logger`, plain text, per-class:

```ts
private readonly logger = new Logger(OrderService.name);
this.logger.error(`tick: failed to evaluate order ${order.id}`, err as Error);
```

### 16.12.2 The gap 🔵

Not JSON, no correlation id, no user context, no sampling. `ARCHITECTURE.md` §8 puts structured JSON logging **first** in the observability order precisely because it is *"trivial cost, immediate debugging value."*

```json
{
  "ts": "2026-07-23T09:16:04.221Z",
  "level": "error",
  "service": "api",
  "context": "OrderService",
  "correlationId": "01J...",
  "userId": "usr_...",
  "msg": "tick: failed to evaluate order",
  "orderId": "ord_...",
  "symbol": "NIFTY",
  "err": { "name": "…", "message": "…", "stack": "…" }
}
```

### 16.12.3 The log discipline that already exists 🟢

The *levels* are used correctly, which is rarer than it should be:

| Level | Used for | Example |
|---|---|---|
| `error` | ⚖️ compliance gaps, unexpected failures | audit write failure |
| `warn` | degraded-but-handled | historical similarity unavailable |
| *(silent)* | expected absence | `ProviderNotAvailableError` locally |

That third row is the mature one. Logging an expected condition on every request trains engineers to ignore the channel, and an ignored warning channel is worse than a silent one.

### 16.12.4 🔒 What must never be logged

```
   ❌ passwords, password hashes
   ❌ JWTs, refresh tokens, SERVICE_TOKEN
   ❌ API keys of any kind
   ❌ full request bodies on auth routes
   ❌ ⚖️ personal data beyond a user id (DPDP)
```

---

## 16.13 Observability 🔵

Build in this order — cheapest leverage first, because a plan that starts with a full ELK stack ends with no logging at all:

| # | Capability | Status | Effort |
|---|---|---|---|
| 1 | Structured JSON logging | 🔵 | low |
| 2 | Prometheus metrics + Grafana | 🔵 | medium |
| 3 | One Slack alert webhook | 🔵 | low |
| 4 | OpenTelemetry tracing | 🔵 | high |
| 5 | Log aggregation (Loki) | 🔵 | medium |

### 16.13.1 The first metrics to add

```
   http_request_duration_seconds{method,route,status}   histogram
   http_requests_total{method,route,status}             counter
   db_query_duration_seconds{model,operation}           histogram
   sim_orders_total{type,status}                        counter
   sim_matching_tick_duration_seconds                   histogram
   sim_resting_orders                                   gauge
   entitlement_checks_total{capability,allowed,reason}  counter
   auth_events_total{event}                             counter
```

`entitlement_checks_total` by `reason` is the highest-value business metric in the list — it shows, per capability, exactly how many users are hitting each kind of wall.

### 16.13.2 What pages 🔵

| Alert | Threshold | Severity |
|---|---|---|
| ⚖️ audit write failures | > 0 | **page** |
| API 5xx rate | > 1% for 5 min | **page** |
| Postgres unreachable | any | **page** |
| Market feed down during session | > 60 s | **page** |
| Matching engine tick failures | > 10% for 5 min | page |
| API p95 latency | > 500 ms for 10 min | ticket |
| Sentinel fallback rate | > 20% | ticket |

**Only the first four page.** Everything else degrades gracefully and can wait for business hours. An alerting policy that pages for degradation trains people to ignore pages.

---

## 16.14 Backend debt

| ID | Debt | Severity | Fix |
|---|---|---|---|
| SEC-1 | No refresh-token reuse detection | medium | revoke the family on a revoked-token presentation |
| SEC-2 | bcrypt cost 10 vs. NFR-S2's 12 | low | rehash on login |
| SEC-3 | **No RBAC — admin endpoints open to any authenticated user** | **critical** | `RolesGuard` + `User.role` |
| SEC-4 | No rate limiting | **high** | Redis sliding window at the ingress |
| SEC-5 | `ServiceTokenGuard` uses `!==`, not timing-safe compare | low | `crypto.timingSafeEqual` |
| OPS-1 | Matching engine has no leader lock | **high** (multi-replica) | Redis `SET NX PX` |
| OPS-2 | Logging is not structured | medium | `packages/shared` logger |
| OPS-3 | No metrics, no tracing | medium | Prometheus, then OTel |
| OPS-4 | No boot-time config validation (TD-2) | medium | `packages/shared` config loader |
| API-1 | No OpenAPI spec | low | `@nestjs/swagger`; unblocks `packages/sdk` |
| API-2 | No entitlement decision cache | low | Redis, 60 s, explicit bust list |

**SEC-3, SEC-4, and OPS-1 are release blockers for the first deployment.** They are listed here rather than buried in Chapter 19 because they are backend structure, not security policy — and because a chapter that describes a well-built module without naming its three critical gaps would be marketing.

---

*Next: [Chapter 17 — Database](17-database.md)*
