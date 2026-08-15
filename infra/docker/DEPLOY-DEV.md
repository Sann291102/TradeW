# TradeW — single-VPS development deployment (docker-compose)

A complete, repeatable way to stand up the whole stack on one Linux VM behind
Caddy (automatic HTTPS). This is a **development** deployment — real, internet-
reachable, but sized and configured for a dev/staging environment, not scaled
production.

Claude prepared every config referenced here. The steps that need an account,
a credential, a card, or DNS are **yours to run** — they are called out with 👤.

---

## 0. What you'll end up with

```
                 Internet
                    │  :80/:443
              ┌─────▼─────┐
              │   Caddy   │  auto-HTTPS, single public entrypoint
              └─────┬─────┘
        /api/* │            │ everything else
        ┌──────▼─────┐ ┌────▼────┐
        │    api     │ │   web   │
        └──────┬─────┘ └─────────┘
   ┌───────────┼───────────┬───────────┐
┌──▼──┐   ┌────▼────┐ ┌────▼─────┐ ┌───▼────┐
│ pg  │   │ sentinel│ │market-dt │ │live-fd │   (all internal-only)
└─────┘   └─────────┘ └──────────┘ └────────┘
   admin (operator-only, loopback + SSH tunnel — optional override)
```

Everything except Caddy is internal. Postgres/pgvector, Redis, Sentinel, the
market-data writer and the Dhan live-feed bridge are never published.

---

## 1. 👤 Provision the VM & DNS

- A VM with **≥ 4 GB RAM** (8 GB comfortable), 2 vCPU, ~40 GB disk, Ubuntu 22.04.
  DigitalOcean / Hetzner / Oracle Cloud Ampere / EC2 all work.
- A **domain** you control. Point two DNS **A records** at the VM's public IP:
  - `tradew.example.com` → `VM_IP`
  - `www.tradew.example.com` → `VM_IP`
- Open inbound **80** and **443** in the VM firewall/security group. Keep **22**
  for SSH. Nothing else needs to be public.

## 2. 👤 Install Docker on the VM

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in so the group applies
docker compose version          # confirm the compose plugin is present
```

## 3. Get the code onto the VM

```bash
git clone <your-repo-url> tradew && cd tradew
```

(For a dev deploy we build the images **on the VM** — the compose files already
carry `build:` blocks, so no registry/CI is required. For faster restarts later,
switch to CI-pushed images by setting `IMAGE_*` in `.env.prod`.)

## 4. Configure secrets — `.env.prod`

```bash
cp infra/docker/.env.prod.example .env.prod
```

Then edit `.env.prod` (👤 fill every `CHANGE_ME` and each credential you want
live). Generate strong secrets:

```bash
# JWT_SECRET, SERVICE_TOKEN/SENTINEL_SERVICE_TOKEN (same value), ADMIN_API_TOKEN
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Minimum to boot: `DOMAIN`, `ACME_EMAIL`, `POSTGRES_*`, `DATABASE_URL`,
`JWT_SECRET`, `SERVICE_TOKEN` + `SENTINEL_SERVICE_TOKEN` (equal), `FRONTEND_URL`,
`API_PUBLIC_URL`. Everything else (email, Google, Razorpay, EOD, admin) can be
filled now or added later — each is off/disabled until its keys are present.

## 5. Bring the stack up

```bash
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.prod up -d --build
```

The one-shot `migrate` service applies Prisma migrations before `api` starts.
Watch it settle:

```bash
docker compose -f infra/docker/docker-compose.prod.yml ps
docker compose -f infra/docker/docker-compose.prod.yml logs -f caddy api web
```

Caddy will fetch a Let's Encrypt certificate automatically once DNS resolves and
80/443 are reachable. Then browse **https://tradew.example.com**.

### 5a. Seed plans (first deploy only, for entitlements/checkout)

```bash
docker compose -f infra/docker/docker-compose.prod.yml exec api \
  npx prisma db seed --schema /repo/packages/database/prisma/schema.prisma
```

(Seeds the `free`/`tradew_pro`/`sentinel_pro`/… plans the checkout activates.)

## 6. Turn the new features on (post-deploy)

Each is independent; the app runs fine with any subset off.

- **Email** (login alerts, OTP, receipts, EOD) — 👤 set `SMTP_HOST/PORT/USER/PASS`.
  To actually send **as** `admin@tradew-setup.com`, use that domain's SMTP
  (Google Workspace / SES / Resend) or add it as a verified Gmail alias —
  otherwise Gmail rewrites the From: header.
- **Google sign-in** — 👤 in Google Cloud Console create an OAuth 2.0 **Web**
  client; set its Authorized redirect URI to
  `https://tradew.example.com/auth/google/callback`; paste
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` into `.env.prod`.
- **Payments** — 👤 add `RAZORPAY_KEY_ID/SECRET`, then in the Razorpay dashboard
  add a webhook to `https://tradew.example.com/api/payments/webhook` for events
  `payment.captured`, `order.paid`, `payment.failed`, and put its signing secret
  in `RAZORPAY_WEBHOOK_SECRET`.
- **EOD summary email** — set `EOD_EMAIL_ENABLED=true` (needs SMTP).

Apply any `.env.prod` change with:

```bash
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.prod up -d
```

## 7. Operator console (admin) — optional, operator-only

The admin console is **not** public. Run it with the override, which binds it to
loopback on the VM:

```bash
docker compose -f infra/docker/docker-compose.prod.yml \
               -f infra/docker/docker-compose.admin.yml \
               --env-file .env.prod up -d --build
```

Reach it from your laptop over an SSH tunnel:

```bash
ssh -L 3001:127.0.0.1:3001 user@VM_IP
# then open http://localhost:3001 and sign in with ADMIN_API_TOKEN
```

To grant a real person admin (needed for the JWT half of the API's admin gate),
set their user's `isAdmin=true` — via the console's user tools, or:

```bash
docker compose -f infra/docker/docker-compose.prod.yml exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "UPDATE \"User\" SET \"isAdmin\"=true WHERE email='you@example.com';"
```

## 8. Updates & backups

```bash
# Update to latest code
git pull
docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.prod up -d --build

# Manual DB backup (there is also infra/docker/backup.sh for scheduled backups)
docker compose -f infra/docker/docker-compose.prod.yml exec postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > tradew-$(date +%F).sql.gz
```

## 9. Troubleshooting

- **No HTTPS / cert pending** — DNS not resolving yet, or 80/443 blocked. Check
  `docker compose logs caddy`.
- **api restarting** — almost always a bad/weak secret (the boot guards reject
  placeholder/short/vendor-key values) or `DATABASE_URL`. Check `logs api`.
- **502 on `/feed/*`** — the `live-feed` container isn't healthy; check its logs.
- **Emails not arriving** — with SMTP unset they're only logged; `logs api` shows
  `[mail:console]`. With SMTP set, check `logs api` for send errors.

---

Prepared by Claude for the email + notification + checkout program (see
`knowledge/Patterns/2026-08-11 - Transactional email + in-app notification wiring.md`).
