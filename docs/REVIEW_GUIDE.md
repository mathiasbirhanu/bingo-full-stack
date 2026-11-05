# Build 1 Review Guide — joint review & test script

**Scope of this build:** the demo-phase platform per SRS v5.0 / Architecture
v5.0 / Delivery Plan v1.0, running as one Next.js app + one fan-out service,
with the production infrastructure artifacts alongside.

---

## 1. What is running right now

| Layer | Where | Notes |
|---|---|---|
| Player PWA + consoles (single route `/`) | `src/components/casino/*` | casino dark-gold theme, mobile-first, low-bandwidth posture; **all copy phase-driven** via `src/lib/phase.tsx` |
| Bounded modules (own folders) | `src/modules/{authn,ledger,payment,game-core,rooms,engine,config-control,prize,commission,tenancy,reporting}` | domain logic, no framework imports |
| REST surface | `src/app/api/v1/**` | uniform guard/error envelope via `lib/api.ts`; PSP callback gate at `api/v1/payments/callback` |
| Live fan-out hub | `mini-services/room-events` (port 3003) | socket.io; REST snapshot recovery per UC-05 |
| Domain data | `prisma/schema.prisma` (PostgreSQL) + `prisma/rls-postgres.sql` (PG16 production RLS) | tenant_id from birth (ADR-24) |
| Infra baseline | `infra/{compose,docker,terraform,observability,ci}` + `docs/adr/ADR-027..029` | Terraform provisions, Helm deploys; **staging + demo TF roots complete** |
| Launch path | `docs/GO_LIVE_CHECKLIST.md` + `docs/COMPLIANCE_MATRIX.md` | licence→PSP→SMS→infra→ops, mapped to S6–S13; UC/FR/ADR evidence matrix |

**Quality gates already green:** `bun run lint` clean · `bunx tsc --noEmit`
**0 errors** (strict, ES2020 BigInt-native) · `bun test` **48/48 (1,731
assertions)** · seeded demo world with live rolling rooms.

**Launch-ready additions (2026-11-03):** telebirr production adapter skeleton
(`src/modules/payment/telebirr.ts` — RSA-OAEP+AES-GCM envelope, HMAC request
signing, timing-safe callback verification, replay freshness window,
reconciliation query, DRY_RUN rehearsal mode; the only merchant-pack-dependent
lines are the two wire translators) · two-phase payment port (LIVE: intent
stays PENDING until the verified callback settles; DEMO compresses both phases
through the *same* journal path) · `PLATFORM_PHASE` derived from
`PAYMENT_MODE` drives every player-facing string · CI + callback route wired.
A new-player cold test passed live: login → 25.00 deposit → idempotent replay
unchanged → callback gate refuses in DEMO (`PAYMENT_MODE_GUARD`).

**Re-verified 2026-11-03 (cold boot, fresh sandbox):** lint clean · 37/37
tests · dev server boots · OTP login + wallet (613.86 exact) · purchase +
**idempotent replay** (same purchaseId, no double charge) · fairness endpoint
returns verified commit-reveal seal · casino landing renders in browser
(390×844). Also closed the last infra gaps: `envs/staging` + `envs/demo`
Terraform roots, `tags` on all six modules, Postgres admin password now
`random_password` (no placeholder), CI RLS job swaps the Prisma provider
before `db push` against real PostgreSQL.

### Verified live on 2026-11-02 (browser + API walk-through)

| Flow | Result |
|---|---|
| UC-01/02 player OTP login + funding | ✅ persona 000003 lands funded, balance chip live |
| UC-03 purchase → escrow | ✅ 6 cards, 621.30 → 603.30 exactly |
| UC-04 draw, auto-daub, prize | ✅ LOCKED (commitment `7651d189…`) → DRAWING → "One Line" paid ball #24; wallet credited +3.60; later +4.32 Two Lines |
| UC-09 void + refunds | ✅ buy 4 (−20.00) → void → **exact** 613.86 → 593.86 → 613.86 |
| UC-11 KYB state machine | ✅ checklist render; submit-for-review refused for APPROVED tenant (guard works) |
| UC-13 tenant self-config | ✅ portal draft PENDING via maker; checker buttons hidden for maker |
| UC-15 statement + commission | ✅ issue → confirm (immutable); live accrual `2400 santim × 2800 bps = 672` posted for SHEGER tenant-day |
| Platform console | ✅ engine healthy (7.5k ticks, 0 outbox pending), rounds/tenants/commission/drafts tabs live |

## 2. Five-minute demo path (browser)

1. Open `/` → Landing. Sign in as **player**: phone `+251 911 000003`; the
   demo OTP is displayed on-screen (UC-01). Player auto-funded (UC-02).
2. **Lobby**: two house rooms rolling (75-ball & 90-ball), status/timer/price
   live (FR-ROOM-06). Enter a room during SALES_OPEN, buy cards (UC-03).
3. **Room view**: balls appear on the engine cadence; server auto-daub runs;
   a completed pattern pays automatically (claims are batched server-side,
   UC-04). Watch the "paid ball #N" toast line.
4. Kill your network (devtools offline) → the offline banner appears; restore
   → RoomView re-syncs from the REST snapshot (UC-05).
5. **Fairness**: open the round report/fairness endpoint for the completed
   round — commitment hash was published before first ball; reveal data after
   COMPLETED (UC-06, FR-GAME-04/07).
6. Sign out → sign in as **tenant owner** `+251 911 000002` → **Portal** nav:
   - *Content*: submit a pattern/ruleset draft (examples pre-filled); note the
     SELF_APPROVAL_REJECTED refusal, then approve via checker path (UC-13/08).
   - *KYB*: dossier checklist + upload + submit-for-review state machine (UC-11).
   - *Statements*: immutable monthly statement; confirm / dispute / payout
     request (UC-15).
7. Sign in as **platform admin** `+251 911 000001` → **Console** nav:
   Engine health + outbox pending · round void with refunds (UC-09) · tenant
   KYB approve/suspend (UC-11/14) · per-tenant commission rate with bounds
   (UC-12) · maker-checker drafts queue (UC-08) · **Finance** tab: approve and
   settle the tenant's payout on the DEMO rail (FR-PRT-19).

## 3. Test-each-module checklist (what "done" means)

| Module | Prove it by |
|---|---|
| `authn` | OTP login for the three personas; blocked players cannot mint sessions |
| `ledger` | Every purchase/refund/prize visible as balanced double-entry; void round restores wallets exactly (FR-ROOM-04) |
| `payment` | Demo PSP adapter only; mode guard refuses any real-rail call |
| `game-core` | 37-test suite: card shapes, fingerprints unique per round, commit→reveal verification, bitmask win test |
| `rooms`/`engine` | State machine SCHEDULED→…→COMPLETED with outbox event per transition; guardrails block LOCKED on breach (FR-ROOM-03) |
| `config-control` | Maker-checker with structural self-approval refusal + hash-bound approval (UC-08) |
| `prize` | Tier split floor + remainder-to-residual (test suite), margin floor & payout cap guardrails |
| `commission` | `floor(turnover × bps / 10000)` exact bigint math; bounds 500–3000 bps; overlap conflict; immutable statements |
| `tenancy` | KYB upload→review→approve; APPROVED required before operational privileges |
| `reporting` | Round report + reconciliation report endpoints |

## 4. Known scope lines (deliberate, per plan)

- PostgreSQL-only data layer (PG16+RLS artifacts ship in `prisma/rls-postgres.sql`
  and the compose/CI paths) — ADR-24 layering is intact; ADR-03 system of record.
- NATS/Redis appear in compose + ADRs but the in-process event path is the
  dev bus; the outbox table already records every transition (S5 swaps in
  the relay per the delivery plan).
- Phone OTP returns the code in the demo response (FR-PAY demo mode); SMS
  gateway is the FR-PAY port's production adapter slot.
- Payouts settle on the DEMO rail only (`DEMO_PAYOUT_BLOCKED` otherwise).

## 5. Where the ADR updates live

`docs/adr/ADR-027-terraform-iac.md` · `ADR-028-event-bus.md` ·
`ADR-029-observability.md` — recorded as living ADRs beside the code; the
Architecture PDF stays at the v5.0 baseline until we cut the v5.1 revision
together.
