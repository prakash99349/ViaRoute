# 📞 ViaRoute

Pay-per-call tracking & routing platform (Ringba-style), sold as a multi-tenant white-label SaaS.
Roadmap & progress: **[PLAN.md](PLAN.md)** · Going live: **[DEPLOY.md](DEPLOY.md)**

## What's in it

| Area | Features |
|---|---|
| 🏢 Multi-tenant | Each customer gets `name.viaroute.com` (or their own domain), isolated data, own branding |
| 🔐 Accounts | Sign up, email verification, password reset, 2FA, team invites & roles (Admin, Manager, Publisher, Buyer logins) |
| ☎️ Numbers | Search/buy/release local & toll-free numbers (Telnyx), plan allowance, wallet charging |
| 🎯 Campaigns | Buyers with priority, weight, hourly/daily/monthly/concurrency caps, business hours, state targeting, revenue overrides, fallback number, repeat-caller window |
| 🔀 Call router | Real-time routing with failover, atomic caps (Redis), recording notice + recording, conversions, payouts, per-minute usage billing |
| 📊 Reporting | Live calls, call logs with filters & CSV, recordings player, dashboard charts, breakdown by campaign/buyer/publisher/number |
| 🔁 Postbacks | Publisher postbacks with macros, retries, delivery log |
| 💳 Billing | Prepaid wallet, Stripe top-ups, monthly plan + number renewal, auto-suspend/reactivate, statements, low-balance alerts |
| 🎨 White-label | Portal name, color, logo, custom domains with DNS verification + automatic HTTPS |
| 👑 Super Admin | All customers, suspend, wallet credit, "log in as" support mode, plans editor, platform income charts |
| 🧪 Test mode | No Telnyx/Stripe keys needed: simulated numbers, **call simulator**, instant test top-ups |

## Project layout

```
apps/api      ⚙️ NestJS API: auth, tenants, numbers, campaigns, call router, billing → :4000
apps/web      🎨 Next.js portal (main site, customer portals, super admin)       → :3000
packages/db   🗄️ Prisma schema, migrations, tenant-scoped client, seed
infra/        🐳 Docker Compose (dev + production), Caddyfile
tools/        🔧 load-test.mjs
```

## First-time setup

Requirements: Node 22+, pnpm, Docker Desktop (running).

```bash
pnpm install
cp .env.example .env            # then set JWT_SECRET and ENCRYPTION_KEY (see comments inside)
pnpm infra:up                   # Postgres, Redis, Mailpit
pnpm db:migrate                 # create tables
pnpm db:seed                    # plans + demo accounts
pnpm --filter @viaroute/db build
```

## Daily development

```bash
pnpm infra:up      # if Docker containers aren't running
pnpm dev           # API + web together (auto-reload)
```

| URL | What |
|---|---|
| http://localhost:3000 | Main site: landing, sign up, super admin login |
| http://acme.localhost:3000 | Demo customer portal (Acme, Pro plan) |
| http://&lt;anything&gt;.localhost:3000 | Any customer portal — works in Chrome/Edge with no setup |
| http://localhost:4000/health | API health check |
| http://localhost:8025 | 📬 Mailpit: every email the app sends (verification, reset, invites, alerts) |

### Demo logins (password `ViaRoute123!`)

| Role | Email | Log in at |
|---|---|---|
| 👑 Super admin | `admin@viaroute.local` | http://localhost:3000/login |
| 🔑 Customer admin (Acme) | `owner@acme.test` | http://acme.localhost:3000/login |

### Try a call in 1 minute (test mode)

1. Acme portal → **Campaigns** → open a campaign (or create one, add a buyer, assign a number)
2. **🧪 Test call** → *Place test call* — watch it ring, connect and finish
3. **Call Logs** → click the call → play the recording, see revenue/payout/profit and the postback

## Test mode vs live

| Service | Empty key (test mode) | Key set (live) |
|---|---|---|
| `TELNYX_API_KEY` | Simulated 555-01XX numbers; call simulator on | Real numbers & calls via Telnyx Call Control |
| `STRIPE_SECRET_KEY` | "Add funds (test)" credits instantly | Stripe Checkout card payments + webhook |
| `SMTP_URL` | Mailpit catches emails locally | Your SMTP provider (Resend/SES) |

Simulated numbers: buying `…555-0199` simulates a carrier rejection, `…555-0198` a slow activation.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | API + web with auto-reload |
| `pnpm test` | API test suite — 98 end-to-end tests on a separate `viaroute_test` DB + Redis DB 1 |
| `node tools/load-test.mjs 100` | 100 simultaneous simulated calls; checks caps, billing, latency |
| `pnpm db:studio` | Browse the database |
| `pnpm db:migrate` | After editing `schema.prisma`: create + apply a migration |
| `pnpm infra:down` | Stop Postgres, Redis + Mailpit (data is kept) |

## How multi-tenancy works

1. The browser sends its host (e.g. `acme.localhost:3000`) in `X-Tenant-Host`.
2. `TenantMiddleware` maps it to a tenant (subdomain, or a **verified** custom domain).
3. `AuthGuard` rejects tokens from another portal and re-checks the account on every request.
4. Tenant data goes through `tenantDb(tenantId)`, which injects `tenantId` into every query.
   Use unchecked inputs (`campaignId: x`) and pass `tenantId` explicitly when creating rows.

## How a call is routed

`call.initiated` → number → tenant checks (suspended? wallet? blocked caller? campaign active?) → repeat-caller check →
eligible buyers (active, open now, caller's state) ordered by priority then weight → answer → recording notice →
dial buyer (atomic cap reservation in Redis) → no answer/busy → next buyer → fallback → "nobody available" message →
buyer answers → bridge + record → hangup → duration, conversion, revenue/payout, usage charge (one DB transaction) → postback.
The same `CallEngine` runs for Telnyx webhooks and for the built-in simulator.
