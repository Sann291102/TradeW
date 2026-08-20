# TradeW Admin Portal — Complete Blueprint
**The Living AI Command House: Real-time Agent Monitoring, 3D Headquarters, Full System Control**

---

## 1. EXECUTIVE VISION

The TradeW Admin Portal is a **3D animated command center** that serves dual purposes:
1. **Real Admin**: Full operational control, user/subscription/compliance management, audit trails, security governance
2. **Living Headquarters**: Immersive 3D visualization of TradeW's entire operation—agents working in rooms, data flowing between systems, market intelligence live on a holographic globe

**Key Differentiator**: Click any agent or system → see live what that agent is viewing on their screen, agent name in top-left, real-time status. This is the nerve center of TradeW's AI operations.

---

## 2. ARCHITECTURE & DEPLOYMENT

### 2.1 Repository Structure
```
tw-admin/
├── apps/
│   ├── web/                    # Next.js frontend
│   │   ├── src/
│   │   │   ├── pages/
│   │   │   │   ├── dashboard/  # 3D command center
│   │   │   │   ├── command-rooms/  # Engineering, Support, Finance, etc.
│   │   │   │   ├── agents/     # Agent monitor & screen viewer
│   │   │   │   ├── users/      # User management
│   │   │   │   ├── subscription/
│   │   │   │   ├── audit/
│   │   │   │   ├── compliance/
│   │   │   │   └── admin/
│   │   │   ├── components/
│   │   │   │   ├── CommandCenter/  # 3D scene (React Three Fiber)
│   │   │   │   ├── RoomViewer/     # 3D room display
│   │   │   │   ├── AgentScreen/    # Live agent screen viewer
│   │   │   │   ├── FloatingMenu/   # Animated nav
│   │   │   │   ├── HeatMap/
│   │   │   │   ├── RealtimeCharts/
│   │   │   │   └── shared/
│   │   │   ├── lib/
│   │   │   │   ├── api/        # Admin API client
│   │   │   │   ├── auth/       # Auth & RBAC
│   │   │   │   ├── websocket/  # Real-time updates
│   │   │   │   └── store/
│   │   │   └── styles/
│   │   │       └── themes/     # Crimson & Black theme
│   │   └── tailwind.config.ts
│   │
│   └── api/                    # Next.js API routes + backend
│       ├── src/
│       │   ├── auth/           # MFA, IP allow-list, session
│       │   ├── users/          # User CRUD, roles, provisioning
│       │   ├── subscription/   # Billing, plans, usage
│       │   ├── agents/         # Agent registry, status, screen viewer
│       │   ├── audit/          # Immutable audit logs
│       │   ├── compliance/     # GDPR, SOC2, reporting
│       │   ├── sentinel/       # Sentinel health & stats
│       │   ├── system/         # System metrics, broker feeds
│       │   ├── webhooks/       # Inbound from main app
│       │   ├── middleware/
│       │   └── utils/
│       └── prisma/
│           └── schema.prisma   # Complete data model
│
├── packages/
│   ├── shared-types/           # TypeScript types (auth, agents, etc.)
│   └── ui-components/          # Shared Crimson-themed components
│
└── .env.example, package.json, docker-compose.yml, etc.
```

### 2.2 Deployment Strategy
- **Repository**: Separate `tw-admin` repo (git)
- **Domain**: `admin.tradew.dev` (staging), `admin.tradew.io` (production)
- **Infrastructure**: Docker + Kubernetes (or AWS ECS + RDS)
- **Database**: Dedicated Postgres instance (read replica from main TradeW DB for some data)
- **Authentication**: Separate JWT/session system, admin-only
- **API Gateway**: Private API routes with admin-only API keys

### 2.3 Tech Stack
| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Next.js 14, React 18, TypeScript | SSR + client rendering |
| **3D Graphics** | React Three Fiber, Three.js | Command center & rooms |
| **UI/Theme** | Tailwind CSS, ShadcnUI | Component library, Crimson theme |
| **State** | Zustand + React Query | Client state & caching |
| **Real-time** | WebSocket (Socket.io or native WS) | Live agent status, charts |
| **Backend** | Next.js API routes, Node.js | Admin endpoints |
| **Database** | PostgreSQL, Prisma ORM | Admin data, audit logs |
| **Security** | jsonwebtoken, bcrypt, argon2 | Auth & password hashing |
| **Monitoring** | Prometheus + Grafana (or New Relic) | Portal health |
| **Logging** | Winston, structured JSON | Audit trails, debugging |
| **Testing** | Jest, Playwright | Unit, integration, E2E |

---

## 3. SECURITY & COMPLIANCE

### 3.1 Authentication & Authorization

#### RBAC Roles & Permissions
```typescript
// Roles
enum Role {
  SUPER_ADMIN = 'super_admin',      // Full access, can modify other admins
  SUPPORT = 'support',               // User support, limited access
  FINANCE = 'finance',               // Subscription, revenue, analytics
  OPS = 'ops',                       // System health, agent monitoring
  COMPLIANCE = 'compliance',         // Audit logs, policy enforcement
  CLIENT = 'client',                 // Read-only, their own data
}

// Permission examples
const Permissions = {
  user_create: ['super_admin'],
  user_delete: ['super_admin'],
  user_edit_role: ['super_admin'],
  user_reset_mfa: ['super_admin', 'support'],
  subscription_create: ['finance', 'super_admin'],
  subscription_cancel: ['finance', 'super_admin'],
  audit_view: ['compliance', 'super_admin'],
  agent_restart: ['ops', 'super_admin'],
  system_config: ['super_admin'],
};
```

#### Multi-Factor Authentication (MFA)
- **Enforcement**: Mandatory for SUPER_ADMIN and COMPLIANCE roles, optional for others
- **Methods**: TOTP (Authenticator app), WebAuthn (hardware keys preferred)
- **Recovery Codes**: Encrypted backup codes stored in vault, one-time use
- **MFA Status Dashboard**: Admin can view MFA compliance across team

#### IP Allow-List
- **Super Admins**: Restricted to registered IP ranges (office, VPN, secure gateway)
- **Support/Ops/Finance**: Flexible, but logged with geographic data (MaxMind GeoIP)
- **Automatic Blocking**: After 5 failed logins from unknown IP, temporary 1-hour lockout
- **Admin Override**: Super admin can add/remove IPs, with audit trail

### 3.2 Session & Token Management
```typescript
// Session schema
interface AdminSession {
  id: string;
  userId: string;
  token: string;                    // JWT or opaque token
  expiresAt: Date;
  lastActivity: Date;
  ipAddress: string;
  userAgent: string;
  mfaVerified: boolean;
  mfaVerifiedAt: Date;
  riskScore: number;                 // 0-100, triggers re-auth if high
}

// Token payload
interface AdminJWT {
  sub: string;                       // user ID
  role: Role;
  permissions: string[];
  iss: 'tw-admin';
  aud: 'tw-admin-api';
  iat: number;
  exp: number;
  sessionId: string;
}
```

- **Timeout**: 30 min inactivity (fingerprint-aware; same device = extend)
- **Long Session**: "Remember this device" option (14-day token), requires re-auth for sensitive ops
- **Revocation**: Super admin can revoke any session instantly
- **Concurrent Sessions**: Max 3 per user; older sessions dropped

### 3.3 Audit Logging (Immutable)
Every admin action → immutable log entry, queryable but never modified:

```typescript
interface AuditLog {
  id: string;
  timestamp: Date;
  userId: string;                    // Who did it
  role: Role;
  action: string;                    // 'user_created', 'subscription_updated', etc.
  resource: string;                  // 'users', 'subscriptions', 'agents'
  resourceId: string;
  before?: Record<string, any>;      // Previous state (sensitive fields redacted)
  after?: Record<string, any>;       // New state
  ipAddress: string;
  userAgent: string;
  status: 'success' | 'failure';
  errorMessage?: string;
  durationMs: number;
  tags: string[];                    // 'security', 'compliance', 'high-risk'
}
```

- **Retention**: 7 years (compliance requirement)
- **Encryption**: At rest (AES-256), in transit (TLS 1.3)
- **Access Control**: COMPLIANCE role can query; others can only see their own actions
- **Export**: CSV/JSON for auditors, with cryptographic signatures

### 3.4 Encryption & Data Protection
- **Passwords**: Argon2id (recommended), min 15 iterations
- **Sensitive Fields**: PII (user emails, phone) encrypted with envelope encryption (KMS key rotation quarterly)
- **API Keys**: Hashed with bcrypt, never logged; only shown once at creation
- **Database**: Postgres at-rest encryption, TLS for connections
- **Secrets**: HashiCorp Vault or AWS Secrets Manager for env vars, DB credentials, third-party API keys

### 3.5 Network Security
- **TLS 1.3**: All traffic encrypted
- **CORS**: Locked to `admin.tradew.io` only (no wildcard)
- **CSP**: Strict Content Security Policy, no inline scripts
- **HSTS**: Max-Age 31536000, includeSubDomains
- **Rate Limiting**: 100 requests/min per user, 10/sec per IP (burst = 20)
- **DDoS Protection**: Cloudflare or similar, auto-mitigation
- **Secrets Scanning**: Pre-commit hooks, scan for leaked API keys in logs

---

## 4. CORE MODULES

### 4.1 User Management

#### Features
- **Create Users**: SUPER_ADMIN only, auto-generate temporary password
- **Edit Roles**: Change role, permissions inherit from role, audit logged
- **Reset MFA/Password**: SUPER_ADMIN or SUPPORT, with email verification
- **Provision/Deprovision**: Bulk import (CSV), soft delete (30-day grace period)
- **Team Hierarchy**: Optional: org structure, departments, team leads (for larger deployments)
- **API Key Management**: Create/revoke admin API keys, with scope limits and rotation alerts

#### UI Components
```
Users Dashboard
├── User List (table, searchable, sortable, filterable by role/status)
├── Add User (modal form, role selector, email invite)
├── User Detail (edit role, reset MFA, view sessions, audit actions)
├── Bulk Actions (CSV import, role change, reset MFA)
└── Invitation Tracker (pending, accepted, expired)
```

#### Data Model
```prisma
model AdminUser {
  id            String    @id @default(cuid())
  email         String    @unique
  passwordHash  String
  role          Role
  permissions   String[]  // Derived from role, but can be customized
  mfaEnabled    Boolean   @default(false)
  mfaSecret     String?   // Encrypted
  mfaRecoveryCodes String[] // Encrypted
  ipAllowList   String[]  // CIDR ranges
  createdAt     DateTime  @default(now())
  lastLoginAt   DateTime?
  lastLoginIp   String?
  deactivatedAt DateTime?
  
  sessions      AdminSession[]
  auditLogs     AuditLog[]
  preferences   UserPreference?
}

model UserPreference {
  id            String    @id @default(cuid())
  userId        String    @unique
  theme         String    // 'dark', 'light'
  sidebarCollapsed Boolean
  defaultView   String    // 'dashboard', 'agents', 'rooms'
  notificationPrefs Json
}
```

---

### 4.2 Subscription Management

#### Features
- **Plan Management**: Tier overview (Free, Starter, Pro, Enterprise), feature matrix
- **Client Management**: List all clients, their current plan, usage, contract dates
- **Upgrade/Downgrade**: Self-service or admin-initiated, pro-rata billing
- **Usage Tracking**: API calls, agents deployed, data stored; warn at 80%, block at 100%
- **Billing**: Stripe integration, invoices, payment history
- **Churn Prediction**: ML flag on declining usage, trigger support outreach

#### UI Components
```
Subscription Dashboard
├── Plan Matrix (display all tiers, pricing, features)
├── Client List (name, email, plan, usage %, renewal date)
├── Client Detail
│   ├── Contract info (plan, billing cycle, auto-renewal, discount)
│   ├── Usage Dashboard (API calls, agents, storage, % of limit)
│   ├── Billing History (invoices, payments, disputes)
│   ├── Usage Alerts (thresholds, notify when 80%, 100%)
│   └── Actions (upgrade, downgrade, cancel, apply discount)
├── Revenue Analytics (MRR, ARR, churn rate, LTV by cohort)
└── Dunning Management (retry failed payments, contact overdue)
```

#### Data Model
```prisma
model Subscription {
  id              String    @id @default(cuid())
  clientId        String
  planId          String
  status          String    // 'active', 'canceled', 'past_due'
  stripeSubId     String?   @unique
  
  currentPeriodStart DateTime
  currentPeriodEnd   DateTime
  autoRenew       Boolean   @default(true)
  
  discountCode    String?   // Coupon/promotion
  discountPercent Int       @default(0)
  
  createdAt       DateTime  @default(now())
  canceledAt      DateTime?
  
  usage           SubscriptionUsage?
  invoices        Invoice[]
}

model SubscriptionUsage {
  id              String    @id @default(cuid())
  subscriptionId  String    @unique
  
  apiCallsUsed    Int       @default(0)
  apiCallsLimit   Int       @default(100000)
  
  agentsDeployed  Int       @default(0)
  agentsLimit     Int
  
  storageUsedMb   Int       @default(0)
  storageLimitMb  Int
  
  lastResetAt     DateTime  @default(now())
}
```

---

### 4.3 Sentinel Health & Monitoring

#### Features
- **Sentinel Overview**: Status (healthy/degraded/down), uptime %, last sync
- **Agent Pool**: List all agents deployed, status, last activity, model version
- **Model Performance**: Response time, accuracy, confidence scores (from compliance service)
- **Data Pipeline**: Feed health (broker feeds, market data latency), ingestion rate
- **Alerts & Incidents**: Real-time alerts, incident timeline, escalation
- **Rollback Control**: Deploy new model version or rollback instantly

#### UI Components
```
Sentinel Command Room
├── Status Overview (health gauge, uptime, incident count)
├── Agent Pool
│   ├── Agent List (name, status, model, confidence, last task, actions)
│   ├── Agent Detail (logs, metrics, screen viewer, restart/suspend)
│   └── Bulk Actions (restart all, deploy model, suspend)
├── Model Performance
│   ├── Response Time Chart (p50, p95, p99 over time)
│   ├── Accuracy/Confidence Distribution (histogram)
│   └── Inference Cost (tokens/inference)
├── Data Pipeline
│   ├── Feed Health (broker feeds, latency, gap detection)
│   ├── Ingestion Rate (events/sec, queue depth)
│   └── Alerts on pipeline lag >5min
├── Incident Timeline (sorted by time, drill-down to logs)
└── Model Deploy (version selector, blue-green deploy, canary option)
```

#### Data Model (linked to main TradeW DB via read replica)
```prisma
// In admin DB:
model SentinelStatus {
  id            String    @id @default(cuid())
  overallHealth String    // 'healthy', 'degraded', 'down'
  lastSyncAt    DateTime
  uptime99d     Float     // Percentage
  agentCount    Int
  activeAgents  Int
  avgLatency    Int       // ms
  avgConfidence Float     // 0-1
  updatedAt     DateTime  @updatedAt
}

model AgentSnapshot {
  id            String    @id @default(cuid())
  agentId       String    // From main DB
  agentName     String
  status        String    // 'running', 'idle', 'paused', 'error'
  modelVersion  String
  
  lastTaskAt    DateTime?
  lastTaskName  String?
  
  avgConfidence Float
  totalTasks    Int
  errorCount    Int
  
  screenViewUrl String?   // WebRTC stream or screenshot URL
  screenData    String?   // Encrypted
  
  syncedAt      DateTime
  _syncedFromMainDb Boolean @default(true)
}

model ModelMetric {
  id            String    @id @default(cuid())
  timestamp     DateTime  @default(now())
  
  responseTimeP50  Int
  responseTimeP95  Int
  responseTimeP99  Int
  
  accuracyScore    Float
  confidenceScore  Float
  inferenceTokens Int
  
  agentId       String?   // Per-agent metrics, or null for aggregate
}

model IncidentLog {
  id            String    @id @default(cuid())
  timestamp     DateTime
  severity      String    // 'critical', 'high', 'medium', 'low'
  title         String
  description   String
  rootCause     String?
  
  affectedAgents String[]
  resolvedAt    DateTime?
  resolvedBy    String?   // Admin user ID
  
  logsJson      String    // Compressed JSON blob
  attachments   String[]  // URLs to S3
}
```

---

### 4.4 Real-time Agent Monitoring & Screen Viewer

#### Key Feature: Live Agent Screen Display
This is the **signature feature** — click any agent → see exactly what they're viewing/working on.

#### Implementation
```typescript
// On agent (main TradeW app):
// 1. Capture screen/canvas every 2 sec via:
//    - Canvas screenshot (canvas.toDataURL)
//    - DOM snapshot (via Puppeteer-like lib or simple HTML capture)
//    - Browser tab recording (WebRTC or MP4 stream)

// 2. Send to admin portal via WebSocket
const agentScreenCapture = {
  agentId: 'agent-001',
  timestamp: Date.now(),
  screenFormat: 'webp', // or 'mjpeg' for video
  screenData: base64EncodedImage,
  metadata: {
    mousePos: { x: 100, y: 200 },
    focusedElement: 'search-input',
    scrollPos: { x: 0, y: 300 },
  },
};

// 3. Admin portal displays via WebSocket listener + React component
// Screen appears in floating window or side panel
```

#### UI Components
```
Agent Monitor Dashboard
├── Agent Grid (searchable, filter by status/role, sortable by activity)
│   └── Agent Card
│       ├── Agent name, status light, confidence badge
│       ├── Last task (name, timestamp)
│       ├── Live screen thumbnail (click to expand)
│       └── Quick actions (view full screen, restart, logs, metrics)
│
└── Full Screen Viewer (when clicked)
    ├── Header
    │   ├── Agent name (top-left, as specified)
    │   ├── Status, uptime, task count
    │   └── Actions (pause screen, record, download, close)
    ├── Main Area
    │   ├── Live screen (WebRTC or MJPEG stream)
    │   ├── Overlay: cursor position, keyboard input log (last 10 chars, sanitized)
    │   └── Magnifier tool (zoom into specific area)
    ├── Side Panel
    │   ├── Agent metadata (ID, model, role, last error)
    │   ├── Task queue (current + next 3 tasks)
    │   ├── Metrics (latency, confidence trend, token usage)
    │   ├── Logs (last 50 entries, searchable, filterable by level)
    │   └── Actions (restart, suspend, inject task, kill)
    └── Timeline (scroll through past 1 hour of screen captures, click to freeze)
```

#### Data Model
```prisma
model AgentScreen {
  id            String    @id @default(cuid())
  agentId       String
  timestamp     DateTime  @default(now())
  
  screenFormat  String    // 'webp', 'mjpeg'
  screenDataUrl String    // S3 URL (encrypted)
  
  mouseX        Int
  mouseY        Int
  focusElement  String?
  scrollX       Int
  scrollY       Int
  
  // Store last 1 hour in DB, older → S3 archive
  ttl           DateTime  @default(dbgenerated("now() + interval '1 hour'"))
}

model AgentScreenLog {
  id            String    @id @default(cuid())
  agentId       String
  timestamp     DateTime
  logLevel      String    // 'error', 'warn', 'info', 'debug'
  message       String
  context       Json?
}
```

---

### 4.5 Audit Logs & Compliance

#### Features
- **Log Viewer**: Filter by user, action, timestamp, resource, status
- **Export**: CSV, JSON, with cryptographic signature (for auditor verification)
- **Compliance Reports**: Auto-generate SOC2, ISO 27001, GDPR-readiness reports
- **Data Subject Access Request (DSAR)**: Extract all data for a user, anonymization
- **Retention Policy**: 7-year archive in cold storage, immutable

#### UI Components
```
Compliance & Audit Dashboard
├── Audit Log Viewer
│   ├── Filters (user, action type, date range, resource, status)
│   ├── Table (timestamp, user, action, resource, status, IP, duration)
│   ├── Detail view (full before/after, context, error trace)
│   └── Export (CSV, JSON, signed PDF)
│
├── Compliance Reports
│   ├── SOC2 Type II (uptime, access controls, incident response)
│   ├── ISO 27001 (security controls, risk assessment)
│   ├── GDPR Compliance (data processing, user rights, retention)
│   └── Generate & download PDF
│
└── Data Subject Requests
    ├── Request form (email, reason, scope)
    ├── Status tracker (received, processing, ready for export)
    └── Export (anonymized data, encrypted file)
```

#### Implementation
- **Immutable Audit Table**: Postgres with trigger to prevent updates/deletes (except via admin restore procedure)
- **Event Sourcing** (optional): Store all state changes as events; reconstruct any point-in-time state
- **Compliance API**: Endpoint to generate reports programmatically (for auditor tools)

---

### 4.6 Content Management

#### Features
- **Sentinel Prompts**: Version control for agent system prompts, A/B test prompts
- **Knowledge Base**: Curate documents, FAQs, market research (feed agents & support)
- **Trading Rules & Compliance Policies**: Define what agents can/cannot do
- **Announcements**: Broadcast messages to clients (via email, in-app, dashboard)

#### UI Components
```
Content Studio
├── Prompt Manager
│   ├── List versions (current, drafts, archived)
│   ├── Editor (syntax highlight, version diff)
│   ├── A/B Test setup (split users, measure success metrics)
│   └── Deploy (immediate or scheduled, blue-green)
│
├── Knowledge Base
│   ├── Organize by category (market, compliance, technical)
│   ├── Upload (PDF, markdown, docs)
│   ├── Search & preview
│   └── Vector embed & sync to agent DB
│
├── Rules Engine
│   ├── Define rules (e.g., "no trades after 3:30pm", "max loss 2%")
│   ├── Exceptions & overrides
│   ├── Audit log of rule changes
│   └── Test rules (dry-run against historical data)
│
└── Announcements
    ├── Compose (title, body, channels: email, in-app, dashboard)
    ├── Schedule or send immediately
    ├── Track open/click rates
    └── Archive
```

---

### 4.7 System Monitoring & Alerts

#### Features
- **Infrastructure Metrics**: CPU, memory, disk, network (if self-hosted)
- **API Latency**: Response times to third-party services (Stripe, broker APIs, etc.)
- **Database Health**: Postgres connection pool, slow queries, replication lag
- **Alert Management**: Create/edit/silence alerts, escalation rules, on-call rotation (via PagerDuty or Slack)

#### UI Components
```
System Monitoring Dashboard
├── Infrastructure (if self-hosted)
│   ├── Server health (CPU, mem, disk, network)
│   ├── Container/pod status (if K8s)
│   └── Alert thresholds (editable)
│
├── API Health
│   ├── Dependency dashboard (Stripe, broker APIs, external services)
│   ├── Uptime % over 30 days
│   ├── Latency P50/P95/P99
│   └── Error rate & recent errors
│
├── Database Metrics
│   ├── Query latency
│   ├── Slow query log (top 10)
│   ├── Replication lag (if replicated)
│   └── Connection pool utilization
│
└── Alert Viewer
    ├── Active alerts (sorted by severity)
    ├── Alert detail (rule, threshold, affected resource, action taken)
    ├── Silence alert (1hr, 1day, 1week)
    └── Escalate (notify on-call, create incident)
```

---

## 5. 3D COMMAND CENTER DESIGN

### 5.1 Concept & Atmosphere
**"You are standing in the nerve center of TradeW's AI operation."**

- **Theme**: Crimson (#DC143C) & Deep Black (#0A0E27), glassmorphism, subtle glow
- **Mood**: Professional sci-fi ops room, not gaming (no excessive animations)
- **Camera**: Orbiting 3D scene, can lock/pan to different "rooms"
- **Performance**: 60 FPS on modern hardware; gracefully degrade on lower specs

### 5.2 3D Architecture (React Three Fiber)

#### Main Scene Layout
```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │        CENTRAL HOLOGRAPHIC GLOBE             │   │
│  │   • Real-time market data rotation           │   │
│  │   • User distribution heat map               │   │
│  │   • System status (green/yellow/red pulses)  │   │
│  │   • Click region → zoom into that room       │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐      │
│  │ Engineering│ │  Support   │ │  Finance   │      │
│  │   Room     │ │    Room    │ │    Room    │      │
│  │ (3D layer) │ │ (3D layer) │ │ (3D layer) │      │
│  └────────────┘ └────────────┘ └────────────┘      │
│                                                     │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐      │
│  │ Compliance │ │  Security  │ │     AI     │      │
│  │    Room    │ │    Room    │ │   Brain    │      │
│  │ (3D layer) │ │ (3D layer) │ │  (Central) │      │
│  └────────────┘ └────────────┘ └────────────┘      │
│                                                     │
└─────────────────────────────────────────────────────┘
```

#### Core Components
```typescript
// CommandCenter.tsx (main 3D scene)
export function CommandCenter() {
  return (
    <Canvas
      camera={{ position: [0, 5, 10], fov: 60 }}
      style={{ width: '100vw', height: '100vh' }}
    >
      {/* Lighting */}
      <ambientLight intensity={0.5} color="#DC143C" />
      <pointLight position={[0, 10, 0]} intensity={1.5} color="#fff" />
      
      {/* Central Holographic Globe */}
      <HolographicGlobe />
      
      {/* Room Cards (positioned around globe) */}
      <RoomCard
        position={[-4, 0, 3]}
        title="Engineering"
        status="active"
        agentCount={12}
        onClick={() => setSelectedRoom('engineering')}
      />
      <RoomCard
        position={[4, 0, 3]}
        title="Support"
        status="active"
        agentCount={5}
      />
      {/* ... more rooms ... */}
      
      {/* Data Flow Lines (connecting rooms) */}
      <DataFlowConnections />
      
      {/* Floating Menu (bottom or side) */}
      <FloatingMenu />
    </Canvas>
  );
}

// HolographicGlobe.tsx
export function HolographicGlobe() {
  const globeRef = useRef();
  
  // Rotate globe
  useFrame(() => {
    if (globeRef.current) {
      globeRef.current.rotation.y += 0.0001;
    }
  });
  
  return (
    <group ref={globeRef}>
      {/* Sphere (wireframe) */}
      <mesh>
        <sphereGeometry args={[2, 64, 64]} />
        <meshStandardMaterial
          wireframe
          color="#DC143C"
          emissive="#DC143C"
          emissiveIntensity={0.5}
        />
      </mesh>
      
      {/* Animated system status indicators (particles) */}
      <SystemStatusIndicators />
      
      {/* User distribution heat map */}
      <UserHeatMap data={userDistribution} />
      
      {/* Market regions (clickable) */}
      <MarketRegions />
    </group>
  );
}

// RoomCard.tsx (3D panel in scene)
export function RoomCard({ position, title, status, agentCount, onClick }) {
  const [hovered, setHovered] = useState(false);
  
  return (
    <group position={position} onClick={onClick}>
      {/* Glass panel background */}
      <mesh>
        <boxGeometry args={[1.5, 1.2, 0.1]} />
        <meshStandardMaterial
          transparent
          opacity={0.2}
          color="#DC143C"
          metalness={0.9}
          roughness={0.1}
          emissive="#DC143C"
          emissiveIntensity={hovered ? 0.8 : 0.3}
        />
      </mesh>
      
      {/* Glowing border */}
      <mesh>
        <boxGeometry args={[1.55, 1.25, 0.12]} />
        <meshBasicMaterial
          color="#DC143C"
          transparent
          opacity={hovered ? 0.5 : 0.2}
        />
      </mesh>
      
      {/* Text (title, status, agent count) rendered via canvas texture */}
      <RoomCardText {...{ title, status, agentCount }} />
    </group>
  );
}

// DataFlowConnections.tsx (animated lines between rooms)
export function DataFlowConnections() {
  // Define room positions
  const rooms = [
    { id: 'engineering', pos: [-4, 0, 3] },
    { id: 'support', pos: [4, 0, 3] },
    { id: 'finance', pos: [0, 0, 5] },
    { id: 'brain', pos: [0, 3, 0] },
  ];
  
  return (
    <group>
      {/* Lines between rooms */}
      {rooms.map((room, idx) => (
        <DataFlowLine
          key={idx}
          from={rooms[0].pos}
          to={room.pos}
          intensity={Math.random()}
        />
      ))}
    </group>
  );
}

// DataFlowLine.tsx (animated flow along line)
export function DataFlowLine({ from, to, intensity }) {
  const lineRef = useRef();
  
  useFrame((state) => {
    // Animate particle flow along line
    const t = (state.clock.getElapsedTime() * 0.5) % 1;
    // ... interpolate position and update particle
  });
  
  return (
    <line>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={2}
          array={new Float32Array([...from, ...to])}
          itemSize={3}
        />
      </bufferGeometry>
      <lineBasicMaterial
        color="#DC143C"
        linewidth={2}
        opacity={intensity}
      />
    </line>
  );
}
```

### 5.3 Glassmorphism & Glow Effects
```css
/* Tailwind config for theme */
module.exports = {
  theme: {
    extend: {
      colors: {
        'crimson-primary': '#DC143C',
        'black-dark': '#0A0E27',
        'glass-light': 'rgba(220, 20, 60, 0.1)',
      },
      backdropFilter: {
        'glass': 'backdrop-blur(10px) brightness(0.8)',
      },
      boxShadow: {
        'crimson-glow': '0 0 20px rgba(220, 20, 60, 0.5)',
      },
    },
  },
};

/* Components */
.glass-panel {
  background: rgba(220, 20, 60, 0.1);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(220, 20, 60, 0.3);
  box-shadow: 0 0 20px rgba(220, 20, 60, 0.3);
  border-radius: 12px;
}

.glow-text {
  color: #DC143C;
  text-shadow: 0 0 10px rgba(220, 20, 60, 0.8);
}
```

---

## 6. LIVING AI HEADQUARTERS (3D ROOMS)

### 6.1 Room Concept
Each **departmental room** is a 3D visualization of that team's work, with animated AI agents.

#### Room Types & Data
```typescript
interface Room {
  id: string;
  name: string;                    // 'engineering', 'support', 'finance', etc.
  agents: AgentInRoom[];           // Agents currently working
  tasks: Task[];                   // Tasks in progress
  metrics: RoomMetrics;
  dataFlows: DataFlow[];           // Connections to other rooms
}

interface AgentInRoom {
  id: string;
  name: string;
  status: 'working' | 'idle' | 'error';
  currentTask: Task;
  position: [x, y, z];             // In 3D space
  avatar: string;                  // 3D model or icon
}

interface RoomMetrics {
  tasksCompleted: number;
  avgTaskTime: number;
  errorRate: number;
  activeAgents: number;
}
```

### 6.2 Engineering Room
```typescript
// What you see:
// - Whiteboard (2D) with current sprint tasks
// - 3 agent avatars at desks (representing engineering specialists)
// - Code review board (pull requests live)
// - Test results dashboard (green/red bars)
// - Deployment timeline (continuous integration)

export function EngineeringRoom() {
  return (
    <group>
      {/* Room geometry */}
      <RoomGeometry color="#00FF00" wallGloss={0.3} />
      
      {/* Workstations */}
      <Workstation position={[-2, 0, 0]} agentName="Agent-Backend" />
      <Workstation position={[0, 0, 0]} agentName="Agent-Frontend" />
      <Workstation position={[2, 0, 0]} agentName="Agent-QA" />
      
      {/* Whiteboard (sprint board) */}
      <SprintBoard
        tasks={engTasks}
        columns={['todo', 'in-progress', 'review', 'done']}
      />
      
      {/* Code review board */}
      <CodeReviewBoard prs={pullRequests} />
      
      {/* Test results */}
      <TestDashboard results={testResults} />
      
      {/* CI/CD timeline */}
      <DeploymentTimeline deployments={deployments} />
    </group>
  );
}
```

### 6.3 Support Room
```typescript
// What you see:
// - Ticket queue (animated cards flowing in)
// - 2-3 support agents at desks
// - Customer satisfaction gauge
// - Average response time counter
// - Recent tickets on display

export function SupportRoom() {
  return (
    <group>
      <RoomGeometry color="#00AAFF" />
      
      {/* Support desks */}
      <SupportDesk position={[-1, 0, 0]} agentName="Agent-Support-1" />
      <SupportDesk position={[1, 0, 0]} agentName="Agent-Support-2" />
      
      {/* Ticket queue (incoming tickets animate in) */}
      <TicketQueue tickets={supportTickets} />
      
      {/* Customer satisfaction */}
      <SatisfactionGauge score={customerSatisfaction} />
      
      {/* Response time tracker */}
      <ResponseTimeCounter avgTime={avgResponseTime} />
    </group>
  );
}
```

### 6.4 Finance Room
```typescript
// What you see:
// - Revenue dashboard (real-time MRR, ARR)
// - Cash flow visualization (inflows/outflows)
// - Subscription metrics (churn, LTV)
// - Budget tracker
// - 1-2 finance agents managing

export function FinanceRoom() {
  return (
    <group>
      <RoomGeometry color="#FFD700" />
      
      {/* Finance dashboard panels */}
      <MRRDisplay value={mrr} />
      <ARRDisplay value={arr} />
      
      {/* Cash flow graph (3D bars) */}
      <CashFlowVisualization
        inflows={monthlyInflows}
        outflows={monthlyOutflows}
      />
      
      {/* Subscription metrics */}
      <SubscriptionMetrics
        churnRate={churnRate}
        ltv={ltv}
        customerCount={customerCount}
      />
      
      {/* Finance agents */}
      <FinanceDesk position={[0, 0, 0]} agentName="Agent-Finance" />
    </group>
  );
}
```

### 6.5 Security Room
```typescript
// What you see:
// - Security alerts (real-time, color-coded by severity)
// - System logs flowing (matrix-style)
// - Network topology (nodes for services, edges for connections)
// - Threat intelligence (recent incidents)
// - 1 security agent monitoring

export function SecurityRoom() {
  return (
    <group>
      <RoomGeometry color="#FF6347" />
      
      {/* Alert board */}
      <AlertBoard alerts={securityAlerts} />
      
      {/* System logs (text matrix effect) */}
      <LogsMatrix logs={recentLogs} />
      
      {/* Network topology */}
      <NetworkTopology
        nodes={services}
        edges={connections}
      />
      
      {/* Threat intelligence */}
      <ThreatIntelligence incidents={incidents} />
      
      {/* Security agent */}
      <SecurityDesk position={[0, 0, 0]} agentName="Agent-Security" />
    </group>
  );
}
```

### 6.6 Compliance Room
```typescript
// What you see:
// - Audit log viewer (flowing entries)
// - Compliance checklist (SOC2, GDPR, ISO)
// - Policy dashboard
// - Data retention tracker
// - 1 compliance agent

export function ComplianceRoom() {
  return (
    <group>
      <RoomGeometry color="#9932CC" />
      
      {/* Audit log flow */}
      <AuditLogFlow logs={auditLogs} />
      
      {/* Compliance checklist */}
      <ComplianceChecklist
        soc2={soc2Status}
        gdpr={gdprStatus}
        iso27001={iso27001Status}
      />
      
      {/* Policy board */}
      <PolicyBoard policies={policies} />
      
      {/* Data retention */}
      <DataRetentionTracker retention={retentionData} />
      
      {/* Compliance agent */}
      <ComplianceDesk position={[0, 0, 0]} agentName="Agent-Compliance" />
    </group>
  );
}
```

### 6.7 Central AI Brain
```typescript
// What you see:
// - Neural network visualization (nodes = services, edges = calls)
// - Decision tree (current decisions being made)
// - Task distribution (load across agents)
// - Memory & knowledge graph
// - System heartbeat (pulsing core)

export function AIBrain() {
  return (
    <group position={[0, 3, 0]}>
      {/* Central sphere (pulsing core) */}
      <mesh>
        <sphereGeometry args={[0.5, 32, 32]} />
        <meshStandardMaterial
          color="#DC143C"
          emissive="#FF6347"
          emissiveIntensity={0.9}
        />
      </mesh>
      
      {/* Neural network nodes & connections */}
      <NeuralNetwork
        nodes={services}
        connections={apiCalls}
      />
      
      {/* Decision tree */}
      <DecisionTree decisions={currentDecisions} />
      
      {/* Task distribution */}
      <TaskDistribution tasks={allTasks} />
      
      {/* Knowledge graph visualization */}
      <KnowledgeGraph entities={knowledgeEntities} />
    </group>
  );
}
```

### 6.8 Room Navigation
```typescript
export function RoomNavigator() {
  const [selectedRoom, setSelectedRoom] = useState('central');
  
  return (
    <div className="room-navigator">
      {/* Bottom/side menu */}
      <button onClick={() => setSelectedRoom('central')}>
        Command Center
      </button>
      <button onClick={() => setSelectedRoom('engineering')}>
        🔧 Engineering
      </button>
      <button onClick={() => setSelectedRoom('support')}>
        🎧 Support
      </button>
      <button onClick={() => setSelectedRoom('finance')}>
        💰 Finance
      </button>
      <button onClick={() => setSelectedRoom('security')}>
        🔒 Security
      </button>
      <button onClick={() => setSelectedRoom('compliance')}>
        ✅ Compliance
      </button>
      <button onClick={() => setSelectedRoom('brain')}>
        🧠 AI Brain
      </button>
      
      {/* Camera zoom to selected room */}
      <CameraController targetRoom={selectedRoom} />
    </div>
  );
}
```

---

## 7. REAL-TIME DATA & WEBSOCKET ARCHITECTURE

### 7.1 WebSocket Events
```typescript
// Events streaming from main TradeW app to Admin Portal

// Agent status change
event: 'agent:status-changed'
payload: {
  agentId: string,
  newStatus: 'running' | 'idle' | 'paused' | 'error',
  previousStatus: string,
  timestamp: Date,
}

// Agent screen capture
event: 'agent:screen-capture'
payload: {
  agentId: string,
  screenDataUrl: string,
  timestamp: Date,
  metadata: { mouseX, mouseY, focusElement },
}

// Task completed
event: 'task:completed'
payload: {
  taskId: string,
  agentId: string,
  result: any,
  duration: number,
  confidence: number,
  timestamp: Date,
}

// Sentinel alert
event: 'sentinel:alert'
payload: {
  severity: 'critical' | 'high' | 'medium' | 'low',
  title: string,
  description: string,
  affectedAgents: string[],
  timestamp: Date,
}

// System metric update
event: 'system:metric-update'
payload: {
  metric: string, // 'cpu', 'memory', 'latency', etc.
  value: number,
  timestamp: Date,
}

// Subscription usage
event: 'subscription:usage-update'
payload: {
  clientId: string,
  apiCallsUsed: number,
  storageUsedMb: number,
  timestamp: Date,
}
```

### 7.2 WebSocket Client (React)
```typescript
// hooks/useAdminWebSocket.ts
export function useAdminWebSocket() {
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState('connecting');
  
  useEffect(() => {
    const ws = new WebSocket(
      `wss://admin.tradew.io/api/ws?token=${getAuthToken()}`
    );
    
    ws.onopen = () => setStatus('connected');
    ws.onclose = () => setStatus('disconnected');
    ws.onerror = () => setStatus('error');
    
    setSocket(ws);
    
    return () => ws.close();
  }, []);
  
  const subscribe = (event, callback) => {
    if (socket) {
      socket.addEventListener('message', (e) => {
        const { type, payload } = JSON.parse(e.data);
        if (type === event) callback(payload);
      });
    }
  };
  
  return { socket, status, subscribe };
}

// Usage in component
export function AgentMonitor() {
  const { subscribe } = useAdminWebSocket();
  const [agents, setAgents] = useState([]);
  
  useEffect(() => {
    subscribe('agent:status-changed', (payload) => {
      setAgents((prev) =>
        prev.map((a) =>
          a.id === payload.agentId ? { ...a, status: payload.newStatus } : a
        )
      );
    });
    
    subscribe('agent:screen-capture', (payload) => {
      setAgentScreen(payload.agentId, payload.screenDataUrl);
    });
  }, [subscribe]);
  
  return <AgentGrid agents={agents} />;
}
```

---

## 8. IMPLEMENTATION PHASES

### Phase 1: Foundation & Authentication (Weeks 1-2)
**Goal**: Secure backbone, user management, basic auth

- [ ] Create `tw-admin` repo
- [ ] Set up Next.js project structure (pages, API routes)
- [ ] Implement RBAC middleware & permission checks
- [ ] Build admin user model (Prisma schema)
- [ ] Authentication endpoints (login, logout, reset password)
- [ ] MFA setup (TOTP, recovery codes)
- [ ] IP allow-list enforcement
- [ ] Session management (JWT + Redis, or opaque tokens)
- [ ] Deploy to staging (`admin.tradew.dev`)
- [ ] **Deliverables**: Login page, user management UI, auth endpoints

### Phase 2: Admin User Interface (Weeks 3-4)
**Goal**: Core admin panels, user management, basic monitoring

- [ ] User management dashboard (CRUD users, roles, reset MFA)
- [ ] Subscription management (view plans, clients, usage)
- [ ] Sentinel health overview (status, agent pool, basic metrics)
- [ ] Audit log viewer (filter, export)
- [ ] Floating navigation menu (basic, not 3D yet)
- [ ] Tailwind styling + Crimson theme
- [ ] **Deliverables**: Admin dashboard functional, users can manage team

### Phase 3: 3D Command Center (Weeks 5-6)
**Goal**: Holographic globe, room cards, 3D foundation

- [ ] Set up React Three Fiber project
- [ ] Build central holographic globe (wireframe, rotation)
- [ ] Create room cards (glassmorphism, glow effects)
- [ ] Implement camera controls (orbit, zoom, pan)
- [ ] Add floating menu navigation
- [ ] Room selector (click card → zoom to room)
- [ ] WebSocket connection to main app
- [ ] **Deliverables**: 3D command center renders, rooms clickable

### Phase 4: Room Visualization (Weeks 7-8)
**Goal**: Populate rooms with agents, tasks, real data

- [ ] Engineering room (sprint board, code review, test results)
- [ ] Support room (ticket queue, satisfaction gauge)
- [ ] Finance room (revenue dashboard, cash flow)
- [ ] Security room (alert board, network topology)
- [ ] Compliance room (audit log, checklist)
- [ ] Central AI brain (neural network, decision tree)
- [ ] Connect to real Sentinel data via WebSocket
- [ ] **Deliverables**: All rooms rendering live data

### Phase 5: Agent Monitoring & Screen Viewer (Weeks 9-10)
**Goal**: View live agent screens, task queue, logs

- [ ] Agent registry (list all agents, status)
- [ ] Screen capture mechanism (canvas, DOM, WebRTC)
- [ ] Full-screen viewer modal (agent name, status, logs)
- [ ] Log viewer (searchable, filterable, tail)
- [ ] Action buttons (restart, suspend, inject task, kill)
- [ ] Screen timeline (scroll through past captures)
- [ ] **Deliverables**: Click agent → see live screen + logs

### Phase 6: Subscription & Compliance (Weeks 11-12)
**Goal**: Billing, usage tracking, compliance reports

- [ ] Subscription CRUD (create, update, cancel plans)
- [ ] Usage tracking (API calls, agents, storage)
- [ ] Stripe integration (webhooks, invoicing)
- [ ] Compliance report generator (SOC2, GDPR, ISO)
- [ ] Data subject access requests (DSAR) flow
- [ ] **Deliverables**: Finance can manage subscriptions, compliance reports auto-gen

### Phase 7: Content Management (Weeks 13-14)
**Goal**: Prompts, knowledge base, trading rules

- [ ] Prompt version control & editor
- [ ] A/B test setup for prompts
- [ ] Knowledge base (upload, search, vector embed)
- [ ] Trading rules engine (define, test, deploy)
- [ ] Announcements (compose, schedule, track)
- [ ] **Deliverables**: Content studio functional, promptable

### Phase 8: Hardening & Monitoring (Weeks 15-16)
**Goal**: Security, performance, observability

- [ ] Penetration testing (contract or internal)
- [ ] Security audit checklist
- [ ] Rate limiting & DDoS mitigation
- [ ] Logging & alerting for admin portal
- [ ] Grafana/Prometheus setup (if self-hosted)
- [ ] Load testing (concurrent users, concurrent WebSocket connections)
- [ ] Incident response playbook
- [ ] **Deliverables**: Portal hardened, monitoring in place

### Phase 9: Polish & Deployment (Weeks 17-18)
**Goal**: Production-ready, full testing, go-live

- [ ] E2E tests (Playwright) for critical flows
- [ ] Accessibility audit (WCAG 2.1 AA compliance)
- [ ] Mobile responsiveness (if needed; admin often desktop-first)
- [ ] Dark mode support (Tailwind already in place)
- [ ] Performance optimization (lazy load 3D, compress assets)
- [ ] Documentation (API docs, admin runbook, troubleshooting)
- [ ] Deploy to production (`admin.tradew.io`)
- [ ] **Deliverables**: Portal live, team trained, runbooks documented

### Phase 10: Extensibility & Connectors (Weeks 19+)
**Goal**: Plugin architecture, third-party integrations

- [ ] Plugin system (load custom room renderers, dashboards)
- [ ] Webhook support (external systems can trigger admin actions)
- [ ] Custom integrations (Slack alerts, PagerDuty escalation, etc.)
- [ ] API versioning & backward compatibility
- [ ] **Deliverables**: Community-ready, extensible platform

---

## 9. DATABASE SCHEMA (Prisma)

```prisma
// prisma/schema.prisma

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// ============= AUTHENTICATION & AUTHORIZATION =============

enum Role {
  SUPER_ADMIN
  SUPPORT
  FINANCE
  OPS
  COMPLIANCE
  CLIENT
}

model AdminUser {
  id                 String        @id @default(cuid())
  email              String        @unique
  passwordHash       String
  role               Role
  customPermissions  String[]      // Override role defaults
  
  // MFA
  mfaEnabled         Boolean       @default(false)
  mfaSecret          String?       // Encrypted TOTP secret
  mfaRecoveryCodes   String[]      // Encrypted, one-time use
  
  // IP allow-list
  ipAllowList        String[]      // CIDR ranges
  
  // Status
  isActive           Boolean       @default(true)
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  lastLoginAt        DateTime?
  lastLoginIp        String?
  deactivatedAt      DateTime?
  
  // Relations
  sessions           AdminSession[]
  auditLogs          AuditLog[]
  preferences        UserPreference?
  
  @@index([email])
}

model AdminSession {
  id                 String        @id @default(cuid())
  userId             String
  user               AdminUser     @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  token              String        @unique
  expiresAt          DateTime
  lastActivity       DateTime      @default(now())
  
  ipAddress          String
  userAgent          String
  
  mfaVerified        Boolean       @default(false)
  mfaVerifiedAt      DateTime?
  
  riskScore          Int           @default(0) // 0-100
  
  createdAt          DateTime      @default(now())
  
  @@index([userId])
  @@index([expiresAt])
}

model UserPreference {
  id                 String        @id @default(cuid())
  userId             String        @unique
  user               AdminUser     @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  theme              String        @default("dark") // 'dark', 'light'
  sidebarCollapsed   Boolean       @default(false)
  defaultView        String        @default("dashboard")
  
  notificationPrefs  Json          @default("{}")
  
  updatedAt          DateTime      @updatedAt
}

// ============= AUDIT LOGGING =============

model AuditLog {
  id                 String        @id @default(cuid())
  timestamp          DateTime      @default(now())
  
  userId             String
  user               AdminUser     @relation(fields: [userId], references: [id], onDelete: SetNull)
  
  role               Role
  action             String        // 'user_created', 'subscription_updated', etc.
  resource           String        // 'users', 'subscriptions', 'agents'
  resourceId         String
  
  before             Json?         // Previous state (PII redacted)
  after              Json?         // New state (PII redacted)
  
  ipAddress          String
  userAgent          String
  
  status             String        @default("success") // 'success', 'failure'
  errorMessage       String?
  
  durationMs         Int           // How long the action took
  tags               String[]      // 'security', 'compliance', 'high-risk'
  
  ttl                DateTime?     // 7-year retention
  
  @@index([userId])
  @@index([timestamp])
  @@index([action])
  @@index([resource])
}

// ============= SUBSCRIPTIONS & BILLING =============

enum PlanTier {
  FREE
  STARTER
  PRO
  ENTERPRISE
}

enum SubscriptionStatus {
  ACTIVE
  CANCELED
  PAST_DUE
  EXPIRED
}

model Plan {
  id                 String        @id @default(cuid())
  tier               PlanTier      @unique
  name               String
  description        String?
  
  monthlyPrice       Int           // in cents
  yearlyPrice        Int?
  
  features           Json          // Feature flags & limits
  
  apiCallsLimit      Int
  agentsLimit        Int
  storageLimitMb     Int
  
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  
  subscriptions      Subscription[]
}

model Subscription {
  id                 String        @id @default(cuid())
  clientId           String
  clientEmail        String
  planId             String
  plan               Plan          @relation(fields: [planId], references: [id])
  
  status             SubscriptionStatus @default(ACTIVE)
  stripeSubId        String?       @unique
  
  currentPeriodStart DateTime
  currentPeriodEnd   DateTime
  autoRenew          Boolean       @default(true)
  
  discountCode       String?
  discountPercent    Int           @default(0)
  
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  canceledAt         DateTime?
  
  usage              SubscriptionUsage?
  invoices           Invoice[]
  
  @@index([clientId])
  @@index([status])
}

model SubscriptionUsage {
  id                 String        @id @default(cuid())
  subscriptionId     String        @unique
  subscription       Subscription  @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)
  
  apiCallsUsed       Int           @default(0)
  agentsDeployed     Int           @default(0)
  storageUsedMb      Int           @default(0)
  
  lastResetAt        DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
}

model Invoice {
  id                 String        @id @default(cuid())
  subscriptionId     String
  subscription       Subscription  @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)
  
  invoiceNumber      String        @unique
  stripeInvoiceId    String?       @unique
  
  amountCents        Int
  currencyCode       String        @default("USD")
  
  issuedAt           DateTime      @default(now())
  dueAt              DateTime
  paidAt             DateTime?
  
  status             String        // 'draft', 'sent', 'paid', 'overdue'
  
  items              InvoiceItem[]
  
  @@index([subscriptionId])
  @@index([status])
}

model InvoiceItem {
  id                 String        @id @default(cuid())
  invoiceId          String
  invoice            Invoice       @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  
  description        String
  quantity           Int
  unitPrice          Int           // in cents
  
  totalPrice         Int           // in cents
}

// ============= SENTINEL & AGENTS =============

enum AgentStatus {
  RUNNING
  IDLE
  PAUSED
  ERROR
  OFFLINE
}

model AgentSnapshot {
  id                 String        @id @default(cuid())
  agentId            String        @unique
  agentName          String
  
  status             AgentStatus   @default(IDLE)
  modelVersion       String
  
  lastTaskAt         DateTime?
  lastTaskName       String?
  
  avgConfidence      Float         @default(0)
  totalTasks         Int           @default(0)
  errorCount         Int           @default(0)
  
  screenViewUrl      String?       // WebRTC or screenshot URL
  screenDataEncrypted String?      // Encrypted blob
  
  roomId             String?       // Which room this agent belongs to
  
  syncedAt           DateTime      @default(now())
  
  @@index([agentId])
  @@index([status])
}

model AgentScreen {
  id                 String        @id @default(cuid())
  agentId            String
  timestamp          DateTime      @default(now())
  
  screenFormat       String        // 'webp', 'mjpeg'
  screenDataUrl      String        // S3 URL
  
  mouseX             Int
  mouseY             Int
  focusElement       String?
  scrollX            Int
  scrollY            Int
  
  ttl                DateTime      // Auto-delete after 1 hour
  
  @@index([agentId])
  @@index([timestamp])
}

model ModelMetric {
  id                 String        @id @default(cuid())
  timestamp          DateTime      @default(now())
  
  responseTimeP50    Int
  responseTimeP95    Int
  responseTimeP99    Int
  
  accuracyScore      Float
  confidenceScore    Float
  inferenceTokens   Int
  
  agentId            String?       // NULL = aggregate
  
  @@index([agentId])
  @@index([timestamp])
}

model IncidentLog {
  id                 String        @id @default(cuid())
  timestamp          DateTime      @default(now())
  
  severity           String        // 'critical', 'high', 'medium', 'low'
  title              String
  description        String
  rootCause          String?
  
  affectedAgents     String[]
  
  resolvedAt         DateTime?
  resolvedBy         String?
  
  logsJson           String        // Compressed JSON
  attachmentsUrl     String[]
  
  @@index([timestamp])
  @@index([severity])
}

// ============= CONTENT & KNOWLEDGE =============

model Prompt {
  id                 String        @id @default(cuid())
  name               String
  description        String?
  
  version            Int           @default(1)
  content            String        // Prompt text
  
  status             String        @default("draft") // 'draft', 'active', 'archived'
  isActive           Boolean       @default(false)
  
  createdBy          String
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  deployedAt         DateTime?
  
  abTests            PromptABTest[]
  
  @@index([status])
}

model PromptABTest {
  id                 String        @id @default(cuid())
  promptId           String
  prompt             Prompt        @relation(fields: [promptId], references: [id], onDelete: Cascade)
  
  nameA              String
  nameB              String
  versionA           Int
  versionB           Int
  
  splitPercent       Int           @default(50) // % going to variant A
  status             String        @default("running")
  
  startedAt          DateTime      @default(now())
  endedAt            DateTime?
  
  metricsA           Json?
  metricsB           Json?
  winner             String?       // 'A', 'B', or null if tie
  
  @@index([promptId])
}

model KnowledgeItem {
  id                 String        @id @default(cuid())
  title              String
  category           String
  
  content            String        // Markdown or text
  embedding          Decimal[]     // Vector (if using pgvector)
  
  source             String?       // File URL or citation
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  
  @@index([category])
}

model TradingRule {
  id                 String        @id @default(cuid())
  name               String
  description        String?
  
  condition          String        // Rule logic (e.g., JSON schema)
  action             String        // What to do if condition is true
  
  enabled            Boolean       @default(true)
  priority           Int           @default(0)
  
  createdBy          String
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
  
  @@index([enabled])
}

model Announcement {
  id                 String        @id @default(cuid())
  title              String
  body               String        // Markdown
  
  channels           String[]      // 'email', 'in-app', 'dashboard'
  status             String        @default("draft")
  
  scheduledFor       DateTime?
  sentAt             DateTime?
  
  openCount          Int           @default(0)
  clickCount         Int           @default(0)
  
  createdBy          String
  createdAt          DateTime      @default(now())
  
  @@index([status])
  @@index([sentAt])
}

// ============= COMPLIANCE & DATA =============

model ComplianceReport {
  id                 String        @id @default(cuid())
  reportType         String        // 'SOC2', 'GDPR', 'ISO27001'
  
  generatedAt        DateTime      @default(now())
  generatedBy        String
  
  content            String        // PDF or JSON report
  signatureHash      String        // Cryptographic signature
  
  @@index([reportType])
}

model DataSubjectRequest {
  id                 String        @id @default(cuid())
  subjectEmail       String
  reason             String
  
  status             String        @default("received") // 'received', 'processing', 'ready', 'exported'
  requestedAt        DateTime      @default(now())
  processedAt        DateTime?
  
  exportUrl          String?       // URL to encrypted download
  expiresAt          DateTime?
  
  requestedBy        String        // Admin who filed it
  
  @@index([status])
  @@index([subjectEmail])
}

// Add more models as needed for system configuration, integrations, etc.
```

---

## 10. API ENDPOINTS (Next.js Routes)

```
// Auth
POST   /api/auth/login                    // Email + password → JWT
POST   /api/auth/logout                   // Revoke session
POST   /api/auth/mfa/setup                // Setup TOTP
POST   /api/auth/mfa/verify               // Verify TOTP code
POST   /api/auth/password-reset           // Send reset email
POST   /api/auth/ip-allowlist             // Manage IP list (SUPER_ADMIN)

// Users
GET    /api/users                         // List users (filterable)
POST   /api/users                         // Create user (SUPER_ADMIN)
GET    /api/users/:id                     // User detail
PATCH  /api/users/:id                     // Edit user
DELETE /api/users/:id                     // Soft delete user
POST   /api/users/:id/reset-mfa           // Reset MFA (SUPPORT, SUPER_ADMIN)

// Subscriptions
GET    /api/subscriptions                 // List (filterable)
POST   /api/subscriptions                 // Create (FINANCE, SUPER_ADMIN)
GET    /api/subscriptions/:id             // Detail
PATCH  /api/subscriptions/:id             // Update plan/discount
DELETE /api/subscriptions/:id             // Cancel
GET    /api/subscriptions/:id/usage       // Usage metrics

// Agents
GET    /api/agents                        // List all agents
GET    /api/agents/:id                    // Agent detail
GET    /api/agents/:id/screen             // Live screen via WebSocket
GET    /api/agents/:id/logs               // Agent logs (paginated)
POST   /api/agents/:id/restart            // Restart agent (OPS, SUPER_ADMIN)
POST   /api/agents/:id/suspend            // Suspend agent

// Sentinel
GET    /api/sentinel/status               // Overall health
GET    /api/sentinel/metrics              // Performance metrics
POST   /api/sentinel/model/deploy         // Deploy model version (OPS)
POST   /api/sentinel/model/rollback       // Rollback model

// Audit
GET    /api/audit/logs                    // Fetch audit logs (COMPLIANCE)
POST   /api/audit/logs/export             // Export as CSV/JSON

// Compliance
POST   /api/compliance/report/soc2        // Generate SOC2 report
POST   /api/compliance/report/gdpr        // Generate GDPR report
POST   /api/compliance/dsar               // Data subject request
GET    /api/compliance/dsar/:id/export    // Download DSAR export

// Content
GET    /api/prompts                       // List prompts
POST   /api/prompts                       // Create prompt (SUPER_ADMIN)
PATCH  /api/prompts/:id                   // Update prompt
POST   /api/prompts/:id/deploy            // Deploy as active
POST   /api/prompts/:id/ab-test           // Start A/B test

GET    /api/knowledge                     // Search knowledge base
POST   /api/knowledge                     // Upload document
GET    /api/knowledge/:id                 // Download document

GET    /api/rules                         // List trading rules
POST   /api/rules                         // Create rule (COMPLIANCE, SUPER_ADMIN)
POST   /api/rules/:id/test                // Test rule against historical data

GET    /api/announcements                 // List announcements
POST   /api/announcements                 // Create (SUPER_ADMIN)
POST   /api/announcements/:id/send        // Send immediately

// WebSocket
WS     /api/ws                            // Live agent updates, metrics
```

---

## 11. EXTENSIBILITY & FUTURE CONNECTORS

### 11.1 Plugin Architecture
```typescript
// plugins/index.ts
export interface AdminPlugin {
  name: string;
  version: string;
  description: string;
  
  // React component to render in its own room or dashboard
  Component: React.ComponentType<AdminPluginProps>;
  
  // WebSocket event handlers (optional)
  onEvent?: (event: WSEvent) => void;
  
  // Settings/configuration
  settings?: PluginSettings;
}

export interface AdminPluginProps {
  agentData: AgentSnapshot[];
  metrics: SystemMetrics;
  onAction: (action: string, payload: any) => Promise<void>;
}

// Example: Custom trading dashboard plugin
export const CustomTradingDashboard: AdminPlugin = {
  name: 'Custom Trading Dashboard',
  version: '1.0.0',
  description: 'Real-time P&L, position monitoring, trade alerts',
  
  Component: ({ agentData, metrics, onAction }) => (
    <div className="custom-trading-dashboard">
      {/* Custom 3D visualization, charts, etc. */}
    </div>
  ),
};
```

### 11.2 Webhook Support
```typescript
// Admin can configure webhooks that fire on events

interface Webhook {
  id: string;
  url: string;
  events: string[]; // 'agent:error', 'sentiment:alert', etc.
  secret: string;   // HMAC signature
  active: boolean;
}

// Example: Send incident to Slack
POST /api/webhooks/configure
{
  "url": "https://hooks.slack.com/services/...",
  "events": ["sentinel:alert"],
  "secret": "sk-...",
  "active": true
}

// When event fires, admin portal POSTs to URL with HMAC signature
POST https://hooks.slack.com/services/...
{
  "type": "sentinel:alert",
  "payload": { ... },
  "timestamp": 123456789,
  "signature": "sha256=..."
}
```

### 11.3 Third-Party Integrations
- **PagerDuty**: Auto-escalate critical incidents
- **Slack**: Alert notifications, admin commands via slash commands
- **Datadog/New Relic**: Sync metrics, correlated dashboarding
- **Stripe**: Billing webhook sync (already integrated)
- **GitHub**: Link admin portal to code deployments (commit → deploy info)

---

## 12. FEATURE ROADMAP

### 2025 Q1 (Immediate)
- [ ] Phases 1-3 complete (Auth + Admin UI + 3D Foundation)
- [ ] Core security hardening
- [ ] Initial agent monitoring

### 2025 Q2
- [ ] Phases 4-5 complete (Rooms + Agent Screen Viewer)
- [ ] Subscription management
- [ ] Compliance reporting

### 2025 Q3
- [ ] Phase 6-7 complete (Content Management + Hardening)
- [ ] Production deployment
- [ ] Team training

### 2025 Q4+
- [ ] Plugin architecture
- [ ] Advanced analytics (ML-powered insights)
- [ ] Mobile app (read-only)
- [ ] Multi-admin organization hierarchy
- [ ] Custom room templates (users design their own rooms)

---

## 13. SECURITY CHECKLIST

### Pre-Launch
- [ ] Penetration test (external firm or bug bounty)
- [ ] OWASP Top 10 audit
- [ ] Secrets scanning (git, env vars)
- [ ] Dependency vulnerability scan (npm audit, Snyk)
- [ ] Authentication flow review (OWASP AuthN/AuthZ)
- [ ] Encryption audit (at rest, in transit, key management)
- [ ] Access control audit (RBAC correctness)
- [ ] Audit logging completeness
- [ ] Incident response plan
- [ ] Data retention policy
- [ ] Privacy audit (GDPR, CCPA compliance)

### Ongoing
- [ ] Monthly security updates
- [ ] Quarterly penetration tests
- [ ] Continuous vulnerability scanning
- [ ] Incident response drills
- [ ] Admin activity review (weekly)
- [ ] MFA compliance checks
- [ ] IP allow-list audits

---

## 14. DEPLOYMENT & DEVOPS

### Infrastructure (AWS example)
```
admin.tradew.io
├── Route53 (DNS)
├── CloudFront (CDN)
├── ALB (load balancer)
├── ECS (containerized Next.js)
│   ├── web (frontend)
│   └── api (backend)
├── RDS Postgres (admin DB)
├── Elasticache Redis (sessions)
├── S3 (screenshots, exports)
└── Secrets Manager (env vars, keys)

Networking
├── VPC (isolated)
├── Security groups (inbound/outbound rules)
├── NACLs (network ACLs)
└── WAF (web application firewall)

Monitoring
├── CloudWatch (logs, metrics, alarms)
├── X-Ray (distributed tracing)
├── Trusted Advisor (best practices)
└── GuardDuty (threat detection)
```

### Docker
```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

### Kubernetes (if scaling)
```yaml
# k8s/admin-portal.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tw-admin
spec:
  replicas: 3
  selector:
    matchLabels:
      app: tw-admin
  template:
    metadata:
      labels:
        app: tw-admin
    spec:
      containers:
      - name: tw-admin
        image: tw-admin:latest
        ports:
        - containerPort: 3000
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
```

### CI/CD (GitHub Actions example)
```yaml
# .github/workflows/deploy.yml
name: Deploy to Staging

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - uses: actions/setup-node@v3
      with:
        node-version: '20'
    - run: npm ci
    - run: npm run test
    - run: npm run lint
    - run: npm run build
    
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - name: Deploy to staging
      run: |
        aws ecs update-service \
          --cluster tw-admin-staging \
          --service tw-admin \
          --force-new-deployment
```

---

## 15. TEAM & RESPONSIBILITIES

| Role | Responsibilities |
|------|------------------|
| **Engineering Lead** | Overall architecture, code review, 3D rendering |
| **Backend Engineer** | API design, Prisma schema, WebSocket, auth |
| **Frontend Engineer** | Next.js pages, React components, forms, theming |
| **3D Engineer** | React Three Fiber, room design, animations, performance |
| **Security Engineer** | MFA, encryption, audit logs, penetration testing |
| **DevOps Engineer** | Deployment, monitoring, scaling, disaster recovery |
| **Product Manager** | Feature prioritization, phase planning, stakeholder alignment |
| **QA Engineer** | Testing (E2E, security), incident reproduction, checklists |

---

## 16. CONCLUSION

The TradeW Admin Portal is far more than a dashboard—it's the **living headquarters** of your AI operations. By combining real administrative control with immersive 3D visualization, you create a **unique, professional command center** that reinforces TradeW's identity as a cutting-edge fintech AI platform.

This blueprint covers **architecture, security, phases, UI, data, extensibility, and deployment**. Each phase builds incrementally, so you have a working portal at every step.

**Key Success Criteria:**
1. ✅ Secure (MFA, RBAC, audit, encryption)
2. ✅ Real (live agent screens, metrics, incidents)
3. ✅ Beautiful (3D command center, Crimson theme, glassmorphism)
4. ✅ Scalable (plugin architecture, extensible, supports growth)
5. ✅ Operational (manages users, subscriptions, compliance, content)

Ship it in phases, gather feedback, iterate. Your admin portal becomes the nerve center of TradeW.

**Next Step**: Draft Phase 1 detailed tasks, assign engineers, begin development.

---

**Document Version**: 1.0  
**Last Updated**: 2026-08-09  
**Owner**: TradeW Product & Engineering  
**Status**: Ready for Implementation
