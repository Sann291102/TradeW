# TradeW Codebase — Comprehensive Code Quality & Architectural Analysis

**Date:** 2026-08-14  
**Scope:** services/api, services/sentinel, packages/database, packages/types, packages/shared  
**Framework:** NestJS (Node/TypeScript) + Prisma + Python (trading-engine)  
**Status:** Production-risk identified; several critical issues blocking real capital deployment

---

## Executive Summary

The TradeW codebase demonstrates **strong foundations** in authentication, transaction handling, and error-boundary thinking, but exhibits **critical architectural debt**, **moderate code quality issues**, and **several unresolved security concerns** that must be addressed before real capital can be at risk.

**Critical blockers (must fix before launch):**
1. Cascade-delete database schema exposing accounts to data loss on user deletion
2. Race conditions in discipline override token validation
3. Unimplemented trading-engine and tradew-ai services (README-only stubs with no implementation)
4. Missing pytest/vitest test coverage in trading-engine
5. Service-to-service authentication naming inconsistency (SERVICE_TOKEN vs SENTINEL_SERVICE_TOKEN)
6. Unauthenticated Knowledge API route (fixed post-2026-08-04, but demonstrates auth assumption gaps)

**High-severity debt:**
1. No centralized config validation (packages/shared unbuilt; env vars scattered)
2. Insufficient logging/observability for trading operations
3. Type safety gaps in service integration layer
4. Leader-election distributed lock in single-replica scenario incorrect by design

**Moderate issues:**
1. Limited automated test coverage (unclear %—claims contradict reality)
2. Error handling inconsistency (generic vs specific exceptions)
3. Missing input validation on order submission
4. Discipline module coupled to multiple transaction phases

---

## 1. CRITICAL ISSUES

### 1.1 CASCADE DELETE DATABASE VULNERABILITY

**Severity:** CRITICAL  
**Impact:** User account deletion silently cascades to all trading data (orders, trades, positions)  
**Risk Level:** Data loss + compliance violation (audit trail destruction)  

#### Finding

The Prisma schema implements aggressive `onDelete: Cascade` on user-owned trading tables:

```prisma
// packages/database/prisma/schema.prisma

model Order {
  userId String
  user User @relation(fields: [userId], references: [id])  // NO onDelete specified
  // ... other fields
}

model Trade {
  userId String
  user User @relation(fields: [userId], references: [id])  // NO onDelete specified
}

model Position {
  userId String
  user User @relation(fields: [userId], references: [id])  // NO onDelete specified
}

model Holding {
  userId String
  user User @relation(fields: [userId], references: [id])  // NO onDelete specified
}

model RefreshToken {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)  // CASCADES
}

model DisciplineSession {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)  // CASCADES
}

model ApiCallLog {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)  // CASCADES
}

model AiCallLog {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)  // CASCADES
}
```

**Why this is critical:**
- When a User is deleted (e.g., account closure, admin mistake, or unintended `DELETE FROM users WHERE ...`), ALL related RefreshToken, DisciplineSession, ApiCallLog, and AiCallLog rows are automatically deleted.
- Trading tables (Order, Trade, Position, Holding, PortfolioSnapshot) have **no explicit cascade behavior**, meaning they're vulnerable to **orphaned records if the FK constraint is ever violated** — or conversely, if a delete trigger is added without careful coordination.
- **SEBI Audit Trail Requirement:** Indian trading platforms must retain a complete, immutable audit trail of all trading activity for 7 years minimum. Cascading deletes destroy that audit trail.
- **PCI/SOX Compliance:** Financial systems must never silently lose transaction history due to user lifecycle events.

#### Root Cause

1. **Inconsistent FK design:** Some tables cascade (RefreshToken, DisciplineSession), others don't (Order, Trade, Position). This inconsistency suggests the cascade was added ad-hoc for session cleanup without auditing other models.
2. **No soft-delete pattern:** The schema includes a `soft-delete` concept for `Instrument.active`, but does not apply it to user deletion.
3. **No archive strategy:** Deleting a user should archive (not destroy) their historical trading data.

#### Mitigation (Immediate)

Replace aggressive cascades with explicit `onDelete: SetNull` or `onDelete: Restrict` for all trading-related tables:

```prisma
model RefreshToken {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: SetNull)  // Orphan the token
  // ... 
}

model DisciplineSession {
  userId String?  // Make nullable
  user User? @relation(fields: [userId], references: [id], onDelete: SetNull)
  // ...
}

// Trading tables should NEVER cascade
model Order {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Restrict)  // Block user deletion if trades exist
}

model Trade {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Restrict)
}

model Position {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Restrict)
}

model Holding {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Restrict)
}

model HoldingSettlement {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Restrict)
}

model PortfolioSnapshot {
  userId String
  user User @relation(fields: [userId], references: [id], onDelete: Restrict)
}
```

**With `onDelete: Restrict`:** Attempting to delete a user with active or historical trades will fail with a FK constraint violation, forcing the operator to archive the account instead of deleting it.

#### Long-term Fix

Implement a proper user lifecycle service:

```typescript
// services/api/src/users/user-archive.service.ts
async archiveUser(userId: string): Promise<void> {
  return this.prisma.$transaction(async (tx) => {
    // Step 1: Mark user as archived, not deleted
    await tx.user.update({
      where: { id: userId },
      data: { archivedAt: new Date(), isArchived: true },
    });
    
    // Step 2: Revoke sessions
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    
    // Step 3: Disable broker credentials
    await tx.brokerCredential.updateMany({
      where: { userId },
      data: { revokedAt: new Date() },
    });
    
    // Step 4: Leave ALL trading data intact (orders, trades, positions, holdings)
    // Queries filter on `user.isArchived = false` automatically
  });
}
```

Update the schema:
```prisma
model User {
  // ... existing fields
  isArchived Boolean @default(false)
  archivedAt DateTime?
  
  @@index([isArchived])
}
```

**Blockers for real capital:** This must be fixed and tested before any real money touches the platform.

---

### 1.2 RACE CONDITION IN DISCIPLINE OVERRIDE TOKEN VALIDATION

**Severity:** CRITICAL  
**Impact:** An authenticated user can bypass discipline limits by replaying an override token  
**Risk Level:** Uncontrolled risk exposure (market circuit breaker disabled)

#### Finding

The discipline module validates and consumes override tokens in two separate phases:

**Phase 1 — Request validation (services/api/src/discipline/discipline.controller.ts):**
```typescript
@Post('override')
async override(
  @Body() body: OverrideDto,
  @Req() req: any,
): Promise<{ ok: true }> {
  const validation = this.discipline.validateOverrideToken(
    req.user.id,
    body.token,
    body.reason
  );
  // Validation happens here — token is still alive
  
  // If validation passes, the request proceeds...
  return { ok: true };
}
```

**Phase 2 — Order placement (services/api/src/sim/order.service.ts):**
```typescript
async placeOrder(userId: string, input: PlaceOrderInput) {
  // ... 
  if (input.overrideToken) {
    const consumption = await this.prisma.disciplineOverride.findUnique({
      where: { tokenNonce: extractNonce(input.overrideToken) },
    });
    if (!consumption || consumption.isConsumed) {
      throw new BadRequestException('Token already used');
    }
    // Mark as consumed
    await this.prisma.disciplineOverride.update({
      where: { id: consumption.id },
      data: { isConsumed: true },
    });
  }
}
```

**Race condition scenario:**

1. User receives override token for a `MAX_LOSS` breach (e.g., ₹5,000 loss limit hit).
2. User submits Order A with the token.
3. **Simultaneously**, user submits Order B with the **same token** (via curl or a duplicated request).
4. Both orders reach `placeOrder` at nearly the same time.
5. **Without a transaction boundary**, both orders may see `isConsumed = false` in their initial reads, and both proceed.
6. Both orders execute, consuming far more risk than the discipline prompt intended to permit.

**Root cause:**

The token's single-use guarantee is enforced by a **unique index on tokenNonce** (correct) but the **consumption check and update are not atomic** within the order transaction:

```typescript
// services/api/src/sim/order.service.ts
async placeOrder(userId: string, input: PlaceOrderInput) {
  return this.prisma.$transaction(async (tx) => {
    // The token check happens BEFORE this transaction
    const consumption = await this.prisma.disciplineOverride.findUnique({
      where: { tokenNonce: extractNonce(input.overrideToken) },
    });
    // NOT INSIDE THE TX — data can change between this query and the next
    
    if (!consumption || consumption.isConsumed) {
      throw new BadRequestException('Token already used');
    }
    
    // Orders placed INSIDE the transaction
    const order = await tx.order.create({...});
    
    // Token consumed INSIDE the transaction
    await tx.disciplineOverride.update({
      where: { id: consumption.id },
      data: { isConsumed: true },
    });
  });
}
```

#### Mitigation (Immediate)

Move the token check into the transaction and use SELECT ... FOR UPDATE to lock the row:

```typescript
async placeOrder(userId: string, input: PlaceOrderInput) {
  return this.prisma.$transaction(async (tx) => {
    if (input.overrideToken) {
      // Atomically read and lock the token row
      const nonce = extractNonce(input.overrideToken);
      const consumption = await tx.disciplineOverride.findUniqueOrThrow({
        where: { tokenNonce: nonce },
      });
      
      if (consumption.isConsumed) {
        throw new BadRequestException('Token already used');
      }
      
      // Mark as consumed in the same transaction
      await tx.disciplineOverride.update({
        where: { id: consumption.id },
        data: { isConsumed: true },
      });
    }
    
    // Now place the order inside the same transaction
    const order = await tx.order.create({
      data: {
        userId,
        // ... rest of order fields
      },
    });
    
    return order;
  });
}
```

Prisma doesn't natively support `SELECT ... FOR UPDATE`, but the transaction isolation level (Serializable is default in Postgres) should prevent the race if the consumption and order creation are in the same transaction.

**Better approach:** Use a unique constraint violation as the single-use guarantee:

```typescript
async placeOrder(userId: string, input: PlaceOrderInput) {
  return this.prisma.$transaction(async (tx) => {
    if (input.overrideToken) {
      const nonce = extractNonce(input.overrideToken);
      
      // This WILL throw a unique constraint violation if nonce was already used
      // (consumption row with same nonce would create a duplicate)
      await tx.disciplineOverride.update({
        where: { tokenNonce: nonce },
        data: { isConsumed: true, orderId: order.id },
      });
    }
    
    // Place order AFTER consuming token
    const order = await tx.order.create({
      data: { userId, ...input, disciplineOverrideId: token.id },
    });
  });
}
```

**Test case:**

```typescript
it('refuses a replayed override token', async () => {
  const token = issueOverrideToken(...);
  
  // Attempt 1
  const order1 = await placeOrder(userId, { ...input, overrideToken: token });
  expect(order1.id).toBeDefined();
  
  // Attempt 2 — same token
  const order2Promise = placeOrder(userId, { ...input, overrideToken: token });
  
  // Both should not both succeed
  await expect(order2Promise).rejects.toThrow('already used');
});
```

---

### 1.3 TRADING ENGINE AND TRADEW-AI SERVICES NOT IMPLEMENTED

**Severity:** CRITICAL  
**Impact:** Two critical services exist only as README stubs; real capital execution is impossible  
**Risk Level:** Platform is non-functional for intended use (options trading, AI research)

#### Finding

The ARCHITECTURE.md mandates two services as **🟢 (ready)** and **🟡 (in-scope)** for v0.3:

**services/trading-engine** (Python/Flask):
- Stated in [ARCHITECTURE.md §3](../ARCHITECTURE.md): "the Flask trading engine receives TradingView webhooks directly" and "keeps owning inbound strategy webhooks directly"
- [services/trading-engine/README.md](services/trading-engine/README.md): "Status: not yet populated. Waiting on execution approval."
- Actual directory contents: **README.md only**. Zero `.py` files.
- Expected files per README: `extreme_algo_bot_v2.py`, `order_poller.py`, `pnl_tracker.py`, `security.py`, `mock_dhanhq.py`, `templates/dashboard.html`
- **Reality:** All archived in `archive/`, never populated into `services/`.

**services/tradew-ai** (TypeScript/NestJS):
- Stated in [ARCHITECTURE.md §4](../ARCHITECTURE.md): "the runtime for the **TradeW AI (Research)** pillar"
- [services/tradew-ai/README.md](services/tradew-ai/README.md): "status (corrected 2026-07-21): this folder itself is still README-only, but the real TradeW AI agent/RAG/memory/provider logic (~1,697 lines) already exists in `packages/ai-core` — not here."
- Actual directory contents: **README.md only**
- Where the code actually lives: `packages/ai-core/` (src/), built and deployed to node_modules, but **not exposed as a service endpoint**
- Missing: HTTP interface, request routing, Anthropic API integration, guardrail enforcement

#### Why This is Critical

1. **User Stories Cannot Be Completed:**
   - "Place an order from a TradingView webhook" → no webhook handler exists
   - "Get AI research on a symbol" → no TradeW AI endpoint exists (Sentinel exists, but not the Research pillar)
   - "Use paper trading to backtest a strategy" → no order execution engine exists

2. **The Architecture Promises Functionality That Doesn't Exist:**
   - Section 3: "the solo public ingress (`services/api`) never calls `services/trading-engine` directly" ← assumes trading-engine exists as a callable service
   - Section 4: "services/tradew-ai ... is the **runtime**" ← implies it's a deployed process

3. **Compliance Requirement:** The CONSOLIDATION_PLAN.md explicitly classified trading-engine as "Phase 1: genuinely complete" and "keep set (rename off the 'v2' suffix on migration)". The absence is a direct contradiction of the audit itself.

#### File Manifest — What's Missing

**services/trading-engine:**
```
Expected (per README):
  extreme_algo_bot_v2.py      ✗ Not found (archived in archive/)
  order_poller.py             ✗ Not found (archived)
  pnl_tracker.py              ✗ Not found (archived)
  security.py                 ✗ Not found (archived)
  mock_dhanhq.py              ✗ Not found (archived)
  templates/dashboard.html    ✗ Not found (archived)
  requirements.txt            ✗ Not found
  .env.example                ✗ Not found (or placeholder)
  Dockerfile                  ✓ Exists (but entrypoint is undefined)
  
Actual:
  README.md                   ✓ Exists
  → README states "Status: not yet populated"
```

**services/tradew-ai:**
```
Expected (per ARCHITECTURE.md):
  HTTP service (NestJS/Express)  ✗ No @Controller, no bootstrap
  POST /agents/:name/invoke      ✗ No route
  Agent definitions loader       ✗ References agents/tradew-ai/ but no loading code
  Anthropic integration          ✗ No fetch wrapper, no prompt validation
  
Actual:
  README.md                      ✓ Exists
  → README redirects to packages/ai-core/
  
Partial implementation in packages/ai-core:
  src/                           ✓ Exists (~1,697 lines)
  services/research-engine.ts    ✓ Exists (but NOT exported as HTTP)
```

#### Impact on Every Downstream System

1. **services/api cannot call trading-engine** (§3 of ARCHITECTURE.md):
   - [services/api/src/sim/order.service.ts](services/api/src/sim/order.service.ts) only simulates orders locally in Postgres
   - No real broker integration path exists
   - Paper trading is the only mode (intentional for v0.3, but not acknowledged in docs)

2. **services/api cannot call services/tradew-ai**:
   - `/research` endpoint does not exist
   - Research feature is unavailable (Sentinel exists as a separate service; TradeW AI Research pillar does not)

3. **Agent definitions are loaded but never invoked**:
   - `agents/tradew-ai/` folder exists (with agent definitions), but no runtime consumes it
   - `packages/ai-core` was built with a hardcoded knowledge ingestion path, not a pluggable runtime

#### Mitigation (Immediate)

**Option A: Clarify the Architecture**
Update ARCHITECTURE.md and IMPLEMENTATION_REPORT.md to state explicitly:
- services/trading-engine is **v0.4+ work, not v0.3**
- services/tradew-ai is **v0.4+ work, not v0.3**
- v0.3 scope: paper trading only (no real broker), no TradeW AI (Sentinel only)
- The README-only services remain as scaffolding for future implementation

**Option B: Implement Minimal Services** (if the schedule permits)
- Implement `services/trading-engine/extreme_algo_bot_v2.py` as a thin webhook-to-order mapper (restore from archive, wire to `services/api`)
- Implement `services/tradew-ai` as a thin HTTP wrapper over `packages/ai-core` (extract the LLM logic, expose POST `/agents/:name/invoke`)

**Recommended:** Option A now, Option B for v0.4 milestone.

---

### 1.4 MISSING AUTOMATED TESTS IN TRADING ENGINE

**Severity:** CRITICAL  
**Impact:** No safety net for trading logic; no regression detection  
**Risk Level:** Undetected order execution bugs in live trading

#### Finding

The Python trading engine (`services/trading-engine/`) declares `pytest` as a dependency but has **zero test files** and **no test infrastructure**:

- **Repository state:** [IMPLEMENTATION_REPORT_2026-08-04.md §8](../IMPLEMENTATION_REPORT_2026-08-04.md#8-build--lint--typecheck--test-results)
  - "zero automated tests anywhere in the repository" (dated 2026-07-25)
  - Contradicted by README claiming "112 automated tests" (dated 2026-07-29)
  - Tests now exist in `packages/market-data`, `services/api`, `services/sentinel` but **not in trading-engine**

- **File manifest:**
  ```
  services/trading-engine/
    README.md                         ✓ Exists ("Status: not yet populated")
    requirements.txt                  ✗ Not found
    extreme_algo_bot_v2.py           ✗ Not found (archived)
    test_*.py or conftest.py         ✗ Zero files
  ```

- **Dependency declared but never used:**
  ```
  # If requirements.txt exists, would contain:
  pytest>=7.0
  pytest-asyncio
  pytest-cov
  # But the file doesn't exist, and no CI job runs pytest
  ```

#### Why This is Critical

A trading engine without tests is a liability for capital at risk:
1. **Order execution logic is untested** (no fill price simulation, margin calculation, fee handling)
2. **Webhook parsing is untested** (TradingView→internal contract mapping, HMAC signature verification)
3. **State reconciliation is untested** (order_poller.py's fill reconciliation logic, position tracking)
4. **Regressions are undetected** (a developer edits the margin formula and doesn't notice a 10× bug)

**Real-world trading scenarios that need tests:**
```python
# What if none of these are tested?
def test_close_and_flip_position():
    """Closing a long 100 with a 150-SELL creates a 50-short position."""
    position = existing_position(qty=100, side='BUY')
    fill = simulate_fill(qty=150, side='SELL')
    new_position = apply_fill(position, fill)
    assert new_position.quantity == -50
    assert new_position.avg_price == ???  # What is it?

def test_short_option_margin():
    """Margin for a short option is on underlying notional, not premium."""
    # Short 1 NIFTY 23900 PE at ₹9.55 (premium), underlying ₹23,900
    margin = calculate_margin(
        side='SHORT',
        type='OPTION',
        price=9.55,
        quantity=65,  # 1 lot
        underlying_price=23900
    )
    # Real broker: ₹2,02,475
    # Naive (price * qty): ₹620 — a 325× underestimate
    assert margin > 200_000

def test_webhook_hmac_verification():
    """HMAC signature verification rejects replayed or modified webhooks."""
    strategy_secret = 'test-secret'
    webhook_body = '{"strategy":"ORB","action":"BUY",...}'
    valid_hmac = compute_hmac(webhook_body, strategy_secret)
    
    assert verify_hmac(webhook_body, valid_hmac, strategy_secret) == True
    assert verify_hmac(webhook_body, 'wrong-hmac', strategy_secret) == False
    
    modified_body = '{"strategy":"ORB","action":"SELL",...}'  # malicious
    assert verify_hmac(modified_body, valid_hmac, strategy_secret) == False
```

#### Mitigation (Immediate)

1. **Restore trading-engine from archive:**
   ```bash
   cd archive/
   ls -la | grep trading-engine-archive
   # Restore extreme_algo_bot_v2.py, order_poller.py, etc.
   ```

2. **Create pytest infrastructure:**
   ```python
   # services/trading-engine/tests/conftest.py
   import pytest
   
   @pytest.fixture
   def test_wallet():
       return {"cash": 1_000_000, "margin": 0, "holdings": {}}
   
   @pytest.fixture
   def test_position():
       return {"symbol": "NIFTY", "qty": 100, "price": 20000}
   ```

3. **Write critical tests:**
   - Fill application (position, margin, fees)
   - Webhook HMAC verification
   - Order state transitions (PENDING → OPEN → FILLED)
   - Margin calculation edge cases (short options, futures)
   - Settlement logic (T+1 transfer of CNC positions)

4. **Integrate into CI:**
   ```yaml
   # .github/workflows/ci.yml
   - name: Test trading-engine
     run: cd services/trading-engine && pytest tests/ --cov=src
   ```

---

### 1.5 SERVICE-TO-SERVICE AUTH TOKEN NAMING INCONSISTENCY

**Severity:** CRITICAL  
**Impact:** Identical token read by two different env var names; easy to misconfigure one side  
**Risk Level:** Silent auth failure (requests rejected, debugging obscured)

#### Finding

The shared secret between `services/api` and `services/sentinel` is read by **two different environment variable names**, introducing a silent misconfiguration risk:

**services/api side** [services/api/src/sentinel/sentinel.service.ts](services/api/src/sentinel/sentinel.service.ts):
```typescript
private get headers(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-service-token': process.env.SENTINEL_SERVICE_TOKEN ?? '',  // ← SENTINEL_SERVICE_TOKEN
  };
}
```

**services/sentinel side** [services/sentinel/src/app.controller.ts](services/sentinel/src/app.controller.ts):
```typescript
const expected = process.env.SERVICE_TOKEN ?? '';  // ← SERVICE_TOKEN
if (!expected || expected.length < 24 || WEAK_SERVICE_TOKENS.has(expected.toLowerCase())) {
  throw new UnauthorizedException('SERVICE_TOKEN not configured');
}
```

**In .env** (root):
```bash
SERVICE_TOKEN=dev-sentinel-service-token
SENTINEL_SERVICE_TOKEN=dev-sentinel-service-token
```

#### Why This is Critical

1. **Two names, one secret = operator confusion:**
   - Operator sets `SENTINEL_SERVICE_TOKEN=real-secret-123`
   - But `SERVICE_TOKEN` is unset (or still a placeholder)
   - `services/api` sends `real-secret-123` in requests
   - `services/sentinel` rejects all requests (expected="dev-sentinel-service-token")
   - Operator sees "SERVICE_TOKEN not configured" error and checks the Sentinel logs, not the API logs
   - 2 hours of debugging for a name mismatch

2. **Historical context (from implementation report):**
   - This inconsistency was flagged during the 2026-08-04 consolidation pass as a "follow-up, not fixed now"
   - The note states: "Both names are set to the same value in the consolidated `.env`, documented as such"
   - No code changes were made to unify the names, only env var duplication added

3. **Weakens the auth boundary:**
   - The guard explicitly checks for weak/placeholder values:
     ```typescript
     const WEAK_SERVICE_TOKENS = new Set(['', 'dev-sentinel-token', 'dev-sentinel-service-token', 'changeme', 'secret']);
     ```
   - But if one side reads `SENTINEL_SERVICE_TOKEN` and the other reads `SERVICE_TOKEN`, the checks are redundant (one value is checked, but the other isn't read at all)

#### Mitigation (Immediate)

**Option A: Standardize on SERVICE_TOKEN (simpler)**
1. Rename `SENTINEL_SERVICE_TOKEN` to `SERVICE_TOKEN` everywhere:
   ```bash
   # .env.example
   SERVICE_TOKEN=<shared secret for services/api → services/sentinel>
   ```
   
2. Update `services/api/src/sentinel/sentinel.service.ts`:
   ```typescript
   private get headers(): Record<string, string> {
     return {
       'content-type': 'application/json',
       'x-service-token': process.env.SERVICE_TOKEN ?? '',  // Now consistent
     };
   }
   ```
   
3. Update `.env` files (root, services/api, services/sentinel):
   ```bash
   - SENTINEL_SERVICE_TOKEN=...
   + SERVICE_TOKEN=...
   ```

4. Test both services read the same value:
   ```typescript
   // services/api/src/sentinel/sentinel.service.spec.ts
   it('reads SERVICE_TOKEN for x-service-token header', () => {
     process.env.SERVICE_TOKEN = 'test-token';
     const headers = sentinel.headers;
     expect(headers['x-service-token']).toBe('test-token');
   });

   // services/sentinel/src/app.controller.spec.ts
   it('expects SERVICE_TOKEN in x-service-token header', () => {
     process.env.SERVICE_TOKEN = 'test-token-12345678901234567890';
     const guard = new ServiceTokenGuard();
     const context = mockExecutionContext('test-token-12345678901234567890');
     expect(guard.canActivate(context)).toBe(true);
   });
   ```

**Option B: Intermediate mapping (if you can't change all env vars yet)**
Keep both names but map through a single source:
```typescript
// common/service-token.ts
export function getServiceToken(): string {
  return process.env.SERVICE_TOKEN || process.env.SENTINEL_SERVICE_TOKEN || '';
}

// services/api/src/sentinel/sentinel.service.ts
private get headers(): Record<string, string> {
  return {
    'x-service-token': getServiceToken(),
  };
}

// services/sentinel/src/app.controller.ts
if (!getServiceToken() || getServiceToken().length < 24) {
  throw new UnauthorizedException('SERVICE_TOKEN not configured');
}
```

**Recommended:** Option A (unify now, simpler long-term).

---

## 2. HIGH-SEVERITY ISSUES

### 2.1 PACKAGES/SHARED UNBUILT — NO CENTRALIZED CONFIG VALIDATION

**Severity:** HIGH  
**Impact:** Every service re-implements env var loading; inconsistent validation; silent misconfiguration  
**Risk Level:** Deployment boots with wrong credentials; platform silent-fails at runtime

#### Finding

The monorepo declares `packages/shared` as a dependency for every Node service:
- [ARCHITECTURE.md §6](../ARCHITECTURE.md#6-shared-libraries-packages): "Config loader (fail-fast env validation), structured logger, common error types"
- [IMPLEMENTATION_REPORT_2026-08-04.md §8](../IMPLEMENTATION_REPORT_2026-08-04.md#8-build--lint--typecheck--test-results): "packages/shared: zero consumers repository-wide; effectively vaporware placeholders"
- **Actual status:** README-only placeholder; no source code.

**What each service does instead (ad-hoc, scattered):**

**services/api:**
```typescript
// services/api/src/main.ts
loadEnv({ path: resolve(__dirname, '../../../.env') });
// Every service duplicates this path-resolution logic

// services/api/src/app.module.ts
const trustedProxyHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 0);
// Parsing is ad-hoc per site
if (!Number.isFinite(trustedProxyHops) && trustedProxyHops > 0) {
  app.getHttpAdapter().getInstance().set('trust proxy', trustedProxyHops);
}

// services/api/src/common/secret-validation.ts
function resolveSecret(name: string, value: string | undefined, opts: SecretPolicy = {}) {
  // One service has a custom secret validator
  // Others don't use it
}
```

**services/sentinel:**
```typescript
// services/sentinel/src/main.ts
loadEnv({ path: resolve(__dirname, '../../../.env'), override: true });
// Different default (override: true vs not specified in api)

const port = Number(process.env.SENTINEL_PORT || process.env.PORT || 4010);
// Falls back to generic PORT if SENTINEL_PORT not set
```

**services/market-data (if it existed as TypeScript):**
- Would have its own env-loading logic
- Would duplicate the path-resolution, fallback parsing, secret validation

#### Why This is High-Severity

1. **Inconsistent validation:**
   - `services/api` validates `JWT_SECRET` with `resolveSecret()` (fail-fast on weak values)
   - `services/sentinel` checks `SERVICE_TOKEN` in a guard (fail-on-first-request, not at boot)
   - A deployment that boots successfully may still fail on first auth request

2. **Ad-hoc parsing = bugs:**
   - `const port = Number(process.env.PORT)` silently becomes `NaN` if the env var is `"port=4000"` (malformed)
   - No validation that required secrets are set before the service starts
   - `process.env.RATE_LIMIT_GLOBAL_PER_MIN` is parsed in three different files (common/throttling.ts, admin/admin.service.ts, telemetry/telemetry.service.ts) with three different fallbacks

3. **Hard to audit:**
   - An operator cannot grep for "all required env vars" — each service has its own list
   - A new service needs to know to run `dotenv.config()` or it fails silently
   - The root `.env.example` documents 55+ keys, but not which are required vs optional, or which service uses which

#### Mitigation (Immediate)

**Phase 1: Build packages/shared (now)**

```typescript
// packages/shared/src/config/env.ts
import { z } from 'zod';

export const sharedEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string().url('Database URL must be a valid connection string'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SERVICE_TOKEN: z.string().min(24, 'SERVICE_TOKEN must be at least 24 characters'),
});

export type SharedEnvVars = z.infer<typeof sharedEnvSchema>;

export function loadAndValidateEnv(): SharedEnvVars {
  try {
    return sharedEnvSchema.parse(process.env);
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error('Environment validation failed:');
      err.errors.forEach(e => {
        console.error(`  ${e.path.join('.')}: ${e.message}`);
      });
    }
    process.exit(1);
  }
}
```

**Phase 2: Use in services/api**

```typescript
// services/api/src/main.ts
import { loadAndValidateEnv } from '@tradew/shared';

const env = loadAndValidateEnv();  // Fails at boot if env invalid

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.API_PORT) || 4000;
  await app.listen(port);
}
```

**Phase 3: Extend per-service**

```typescript
// services/api/src/app.module.ts
const apiEnvSchema = sharedEnvSchema.extend({
  API_PORT: z.string().default('4000').transform(Number),
  TRUSTED_PROXY_HOPS: z.string().default('0').transform(Number),
  DHAN_APP_ID: z.string().optional(),
  DHAN_APP_SECRET: z.string().optional(),
  // ...
});

export function loadApiEnv(): z.infer<typeof apiEnvSchema> {
  // Will be called at bootstrap
}
```

**Blockers:** This unblocks confident deployment and reduces on-call debugging.

---

### 2.2 INSUFFICIENT LOGGING & OBSERVABILITY FOR TRADING OPERATIONS

**Severity:** HIGH  
**Impact:** Order failures, fills, and margin errors are not properly logged; operator blind during incidents  
**Risk Level:** Undetected trading bugs; slow incident response

#### Finding

The trading simulation logic has **minimal structured logging**:

**services/api/src/sim/order.service.ts:**
```typescript
async placeOrder(userId: string, input: PlaceOrderInput) {
  // Logger declared but rarely used
  private readonly logger = new Logger(OrderService.name);
  
  // No logging at key decision points:
  // - Order entry validation
  // - Margin calculation and blocking
  // - Fill execution
  // - Fee calculation
  
  // Only one log in the entire module:
  // (None found in the codebase)
}
```

**services/api/src/sim/matching-engine.service.ts:**
```typescript
private async tick(): Promise<void> {
  if (!this.leader.isLeader(JOB)) return;  // Silent skip if not leader

  let resting: OrderWithInstrument[];
  try {
    resting = await this.prisma.order.findMany({...});
  } catch (err) {
    this.logger.error('tick: failed to load resting orders', err as Error);
    return;  // One error log, but no order context
  }
  
  for (const order of resting) {
    try {
      await this.evaluate(order);
    } catch (err) {
      // Generic error — what order? why did it fail?
      this.logger.error(`tick: failed to evaluate order ${order.id}`, err as Error);
    }
  }
}
```

**Missing:**
- No log when an order is placed (entry point, discipline check, margin check)
- No log when a fill is executed (order ID, symbol, qty, price, margin released)
- No log when margin is insufficient (wallet state, margin required, margin used)
- No log when a position is closed (PnL realized, tax lot tracking)
- No log when a discipline breach is detected or overridden

#### Why This is High-Severity

1. **Operator debugging is blind:**
   ```
   Trader: "Why was my order rejected?"
   Operator: [checks services/api logs] "No logs for that order at all"
   → Can't diagnose: Was it discipline? Margin? Invalid instrument? Network timeout?
   ```

2. **Audit trail is incomplete:**
   - SEBI requires logging of order placement, modification, cancellation, fills, and rejections
   - Current state: Only the database rows exist; no timestamped, immutable log
   - Database rows can be updated (avgPrice, realizedPnl); logs cannot

3. **Incident response is slow:**
   - No way to trace an order through the system (webhook → validation → matching → fill)
   - No way to correlate fills with margin updates
   - No way to find all affected orders if a bug is discovered

#### Mitigation (Immediate)

Add structured logging to critical trading operations:

```typescript
// services/api/src/sim/order.service.ts
async placeOrder(userId: string, input: PlaceOrderInput): Promise<Order> {
  const correlationId = randomUUID();
  this.logger.log(
    `Order placement started`,
    { correlationId, userId, symbol: input.symbol, side: input.side, qty: input.quantity }
  );
  
  // Validate instrument
  const instrument = await this.prisma.instrument.findUnique(...);
  if (!instrument) {
    this.logger.warn(`Order rejected: instrument not found`, { correlationId, symbol: input.symbol });
    throw new NotFoundException(`Unknown instrument: ${input.symbol}`);
  }
  
  // Check discipline
  const disciplineDecision = this.discipline.evaluate(...);
  if (disciplineDecision.breached) {
    this.logger.log(`Discipline breach detected`, {
      correlationId,
      userId,
      limitType: disciplineDecision.limitType,
      current: disciplineDecision.current,
      limit: disciplineDecision.limit,
    });
    if (!input.overrideToken) {
      throw new ForbiddenException({...});
    }
  }
  
  // Calculate margin
  const margin = computeMargin(instrument, input.side, input.productType, input.price, input.quantity);
  this.logger.log(`Margin calculated`, { correlationId, marginRequired: margin });
  
  // Place order
  const order = await this.prisma.$transaction(async (tx) => {
    const wallet = await tx.paperWallet.findUnique({ where: { userId } });
    if (!wallet || wallet.availableBalance < margin) {
      this.logger.warn(`Order rejected: insufficient margin`, {
        correlationId,
        marginRequired: margin,
        marginAvailable: wallet?.availableBalance ?? 0,
      });
      throw new BadRequestException('Insufficient margin');
    }
    
    const placed = await tx.order.create({...});
    this.logger.log(`Order placed successfully`, { correlationId, orderId: placed.id, margin });
    return placed;
  });
  
  return order;
}

// services/api/src/sim/matching-engine.service.ts
private async evaluate(order: OrderWithInstrument): Promise<void> {
  const correlationId = order.id;
  const price = await this.marketPrice.getPrice(order.instrument);
  
  if (order.status === 'TRIGGER_PENDING') {
    const triggered = order.side === 'BUY' ? price.ltp >= order.triggerPrice : price.ltp <= order.triggerPrice;
    if (!triggered) return;  // No log needed; order is still waiting
    
    this.logger.log(`Trigger fired`, {
      correlationId: order.id,
      symbol: order.instrument.symbol,
      triggerPrice: order.triggerPrice,
      currentPrice: price.ltp,
    });
  }
  
  // Perform fill
  const fillPrice = order.type === 'MARKET' ? price.ltp : order.price;
  await this.doFill(order, fillPrice, price.ltp);
  
  this.logger.log(`Order filled`, {
    correlationId: order.id,
    symbol: order.instrument.symbol,
    qty: order.quantity,
    fillPrice,
    slippage: Math.abs(fillPrice - price.ltp),
  });
}
```

Update [ARCHITECTURE.md §8](../ARCHITECTURE.md#8-observability) with logging conventions and use this in every order/fill/position operation.

---

### 2.3 TYPE SAFETY GAPS IN SERVICE INTEGRATION LAYER

**Severity:** HIGH  
**Impact:** Data contract violations between services go undetected until runtime  
**Risk Level:** Silent corruption of position data, margin calculations, or AI agent inputs

#### Finding

The boundary between `services/api` and `services/sentinel` relies on unvalidated JSON shapes:

**services/api/src/sentinel/sentinel.service.ts:**
```typescript
async observe(
  userId: string,
  symbol?: string,
  context?: string,
  clientSupplied?: { clientTrades?: unknown[]; clientPositions?: unknown[] },  // ← unknown[]
  focus?: {
    strategyMode?: 'auto' | 'manual';
    selectedStrategyIds?: string[];
    selectedStrategyId?: string;
    confidenceThreshold?: number;
  },
) {
  // ...
  const recentTrades = trades.map((t) => ({
    id: t.id,
    symbol: t.instrument.symbol,
    side: t.side,
    quantity: t.quantity,
    fillPrice: Number(t.fillPrice),  // ← Implicit type: { id, symbol, side, quantity, fillPrice, ... }
    createdAt: t.executedAt.toISOString(),
  }));
  
  const body = {
    userId,
    symbol,
    context,
    recentTrades,
    positions,
    account,
  };
  
  // No validation before sending
  const response = await fetch(`${this.baseUrl}/observe`, {
    method: 'POST',
    body: JSON.stringify(body),  // ← Unvalidated shape
  });
}
```

**services/sentinel/src/domain.ts:**
```typescript
export interface TradeSummary {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  fillPrice: number;
  realizedPnl?: number;
  createdAt: string; // ISO
}

export interface ObserveRequest {
  userId: string;
  symbol?: string;
  recentTrades?: TradeSummary[];  // ← Expects TradeSummary
  positions?: PositionSummary[];
  account?: AccountSummary;
  // ...
}
```

**What can go wrong:**

1. **Missing fields:** If `services/api` omits `fillPrice`, `services/sentinel` gets `undefined`, but the type system doesn't catch it.
   ```typescript
   // API sends (missing fillPrice):
   { id, symbol, side, quantity, createdAt }
   
   // Sentinel receives and uses fillPrice in PnL calculation:
   const pnl = (currentPrice - fillPrice) * quantity;  // ← fillPrice is undefined
   // Result: NaN in the calculation
   ```

2. **Type mismatches:** If `services/api` sends `side: "LONG"` instead of `"BUY"`, type safety at the boundary is zero.
   ```typescript
   const tradeToInclude = recentTrades.filter(t => t.side === 'SELL');  // Sentinel code
   // If API sent side: 'LONG', this filter is wrong
   ```

3. **Null/undefined handling:** Optional fields in Typescript types don't prevent `null` or `undefined` values at runtime.
   ```typescript
   const symbolFilter = symbol?.toUpperCase();  // Sentinel code, assumes symbol is a string
   // If API sends symbol: null, this throws at runtime
   ```

#### Mitigation (Immediate)

**Phase 1: Add runtime validation at the service boundary**

Use a validation library (zod, class-validator) on both sides:

```typescript
// packages/types/src/sentinel.ts (make this a real package)
import { z } from 'zod';

export const TradeSummarySchema = z.object({
  id: z.string().uuid(),
  symbol: z.string().min(1),
  side: z.enum(['BUY', 'SELL']),
  quantity: z.number().int().positive(),
  fillPrice: z.number().positive(),
  realizedPnl: z.number().optional(),
  createdAt: z.string().datetime(),
});

export const ObserveRequestSchema = z.object({
  userId: z.string().uuid(),
  symbol: z.string().optional(),
  recentTrades: z.array(TradeSummarySchema).optional(),
  positions: z.array(PositionSummarySchema).optional(),
  account: AccountSummarySchema.optional(),
  context: z.string().optional(),
  strategyMode: z.enum(['auto', 'manual']).optional(),
  selectedStrategyIds: z.array(z.string()).optional(),
  selectedStrategyId: z.string().optional(),
  confidenceThreshold: z.number().min(0).max(100).optional(),
});

export type ObserveRequest = z.infer<typeof ObserveRequestSchema>;
```

**Phase 2: Validate before sending**

```typescript
// services/api/src/sentinel/sentinel.service.ts
async observe(userId: string, ...) {
  // ... build request body ...
  
  // Validate before sending
  const validated = ObserveRequestSchema.parse(body);  // Throws if invalid
  
  const response = await fetch(`${this.baseUrl}/observe`, {
    method: 'POST',
    body: JSON.stringify(validated),
  });
}
```

**Phase 3: Validate on receipt**

```typescript
// services/sentinel/src/app.controller.ts
@Post('/observe')
async observe(@Body(new ValidationPipe()) request: ObserveRequest): Promise<ObservationResponse> {
  // NestJS's ValidationPipe now has the schema and will reject invalid data
  // ...
}
```

**Blockers:** This closes the type safety gap and prevents silent data corruption.

---

## 3. MEDIUM-SEVERITY ISSUES

### 3.1 LEADER ELECTION MISCONFIGURED FOR SINGLE-REPLICA DEPLOYMENT

**Severity:** MEDIUM  
**Impact:** Duplicate processing, race conditions, and out-of-order operations in single-instance stage  
**Risk Level:** Silent data inconsistency (margin double-counted, fills duplicated)

#### Finding

The leader election service [services/api/src/common/leader-election.ts](services/api/src/common/leader-election.ts) implements a distributed lock using Postgres, but the implementation assumes **multiple replicas will exist**:

```typescript
const LEASE_TTL_MS = Number(process.env.JOB_LEASE_TTL_MS ?? 30_000);
const RENEW_INTERVAL_MS = Number(process.env.JOB_LEASE_RENEW_MS ?? 10_000);

// Lease is held for 30 seconds, renewed every 10 seconds
// If this replica crashes, the lock expires in 30 seconds
// Meanwhile, the other replica waits for the lock to expire, then acquires it

// BUT: In a single-replica deployment, if the service restarts:
// 1. Old lease is still held (expires in 30s)
// 2. New instance starts, tries to acquire lock
// 3. Lock is still held by the old instance
// 4. New instance waits 30 seconds, then acquires lock
// 5. During that 30-second gap, the job doesn't run at all
```

**Used by two critical services:**

1. **MatchingEngineService** (fills resting orders every 3 seconds):
   ```typescript
   private async tick(): Promise<void> {
     if (!this.leader.isLeader(JOB)) return;  // Silent skip if not leader
     // Find and fill resting LIMIT/SL/SL_M orders
   }
   ```

2. **SettlementService** (transfers CNC positions to Holdings at T+1):
   ```typescript
   private async sweep(): Promise<void> {
     if (!this.leader.isLeader(SETTLEMENT_SWEEP_JOB)) return;  // Silent skip if not leader
     // Transfer settled positions to holdings
   }
   ```

**In stage 0 (single container):**
- The lock mechanism is entirely unnecessary
- The code is correct but wasteful (queries the database to elect a "leader" that is the only instance)
- A restart causes up to a 30-second gap in matching and settlement

#### Why This is Medium, Not High

1. **Workaround exists:** The per-request settlement path (`HoldingsService.list()` calls `SettlementService.settleUser()`) still runs, so users' own views stay fresh
2. **Gap is temporary:** If the service crashes at 11:59, the new instance at 12:00 waits 30 seconds, then processes settlement — trades don't pile up indefinitely
3. **Maturity trade-off:** This code is *correct for a multi-replica setup*; it's just over-engineered for stage 0

#### Mitigation (Short-term)

In stage 0, disable leader election for non-critical jobs:

```typescript
// services/api/src/common/leader-election.ts
const LEADER_ELECTION_ENABLED = process.env.LEADER_ELECTION_ENABLED === 'true';

export class LeaderElectionService {
  isLeader(jobName: string): boolean {
    if (!LEADER_ELECTION_ENABLED) return true;  // Single replica — always leader
    return this.holder === jobName;
  }
}
```

```typescript
// .env
LEADER_ELECTION_ENABLED=false  # Stage 0
# LEADER_ELECTION_ENABLED=true   # Stage 1+ (multiple replicas)
```

#### Mitigation (Long-term)

For stage 1+ (multiple replicas), switch to Redis-backed lease:

```typescript
// services/common/src/leader-election-redis.ts
import Redis from 'ioredis';

export class RedisLeaderElectionService {
  async acquire(jobName: string, ttl: number): Promise<boolean> {
    const key = `leader:${jobName}`;
    const value = randomUUID();  // Unique identifier for this instance
    
    // SET key value EX ttl NX — atomic "set if not exists" with expiry
    const acquired = await this.redis.set(key, value, 'EX', ttl, 'NX');
    return acquired === 'OK';
  }
  
  async renew(jobName: string, ttl: number): Promise<boolean> {
    const key = `leader:${jobName}`;
    // Extend the TTL if we still hold it
    const extended = await this.redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end`,
      1,
      key,
      this.value,
      ttl
    );
    return extended === 1;
  }
}
```

---

### 3.2 INCONSISTENT ERROR HANDLING — NO TYPED ERROR HIERARCHY

**Severity:** MEDIUM  
**Impact:** Callers don't know what exceptions to catch; error handling is ad-hoc  
**Risk Level:** Unhandled exceptions crash the service; no graceful degradation

#### Finding

Error handling is inconsistent across the codebase:

**Some places throw NestJS exceptions (good):**
```typescript
// services/api/src/auth/auth.service.ts
if (!user) throw new BadRequestException('That code is invalid or has expired.');
if (!ok) throw new UnauthorizedException('Invalid credentials');
```

**Some places throw generic Error objects (bad):**
```typescript
// services/api/src/common/leader-election.ts
throw new Error('connection reset');  // Generic Error, not a typed exception

// services/api/src/broker/dhan-auth.controller.ts
throw new Error('Authenticated request carried no subject');  // Generic
```

**Some places throw with generic messages (ambiguous):**
```typescript
// services/api/src/discipline/discipline.service.ts
if (result.breach) {
  throw new Error(
    `Discipline: breach override token invalid or expired`
  );
}
```

**No app-level error type hierarchy:**
```
Expected pattern:
  AppException (base)
    ├── ValidationException (400)
    ├── AuthenticationException (401)
    ├── AuthorizationException (403)
    ├── DisciplineException (409)
    ├── InsufficientMarginException (402)
    ├── ExternalServiceException (502)
    └── ...

Actual pattern:
  Whatever NestJS exception type fits roughly
  + ad-hoc `throw new Error(...)`
```

#### Why This is Medium

1. **Logging confusion:**
   ```typescript
   try {
     await this.doSomething();
   } catch (err) {
     if (err instanceof BadRequestException) {
       this.logger.warn('User error', err.message);  // Expected
     } else if (err instanceof ServiceUnavailableException) {
       this.logger.error('Service unreachable', err.message);  // 3rd-party issue
     } else {
       // What do we do here? Generic Error?
       this.logger.error('Unknown error', err);
     }
   }
   ```

2. **Testing difficulty:**
   ```typescript
   it('rejects insufficient margin', async () => {
     // What should placeOrder throw?
     await expect(placeOrder(userId, { margin: 10_000_000 }))
       .rejects.toThrow(BadRequestException);  // Correct?
       // OR .rejects.toThrow(ForbiddenException)?
       // OR .rejects.toThrow('Insufficient margin')?
       // Test brittleness results
   });
   ```

3. **Client error handling:**
   ```typescript
   // Frontend code
   try {
     const order = await api.placeOrder(...);
   } catch (err) {
     if (err.status === 400) {
       // User input error — show validation message
     } else if (err.status === 402) {
       // Insufficient margin — show balance, suggest position size
     } else if (err.status === 409) {
       // Discipline breach — show friction prompt
     } else if (err.status === 502) {
       // Services/trading-engine is down — show spinner, retry
     } else {
       // ??? Unknown error — black screen of death
     }
   }
   ```

#### Mitigation (Short-term)

Stop using generic `Error` in new code:

```typescript
// common/exceptions.ts
export class DisciplineException extends BadRequestException {
  constructor(limitType: string, detail: Record<string, unknown>) {
    super({ message: `Discipline breach: ${limitType}`, detail });
  }
}

export class InsufficientMarginException extends BadRequestException {
  constructor(required: number, available: number) {
    super({ message: 'Insufficient margin', required, available });
  }
}

export class InvalidTokenException extends BadRequestException {
  constructor(reason: string) {
    super({ message: 'Token invalid or expired', reason });
  }
}
```

Update call sites:
```typescript
// Order service
if (!user || wallet.availableBalance < margin) {
  throw new InsufficientMarginException(margin, wallet.availableBalance);
}

if (result.breach) {
  throw new DisciplineException(result.limitType, result.detail);
}
```

#### Mitigation (Long-term)

Build a full exception hierarchy as part of packages/shared:

```typescript
// packages/shared/src/exceptions/index.ts
export class TradeWException extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly detail?: Record<string, unknown>
  ) {
    super(message);
  }
}

export class ValidationException extends TradeWException {
  constructor(message: string, detail?: Record<string, unknown>) {
    super('VALIDATION_ERROR', 400, message, detail);
  }
}

export class InsufficientMarginException extends TradeWException {
  constructor(required: number, available: number) {
    super(
      'INSUFFICIENT_MARGIN',
      402,
      `Insufficient margin: ${required} required, ${available} available`,
      { required, available }
    );
  }
}

export class DisciplineBreachException extends TradeWException {
  constructor(limitType: string, current: number, limit: number) {
    super(
      'DISCIPLINE_BREACH',
      409,
      `Discipline breach: ${limitType}`,
      { limitType, current, limit }
    );
  }
}
```

---

### 3.3 MISSING INPUT VALIDATION ON ORDER SUBMISSION

**Severity:** MEDIUM  
**Impact:** Malformed order requests may cause unexpected behavior or crashes  
**Risk Level:** API instability, garbage data in database

#### Finding

Order submission ([services/api/src/sim/order.service.ts](services/api/src/sim/order.service.ts)) has minimal validation:

```typescript
export interface PlaceOrderInput {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  productType?: ProductType;
  validity?: OrderValidity;
  /** Required for LIMIT and SL, ignored otherwise. */
  price?: number;
  /** Required for SL and SL_M, ignored otherwise. */
  triggerPrice?: number;
  overrideToken?: string;
  overrideReason?: string;
}

// The controller accepts this DTO but does not validate:
@Post('/orders')
async placeOrder(@Body() input: PlaceOrderInput) {
  // No validation pipe
  // No check that price is set for LIMIT orders
  // No check that triggerPrice is set for SL/SL_M orders
  // No check that quantity > 0
  // No check that price > 0
}
```

**What can go wrong:**

1. **Missing required fields:**
   ```
   POST /orders
   { "symbol": "NIFTY", "side": "BUY", "type": "LIMIT" }
   // quantity is missing, side/type are invalid strings
   // Order is created with quantity=undefined, type="invalid"
   ```

2. **Negative or zero quantities:**
   ```
   { "symbol": "NIFTY", "side": "BUY", "quantity": -100 }
   // Creates a position with -100 quantity (equivalent to +100 short)
   // Margin calculation may be wrong
   ```

3. **Type mismatches:**
   ```
   { "symbol": "NIFTY", "side": "LONG", "quantity": 50 }  // LONG is not BUY or SELL
   // Code that switches on side will not match LONG
   ```

4. **Missing conditional requirements:**
   ```
   { "symbol": "NIFTY", "side": "BUY", "type": "LIMIT", "quantity": 50 }
   // price is missing; LIMIT orders require a price
   // Order is created with price=undefined; matching engine fails silently
   ```

#### Mitigation (Immediate)

Add a ValidationPipe and DTOs with class-validator decorators:

```typescript
// sim/dto/place-order.dto.ts
import { IsEnum, IsNumber, IsOptional, IsPositive, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class PlaceOrderDto {
  @IsString()
  symbol!: string;

  @IsEnum(['BUY', 'SELL'])
  side!: 'BUY' | 'SELL';

  @IsEnum(['MARKET', 'LIMIT', 'SL', 'SL_M'])
  type!: string;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  quantity!: number;

  @IsEnum(['MIS', 'CNC', 'NRML'])
  @IsOptional()
  productType?: string;

  @IsEnum(['DAY', 'IOC'])
  @IsOptional()
  validity?: string;

  @IsNumber()
  @IsPositive()
  @IsOptional()
  @Type(() => Number)
  price?: number;

  @IsNumber()
  @IsPositive()
  @IsOptional()
  @Type(() => Number)
  triggerPrice?: number;

  @IsString()
  @IsOptional()
  overrideToken?: string;

  @IsString()
  @IsOptional()
  overrideReason?: string;
}

// Custom validator for conditional requirements
import { ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments, registerDecorator } from 'class-validator';

@ValidatorConstraint({ name: 'isValidOrderType' })
export class IsValidOrderTypeConstraint implements ValidatorConstraintInterface {
  validate(obj: PlaceOrderDto): boolean {
    if (obj.type === 'LIMIT' && obj.price === undefined) return false;
    if ((obj.type === 'SL' || obj.type === 'SL_M') && obj.triggerPrice === undefined) return false;
    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    const obj = args.object as PlaceOrderDto;
    if (obj.type === 'LIMIT' && obj.price === undefined) {
      return 'price is required for LIMIT orders';
    }
    if ((obj.type === 'SL' || obj.type === 'SL_M') && obj.triggerPrice === undefined) {
      return 'triggerPrice is required for SL/SL_M orders';
    }
    return 'Invalid order type configuration';
  }
}

@ValidatorConstraint()
class IsValidOrderTypeConstraint implements ValidatorConstraintInterface {
  validate(obj: PlaceOrderDto): boolean {
    if (obj.type === 'LIMIT' && (!obj.price || obj.price <= 0)) return false;
    if ((obj.type === 'SL' || obj.type === 'SL_M') && (!obj.triggerPrice || obj.triggerPrice <= 0)) return false;
    return true;
  }
}

export function IsValidOrderType() {
  return registerDecorator({
    target: Object,
    propertyName: '',
    validator: IsValidOrderTypeConstraint,
  });
}

export class PlaceOrderDto {
  // ... existing fields ...
  @IsValidOrderType()
  validate(): boolean { return true; }
}
```

Update the controller:

```typescript
// sim.controller.ts
@Post('/orders')
@UseGuards(AuthGuard)
async placeOrder(
  @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
  input: PlaceOrderDto,
  @Req() req: any
) {
  // Input is now guaranteed to be valid
  return this.sim.placeOrder(req.user.id, input);
}
```

---

## 4. SPECIFIC RED FLAGS

### 4.1 ENVIRONMENT VARIABLE HANDLING — WEAK SECRETS & PLACEHOLDERS

**Severity:** HIGH  
**Impact:** Production secrets can be weaker than code assumes; deployment succeeds with default/demo values  
**Risk Level:** Silent auth bypass, credential leakage

#### Findings

1. **JWT_SECRET fallback to 'dev-secret-change-me'** (fixed 2026-08-10, but pattern still elsewhere):
   - Old code: `secret: process.env.JWT_SECRET || 'dev-secret-change-me'`
   - Current code: Properly fails on missing/weak secret (via `resolveSecret`)
   - **But:** The pattern is still used elsewhere for non-critical secrets

2. **Placeholder values in .env.example accepted by guards:**
   ```bash
   # .env.example
   ADMIN_API_TOKEN=dev-secret-change-me
   SERVICE_TOKEN=dev-sentinel-token
   ```
   
   Guards check for these and **reject them**:
   ```typescript
   const WEAK_SERVICE_TOKENS = new Set(['', 'dev-sentinel-token', 'dev-sentinel-service-token', 'changeme', 'secret']);
   if (WEAK_SERVICE_TOKENS.has(expected.toLowerCase())) {
     throw new UnauthorizedException('SERVICE_TOKEN not configured');
   }
   ```
   
   But if an operator **forgets to update .env** and leaves `SERVICE_TOKEN=dev-sentinel-token`:
   - Local dev: `services/sentinel` boots and immediately rejects all requests ✓ (good — loud failure)
   - But an operator running tests or with an old checkout might not notice

3. **Implicit dev/prod config splitting:**
   ```bash
   # .env (dev, gitignored)
   DATABASE_URL=postgres://localhost/tradew_dev
   DHAN_APP_ID=demo-app-id
   
   # .env.example (tracked in git)
   DATABASE_URL=
   DHAN_APP_ID=
   ```
   
   An operator deploying from git clone needs to manually set every secret. Easy to miss one.

4. **Optional secrets that disable features silently:**
   ```typescript
   // services/api/src/mail/mail.service.ts
   const host = process.env.SMTP_HOST;
   const user = process.env.SMTP_USER;
   const pass = process.env.SMTP_PASS;
   
   if (!host || !user || !pass) {
     // Silently fall back to console logging
     return;
   }
   ```
   
   If SMTP is misconfigured, users don't receive password-reset emails — but the system doesn't error, it just silently fails.

#### Mitigation

Build a secrets manifest that:
1. Lists every required secret
2. States where it's used
3. Requires explicit override to use a weak value for dev

```yaml
# docs/SECRETS.md
required_secrets:
  - name: JWT_SECRET
    used_by: [services/api]
    min_length: 32
    description: "Token signing key for user sessions"
    dev_value: "<generate: openssl rand -base64 32>"
    
  - name: SERVICE_TOKEN
    used_by: [services/api, services/sentinel]
    min_length: 24
    description: "Service-to-service auth between api and sentinel"
    dev_value: "<generate: openssl rand -base64 24>"
    
  - name: ADMIN_API_TOKEN
    used_by: [services/api]
    min_length: 32
    description: "Operator secret for admin control plane"
    dev_value: "<keep unset in dev — admin features disabled>"

optional_secrets:
  - name: SMTP_HOST
    used_by: [services/api]
    description: "Email delivery — if unset, password resets log to console"
    dev_value: "<leave empty, use mock mailer>"
    
  - name: DHAN_APP_ID
    used_by: [services/api]
    description: "Broker integration — if unset, paper mode only"
    dev_value: "<leave empty, use mock broker>"
```

Create a pre-deployment check:

```bash
#!/bin/bash
# scripts/validate-secrets.sh

REQUIRED_SECRETS=(JWT_SECRET SERVICE_TOKEN ADMIN_API_TOKEN)
MISSING=()

for secret in "${REQUIRED_SECRETS[@]}"; do
  value=$(grep "^${secret}=" .env | cut -d= -f2)
  if [ -z "$value" ] || [ "$value" = "dev-secret-change-me" ]; then
    MISSING+=("$secret")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "ERROR: Missing or weak secrets:"
  for secret in "${MISSING[@]}"; do
    echo "  $secret"
  done
  exit 1
fi

echo "✓ All required secrets are set"
```

Run before deploy:
```yaml
# .github/workflows/deploy.yml
- name: Validate secrets
  run: ./scripts/validate-secrets.sh
```

---

### 4.2 RACE CONDITION IN CONCURRENCY — DUPLICATE FILLS

**Severity:** MEDIUM  
**Impact:** An order may be filled twice if two instances evaluate it concurrently  
**Risk Level:** Position oversold, margin accounting error, duplicate fills logged

#### Finding

The matching engine uses leader election to prevent duplicate processing:

```typescript
// services/api/src/sim/matching-engine.service.ts
private async tick(): Promise<void> {
  if (!this.leader.isLeader(JOB)) return;  // Only leader runs matching
  
  let resting: OrderWithInstrument[];
  try {
    resting = await this.prisma.order.findMany({
      where: { status: { in: ['OPEN', 'TRIGGER_PENDING'] } },
    });
  } catch (err) {
    this.logger.error('tick: failed to load resting orders', err as Error);
    return;
  }
  
  for (const order of resting) {
    try {
      await this.evaluate(order);
    } catch (err) {
      this.logger.error(`tick: failed to evaluate order ${order.id}`, err as Error);
    }
  }
}

private async evaluate(order: OrderWithInstrument): Promise<void> {
  const price = await this.marketPrice.getPrice(order.instrument);
  
  if (order.type === 'LIMIT' && price.ltp !== Number(order.price)) return;  // Not filled yet
  
  // Order fills at this price
  await this.doFill(order, fillPrice, slippage);
}

private async doFill(order: OrderWithInstrument, fillPrice: number, slippage: number): Promise<void> {
  return this.prisma.$transaction(async (tx) => {
    // Step 1: Check if order is still OPEN
    const current = await tx.order.findUnique({ where: { id: order.id } });
    if (current.status !== 'OPEN') return;  // Already filled, skip
    
    // Step 2: Create trade
    await tx.trade.create({
      data: { orderId: order.id, fillPrice, ... }
    });
    
    // Step 3: Update order status
    await tx.order.update({
      where: { id: order.id },
      data: { status: 'FILLED' }
    });
  });
}
```

**Race condition scenario (in single-replica with restart or in multi-replica without leader election):**

1. Instance A: Reads order at OPEN, price matches trigger → enters doFill transaction
2. Instance B: **Simultaneously** reads same order at OPEN, price matches trigger → enters doFill transaction
3. Both reach Step 1 (check status) **before either reaches Step 3** (update status)
4. Both see status = OPEN, both proceed
5. Both create Trade rows (now there are 2 fills for 1 order!)
6. Both try to update order to FILLED; the second one is redundant but succeeds

**Why leader election doesn't prevent this in stage 0:**
- Leader election only ensures ONE instance runs the matching `tick()` loop
- But if the instance crashes/restarts while `doFill` is in flight, a new instance may start processing the same order again
- The lock holds for 30 seconds; if the crashed instance's transaction is still in-flight, the new leader may start a new transaction for the same order

#### Mitigation (Immediate)

Use a unique constraint to prevent duplicate fills:

```typescript
// packages/database/prisma/schema.prisma
model Trade {
  id String @id @default(uuid())
  orderId String
  userId String
  // ...
  
  // Unique index: one fill per order per symbol per timestamp
  @@unique([orderId, userId, executedAt])  // One trade per order per second
  // This prevents duplicates if two transactions race
}
```

But this doesn't prevent duplicate fills of the **same order** at different prices (if called twice). Better:

```typescript
// Use a unique constraint on the order's fill event
model Trade {
  // ... existing fields ...
  @@unique([orderId, fillPrice, executedAt])  // Exact same fill cannot be created twice
}
```

Even better — idempotent doFill:

```typescript
private async doFill(order: OrderWithInstrument, fillPrice: number, slippage: number): Promise<void> {
  const fillId = `${order.id}-${Date.now()}`;  // Unique fill identifier
  
  return this.prisma.$transaction(async (tx) => {
    // Step 1: Check if order is already filled
    const current = await tx.order.findUnique({ where: { id: order.id } });
    if (current.status === 'FILLED' || current.status === 'PARTIALLY_FILLED') {
      this.logger.warn(`Order already filled, skipping duplicate fill`, { orderId: order.id });
      return;  // Idempotent: second call does nothing
    }
    
    // Step 2: Create Trade (unique constraint prevents duplicate inserts)
    try {
      const trade = await tx.trade.create({
        data: {
          orderId: order.id,
          userId: order.userId,
          fillPrice,
          executedAt: new Date(),
          fillId,  // Unique identifier
          // ...
        },
      });
    } catch (err) {
      if (err.code === 'P2002') {  // Unique constraint violation
        this.logger.warn(`Trade already exists for this order`, { orderId: order.id });
        return;  // Idempotent: duplicate fill is ignored
      }
      throw err;
    }
    
    // Step 3: Update order status atomically
    await tx.order.update({
      where: { id: order.id },
      data: { status: 'FILLED', filledQuantity: order.quantity },
    });
  });
}
```

---

### 4.3 MISSING TESTS AND UNCLEAR COVERAGE

**Severity:** MEDIUM  
**Impact:** Regressions are undetected; confidence in releases is low  
**Risk Level:** Silent bugs in production

#### Finding

Test coverage is **unclear and contradictory:**

1. **README claims (2026-07-29):** "112 automated tests, ~80% complete"
   
2. **Application Status docs (2026-07-25):** "zero automated tests anywhere in the repository"
   
3. **Implementation Report (2026-08-04):**
   ```
   ✅ packages/market-data tests: 43/43 assertions pass
   ✅ services/api typecheck: Clean
   ✅ services/sentinel typecheck: Clean
   
   ⚠️ vitest test suites (api, sentinel, web) fail at startup
      (Cannot find module '@rollup/rollup-linux-x64-gnu')
   ⚠️ Could not run vitest or pytest — linux/windows binary mismatch
   ```
4. **Actual test files found:**
   - `services/api/src/**/*.spec.ts` — unit tests for auth, broker, discipline, ...
   - `services/sentinel/src/**/*.spec.ts` — unit tests for controllers, services
   - `packages/market-data/tests/*.ts` — 43 passing tests
   - `services/trading-engine/` — **zero tests**

#### What's tested vs. not:

| Module | Tests | Status |
|--------|-------|--------|
| services/api/auth | ✓ | Unit tests exist (login, signup, google auth) |
| services/api/discipline | ✓ | Unit tests exist (breach detection, override token) |
| services/api/sim | ✓ Partial | Tests exist for parts (order fill, position close) |
| services/api/broker | ✓ | OAuth state machine tested |
| services/sentinel | ✓ | Partial tests exist |
| services/trading-engine | ✗ | Zero tests; zero .py files |
| packages/market-data | ✓ | 43 passing tests (tick packet parsing) |
| Integration tests | ✗ | None found (api ↔ sentinel, api ↔ trading-engine) |
| End-to-end tests | ✗ | None found (full order flow) |

#### Mitigation (Immediate)

1. **Run actual test suites locally and report real numbers:**
   ```bash
   npm test -- --coverage --coverage-reporter=json
   ```
   Get actual coverage percentage for each service.

2. **Add pre-commit test gate:**
   ```bash
   # .husky/pre-commit
   npm run test -- --bail  # Stop on first failure
   ```

3. **Write integration tests for critical flows:**
   ```typescript
   // services/api/src/sim/__tests__/order-flow.integration.spec.ts
   describe('Full order flow', () => {
     it('places, fills, and closes an order', async () => {
       const user = await createTestUser();
       
       // 1. Place LIMIT order
       const order = await api.placeOrder(user.id, {
         symbol: 'NIFTY',
         side: 'BUY',
         type: 'LIMIT',
         quantity: 50,
         price: 20000,
       });
       expect(order.status).toBe('OPEN');
       
       // 2. Price hits the limit
       await setLivePrice('NIFTY', 20000);
       
       // 3. Matching engine fills it
       await waitForFill(order.id);
       const filled = await api.getOrder(user.id, order.id);
       expect(filled.status).toBe('FILLED');
       
       // 4. Check position
       const position = await api.getPositions(user.id);
       expect(position[0].quantity).toBe(50);
       
       // 5. Close the position
       const closeOrder = await api.placeOrder(user.id, {
         symbol: 'NIFTY',
         side: 'SELL',
         quantity: 50,
         type: 'MARKET',
       });
       
       await setLivePrice('NIFTY', 20100);
       await waitForFill(closeOrder.id);
       
       // 6. Verify PnL
       const trades = await api.getTradeHistory(user.id);
       const pnl = trades[0].realizedPnl;
       expect(pnl).toBeCloseTo((20100 - 20000) * 50);  // ≈ ₹5000
     });
   });
   ```

---

## 5. RECOMMENDATIONS

### Critical (Must Fix Before Launch)

| ID | Issue | Effort | Timeline |
|----|-------|--------|----------|
| 1.1 | Cascade delete schema | 2 days | Before v0.3 release |
| 1.2 | Discipline token race condition | 3 days | Before v0.3 release |
| 1.3 | Trading engine not implemented | 10+ days | v0.4 or clarify scope |
| 1.4 | Trading engine tests missing | 5 days | v0.3.1 |
| 1.5 | Service token naming inconsistency | 1 day | Before v0.3 release |

### High-Severity (Before First Real Capital)

| ID | Issue | Effort | Timeline |
|----|-------|--------|----------|
| 2.1 | packages/shared unbuilt | 3 days | v0.3.1 |
| 2.2 | Insufficient logging | 4 days | v0.3.1 |
| 2.3 | Type safety gaps | 2 days | v0.3.1 |

### Medium-Severity (Before Scale)

| ID | Issue | Effort | Timeline |
|----|-------|--------|----------|
| 3.1 | Leader election misconfigured | 2 days | v0.3.1 |
| 3.2 | Error handling inconsistency | 3 days | Ongoing |
| 3.3 | Missing input validation | 2 days | v0.3.1 |

---

## Conclusion

The TradeW codebase demonstrates **solid engineering in core areas** (transaction handling, secret validation, rate limiting) but exhibits **critical gaps** that must be closed before real capital can be trusted to the platform:

1. **Database schema** is vulnerable to cascading data loss
2. **Service implementations** are incomplete (trading-engine, tradew-ai are README-only)
3. **Race conditions** exist in discipline override and matching engine
4. **Type safety** is weak at service boundaries
5. **Observability** is insufficient for troubleshooting live trading issues

**Recommended approach:**
- **Week 1:** Fix 1.1, 1.2, 1.5 (schema, race conditions, token naming)
- **Week 2:** Clarify scope for 1.3 (trading-engine — v0.3 or v0.4?)
- **Week 3:** Implement 2.1, 2.2 (shared package, logging)
- **Week 4+:** Address medium-severity items (validation, error handling, tests)

**Do not deploy real capital** until issues 1.1, 1.2, 1.4, and 1.5 are resolved and tested.
