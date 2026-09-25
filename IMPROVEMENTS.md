# 🧭 ViaRoute — Improvement Plan

> Where the product stands after Stage 1, what's missing, and the order we build it in.
> Companion to [PLAN.md](PLAN.md). Last updated: 2026-09-25.

---

## 📍 Where we are

| Area | State | Notes |
|---|:-:|---|
| Multi-tenant portals, auth, 2FA, roles | ✅ | Admin, manager, publisher and buyer logins |
| Numbers, campaigns, publishers, buyers, targets | ✅ | Targets support Number/IP, caps and priority |
| Call router | ✅ | Priority/weight, hours, states, 4 cap levels, failover, fallback, repeat-caller routing |
| Reports, CDR download, live board | ✅ | Date/time/timezone picker, 12 filters, column chooser |
| Billing (wallet, plans, Stripe test) | ✅ | Usage charged per call; subscription renewals |
| White-label (branding, custom domain) | ✅ | Managed by the platform admin |
| **Platform admin panel** | 🟨 | ✅ Customers (A) · ✅ Carriers (B) · ⬜ platform operations (C) |
| **Provider (carrier) management** | ✅ | Carriers page: Telnyx accounts + Test carrier, encrypted keys, costs, health, margins |
| Production hardening | 🟨 | Docker/CI ready; several reliability gaps (below) |

---

## 🔍 Gaps found in the review

These came out of going through the code, not just the feature list.

### 🔴 Must fix before real traffic
| # | Gap | Why it matters | Fix |
|---|---|---|---|
| G1 | **No stuck-call cleanup** — if a carrier hangup webhook is lost, the call stays "live" forever and its caps/lines stay taken | Buyer looks full, calls get skipped, live board wrong | Sweeper job every minute: calls live > N min with no Redis state → end, release caps, bill |
| G2 ✅ | **Carrier config lives in `.env`** (one Telnyx account for everyone) | Can't switch carriers, add a backup, or change keys without a redeploy | Provider management (Phase B) |
| G3 ✅ | **No carrier cost tracking** — we charge customers per minute but never record what the carrier charged us | Can't see platform margin; can't spot loss-making customers | Store carrier cost per call leg + per number; margin reports |
| G4 | **Wallet can go below zero mid-call** (checked only when the call starts) | Long calls on a near-empty wallet = unpaid usage | Max call length from balance; hang up with a message when the money runs out |
| G5 ✅ | **Recording notice is the same everywhere** | Two-party-consent states (CA, FL, PA…) need clear consent | Per-campaign notice text; option to require consent |
| G6 | **Audit log is written but never shown** (✅ per customer in admin; ⬜ platform-wide + customer-side viewer) | Support and disputes need "who changed what" | Audit log viewer (admin + customer admin) |

### 🟡 Should fix soon
| # | Gap | Fix |
|---|---|---|
| G7 | Reports read raw call rows — slow at millions of calls | Daily/hourly roll-up tables filled when calls end |
| G8 | Delete/suspend use the browser's `confirm()` box | In-app confirm dialog (like the new edit forms) |
| G9 | Route business hours always use the portal timezone | Timezone per route/target (buyers are often in other zones) |
| G10 | Direct targets (no buyer) still count campaign revenue | Setting per target: revenue on/off (default off for direct) |
| G11 | Only one platform admin role — everyone is all-powerful | Admin team with roles: Owner, Support, Billing (Phase C) |
| G12 | No way to email customers from the admin (outage, policy change) | Announcements: banner in portals + optional email |

---

## 🗺️ Roadmap at a glance

```
 Phase A  ─ Admin: Customer management      ✅ DONE
 Phase B  ─ Admin: Provider management      ✅ DONE
 Phase C  ─ Admin: Platform operations (settings, admin team, audit, health, money)
 Phase D  ─ Reliability & security hardening (G1, G4, G7, backups, monitoring)
 Phase E  ─ Customer portal polish
 Phase F  ─ Growth features (v2)
```

| Phase | Size | Blocks launch? |
|---|:-:|:-:|
| A · Customer management ✅ | done | ✅ yes |
| B · Provider management ✅ | done | ✅ yes |
| C · Platform operations | 2–3 sessions | 🟨 partly |
| D · Hardening | 2–3 sessions | ✅ yes |
| E · Portal polish | ongoing | ⬜ no |
| F · Growth (v2) | per feature | ⬜ no |

---

## 🅰️ Phase A — Admin: Customer management ✅ Done

> Built: list (search, filters, sort, CSV), create customer + invite, tabbed customer page (overview, plan & limits with custom prices, wallet with refunds, usage charts, users, numbers with move/release, branding & domain, notes, activity), suspend with reason (not lifted by top-ups), close / reopen, account-wide concurrent-call limit, max numbers, disabled logins. Not yet: auto-suspend after X days of empty wallet, deleting data after the retention period.

**Goal:** everything you need to run a customer's account from one screen, without touching the database.

### A1 · Customers list (upgrade)
- Search by name, subdomain, domain, owner email
- Filters: status, plan, low wallet, has custom domain, signed up (date range)
- Columns: customer, plan, status, wallet, calls (30 days), revenue to you (30 days), last activity, renews
- Sort by any column; export CSV
- Quick actions stay: log in as, credit, suspend

### A2 · Create customer (manually)
- Company name, subdomain, owner name + email, plan, trial days (or start active), starting credit
- Sends the owner an invite email to set their password
- For sales-led deals where you set the account up for them

### A3 · Customer page — tabs
| Tab | What's in it |
|---|---|
| **Overview** | Status, plan, wallet, trial/renewal, 30-day calls/minutes/spend chart, owner, quick actions |
| **Plan & billing** | Change plan (now or at renewal), extend trial, custom per-minute rate / number price / included numbers (overrides the plan), renewal date, low-balance threshold |
| **Wallet & transactions** | Full transaction history (filters, CSV), add/remove funds, refund a charge |
| **Usage** | Calls, minutes, numbers, users over time; carrier cost vs what they paid (after Phase B) |
| **Users** | Everyone on the account; resend invite, reset password email, turn off 2FA, disable user, log out everywhere |
| **Numbers** | Their numbers; release, move to another customer (with confirmation) |
| **Branding & domain** | (already built) |
| **Limits** | Max concurrent calls for the whole account, max numbers, max campaigns, calls/day — safety limits against abuse |
| **Notes** | Internal notes for your team (never shown to the customer) |
| **Activity** | Audit log for this customer (G6) |

### A4 · Account lifecycle
- Statuses: Trial → Active → Suspended → Closed
- **Suspend** with a reason (shown to the customer in a banner), optional auto-suspend when the wallet is empty for X days
- **Close account**: releases numbers, stops billing, keeps call history for the retention period, then deletes
- **Reactivate**

### A5 · Data model changes
- `Tenant`: `suspendReason`, `closedAt`, limits (`maxConcurrentCalls`, `maxNumbers`, …), price overrides (`perMinuteRate`, `numberPriceLocal`, `numberPriceTollFree`, `includedNumbers`)
- `TenantNote` (author, text, time)
- Transaction: `refundOf` link

**Done when:** you can sign up, configure, bill, support, suspend and close a customer entirely from the admin panel, and every action shows up in the activity log.

---

## 🅱️ Phase B — Admin: Provider management ✅ Done

> Built: Carriers page (Telnyx accounts and the Test carrier), encrypted credentials with a test-connection button, per-carrier webhook URL + signing key, statuses Active / Draining / Off, default carrier, per-customer carrier, carrier cost recorded on every call and number, margin per carrier / customer / platform, health (last webhook, last error). The first carrier is created automatically from .env. **Not possible:** mid-call failover to another carrier (both call legs must be on the same account). **Custom API carriers ✅:** any carrier, softswitch or SIP platform connects through the ViaRoute Carrier API ([docs/CARRIER_API.md](docs/CARRIER_API.md)): signed webhooks, optional numbers API, admin can add existing numbers to customers. **Twilio, SignalWire, Plivo, Bandwidth, Vonage ✅:** one conference-based adapter (TwiML / Plivo XML / BXML / NCCO), webhooks authenticated by a secret token in the URL, numbers bought and configured automatically (Bandwidth: added by admin). **Not yet:** number porting between carriers; tested against mocked carrier APIs only — do one real test call per carrier before going live.

**Goal:** carriers are managed in the UI; you can run more than one and move traffic between them.

### B1 · Providers screen
- Add a provider: **Telnyx** first (already integrated), then **Twilio**, **Bandwidth**, and **generic SIP trunk** (for IP-based carriers)
- Per provider: name, type, API credentials (stored encrypted, never shown again), webhook signing key, connection/app ID, status (active / draining / off)
- **Test connection** button (checks credentials, lists a sample of available numbers)
- Webhook URL + setup steps shown for each provider type
- Health: last webhook received, error rate, calls today

### B2 · Costs & pricing
- What each provider charges you: per-minute inbound, per-minute outbound, number monthly cost (local / toll-free), recording
- Your sell prices stay on plans and customer overrides
- Every call and number records **carrier cost** → margin per call, customer, provider (fixes G3)

### B3 · Routing traffic to providers
- **Default provider** for new numbers and outbound legs
- **Per-customer provider** override (e.g. a big customer on a dedicated trunk)
- **Outbound failover:** if dialing a buyer/target fails on provider 1, retry on provider 2
- Numbers remember which provider they belong to (webhooks and releases go to the right place)
- **Number porting** tracking (numbers moved between carriers) — manual status for now

### B4 · Code changes
- `Provider` table (type, encrypted credentials, costs, status, priority)
- `PhoneNumber.providerId`, `Call.providerId`, `Call.carrierCost`
- Telephony layer becomes "one adapter per provider instance" instead of one global Telnyx client
- Webhooks: `/webhooks/{providerId}` so each provider's signature is checked with its own key
- Keep the simulator as a built-in "Test provider"

**Done when:** you can add a second Telnyx account (or a SIP trunk), move a customer onto it, see its costs and health, and change keys without redeploying.

---

## 🅲 Phase C — Admin: Platform operations

| Item | What |
|---|---|
| **Admin dashboard v2** | MRR, usage income, carrier costs, **gross margin**, new signups, churn, trial conversions, top customers, customers at risk (low wallet / suspended / falling usage) |
| **Platform settings** | SMTP, Stripe keys, trial length, default plan, number prices, platform name/logo, support email, terms/privacy links — in the UI, encrypted |
| **Admin team** | Invite admins with roles: Owner (everything), Support (log in as, users, notes — no money), Billing (wallets, plans, refunds). 2FA required for admins. |
| **Audit log viewer** | Every admin and customer action, filter by customer/user/action/date (G6) |
| **System health** | API/DB/Redis status, background jobs, failed postbacks, webhook errors, stuck calls, disk/recordings storage |
| **Global call search** | Find any call across all customers by number or call ID (support) |
| **Announcements** | Banner in all portals + email to customer admins (G12) |
| **Finance exports** | Monthly revenue, usage and carrier cost CSVs for accounting |

---

## 🅳 Phase D — Reliability & security hardening

- **G1** Stuck-call sweeper + Redis state recovery after restart
- **G4** Wallet guard during calls (max duration from balance; low-balance warning to the customer)
- **G7** Report roll-up tables; indexes checked with real volumes (load test with 1M calls)
- Background jobs on BullMQ with retries and a dead-letter view (postbacks, emails, renewals, sweeper)
- Recordings to object storage (Cloudflare R2 / S3) with retention per plan
- Postgres Row-Level Security as a second tenant-isolation wall
- 2FA backup codes; admin 2FA required
- Error tracking (Sentry), uptime checks, alerting
- Nightly database backups + a restore drill
- Playwright browser tests for the main flows (signup → buy number → campaign → test call → report)

---

## 🅴 Phase E — Customer portal polish

- In-app confirm dialogs and toast messages everywhere (G8)
- Onboarding checklist on the dashboard (buy number → add buyer/target → campaign → test call)
- Timezone per route/target for business hours (G9); revenue on/off for direct targets (G10)
- Recording consent text per campaign (G5)
- Bulk actions: buy/assign many numbers, import buyers/targets from CSV
- Saved report views + scheduled report emails (daily/weekly CDR to an email address)
- Buyer & publisher portals: their own caps/usage view, invoices/statements
- Webhooks for customers (call started / ended / converted) in addition to publisher postbacks
- Mobile check of every page

---

## 🛡️ Spam protection ✅ Done

> Per-campaign rules (hidden caller IDs, blocked prefixes, calls per caller, STIR/SHAKEN minimum grade, spam-score threshold, auto-block of short-call spammers), platform-wide blocklist with prefixes, IPQualityScore spam-score lookups (cached 7 days, fail-open), spam score / attestation / line type on every call, customer **Spam & blocking** page and admin **Spam protection** page.

## ☎️ IVR & buyer whisper ✅ Done

> Phone-menu builder per campaign (menus, collect digits, messages; route to all or chosen buyers/targets, go to step, hang up; retries and fallbacks), keypad input on Telnyx, Custom API, Twilio, SignalWire, Plivo, Bandwidth, Vonage and the simulator, buyer whisper with placeholders, IVR choices/entries on calls, CDR and postbacks (`{ivr_path}`, `{ivr_<field>}`).

## 🎧 VoIP: agents & softphone ✅ Done

> In-house **agents** (new Agent login role: softphone + own calls only) are targets on campaigns and ring only while **Available**. Browser **softphone** with ring/answer/decline/mute/hang up, caller + campaign + IVR info; audio via Telnyx WebRTC and Twilio Voice SDKs; full flow without audio on the Test carrier. **SIP phones** (Zoiper, desk phones) on Telnyx via per-agent SIP logins. Not possible here: hosting our own SIP trunk (needs a media server).

## 🎙️ Call recording upgrades ✅ Done

> Recordings library (filters, player, download with file names, storage used), per-campaign notice (custom text or no notice where one-party consent applies), per-account retention with automatic deletion (30 days → forever), delete on request (admins, logged), recordings for buyers and agents on their own calls, download from call details.

## 🅵 Phase F — Growth features (v2)

| Feature | Value |
|---|---|
| **Ping/post & RTB** | Buyers bid per call in real time; highest bid wins |
| **IVR builder** ✅ | "Press 1 for…" menus, qualify callers before routing |
| **Number pools / DNI** | JavaScript snippet swaps numbers on websites per visitor, tracks the ad/keyword |
| **Call whisper** ✅ | Short message to the buyer before connecting ("Auto insurance call from Florida") |
| **AI call scoring** | Transcription, intent/sale detection, auto-disputes |
| **Disputes & chargebacks** | Buyer disputes a call; admin approves; wallet adjusts |
| **Tags & custom fields** | Pass click IDs / tags from numbers through to reports and postbacks |
| **Public API + API keys** | Customers automate campaigns, numbers and reports |

---

## ✅ Recommended order

1. **Phase A** — customer management (you asked for this next)
2. **Phase B** — provider management (fixes G2, G3)
3. **G1 + G4** from Phase D — must be in before real calls
4. **Phase C** — platform operations
5. Rest of **Phase D**, then launch (PLAN.md Stage 2–3)
6. **E** and **F** by customer demand
