# Production Go-Live Checklist — from demo-first to launch-ready

**Platform:** Bingo Royale (Ethiopia) · **Baseline:** SRS v5.0 / Architecture
v5.0 (+ ADR-027/028/029) / Delivery Plan v1.0 · **Owner per line is named** —
nothing on this list is "someone's problem".

The principle: **the software switch is one env var; the business switch is
this list.** `PAYMENT_MODE=LIVE` must stay off until every gate in sections
A–C is signed. Sections D–F run continuously after go-live.

---

## A. Licensing & compliance (critical path — start FIRST)

| # | Item | Owner | Target | Done means |
|---|------|-------|--------|------------|
| A1 | Ethiopia National Lottery Administration licence application for online bingo | CEO + legal counsel | S6 (week 11) | Application filed; feedback loop open |
| A2 | Legal opinion on B2B tenant model (platform-of-platforms under the licence) | Legal | S7 | Written opinion; tenant contract template updated |
| A3 | Responsible-gaming controls live (limits, self-exclusion, 18+ gate) | Product | S8 | Deposit-limit UI shipped; self-exclusion blocks login |
| A4 | AML/KYC thresholds & SAR runbook aligned with regulator | Compliance | S8 | Thresholds configured; escalation path documented |
| A5 | Player-facing legal texts (T&C, privacy, game rules) — Amharic + English | Legal | S8 | Published on the PWA; version-stamped |

## B. Payment rails (the money switch)

| # | Item | Owner | Target | Done means |
|---|------|-------|--------|------------|
| B1 | Sign telebirr merchant agreement (Ethio Telecom) | CEO | S6 | Contract signed; merchant pack delivered |
| B2 | Fill `TELEBIRR_*` env from the pack; set `TELEBIRR_DRY_RUN=false` in staging | Backend | S7 | `mapRequest`/`mapCallback` translators match the pack; unit tests green against real field names |
| B3 | Staging end-to-end: intent → real telebirr sandbox payment → signed callback → journal posted | Backend | S7 | Screenshot + `journalTxId` in the ledger, balance exact |
| B4 | Reconciliation cron vs `queryIntent` (drift alarm) | Backend | S7 | Daily job; mismatch → Prometheus alert |
| B5 | CBE Birr / Amole adapters prioritised (same `PaymentPort`) | Backend | S9+ | Second adapter behind the same port; contract permitting |
| B6 | Settlement/float policy agreed (clearing account funding cadence) | Finance | S8 | Treasury runbook page |

## C. Communications

| # | Item | Owner | Target | Done means |
|---|------|-------|--------|------------|
| C1 | SMS gateway contract (OTP delivery) — e.g. Ethio Telecom SMS or aggregator | COO | S6 | Sender ID approved; credentials in Key Vault |
| C2 | Wire the SMS port's production adapter (same port, demo adapter stays for staging) | Backend | S7 | `SMS_ADAPTER=sms-gateway`; OTP TTL + rate limits unchanged |
| C3 | Withdraw OTP code-in-response from LIVE builds (demo adapter only) | Backend | S7 | `demoCode` field absent when `PAYMENT_MODE=LIVE` |

## D. Infrastructure & security

| # | Item | Owner | Target | Done means |
|---|------|-------|--------|------------|
| D1 | `terraform apply` staging + demo envs (network/AKS/PG16/Redis/ACR/observability) | DevOps | S2–S3 (per plan) | `terraform plan` clean; kubeconfig issued |
| D2 | PostgreSQL 16 cutover: schema push as `bingo_migrator`, RLS script applied | Backend | S5 | CI RLS-leakage suite green against staging DB |
| D3 | Secrets into Key Vault (APP_SECRET, TELEBIRR_*, SMS, DB admin — rotate the random_password) | DevOps | S7 | No secret in env files; rotation documented |
| D4 | Helm deploys: web + room-events, blue-green drill on the ingress | DevOps | S7 | Two consecutive zero-downtime rotations recorded |
| D5 | Backups: PITR on PG, Redis persistence policy, restore drill executed | DevOps | S8 | Restore to a point in time proven in staging |
| D6 | Security review / pen test (auth, wallet, callbacks, RLS) | External + Backend | S8–S9 | Report triaged; criticals closed |
| D7 | ADR-14 load test: 5,000 connections/node, p95 purchase saga, outbox age | DevOps | S6–S7 (per plan) | Targets met in demo env; report archived |

## E. Quality gates that must be green at the moment of the switch

- `bun run lint` clean · `bunx tsc --noEmit` **0 errors** · `bun test` all green (currently **48/48, 1,731 assertions**)
- CI pipeline green including the **RLS leakage suite** (cross-tenant read returns zero rows)
- Telebirr adapter suite green against the pack's real dialects (B2)
- Fairness spot-check: commit hash published pre-draw, reveal verifies post-draw (`/api/v1/fairness/{roomId}`)
- Void drill: refunds restore balances to the santim (UC-09 evidence in REVIEW_GUIDE)

## F. Operations & business readiness

| # | Item | Owner | Target | Done means |
|---|------|-------|--------|------------|
| F1 | Prometheus alerts live: outbox age >5s, callback failure rate, PSP p95, gateway connections | DevOps | S7 | ADR-29 dashboard + alert routing to on-call |
| F2 | Runbooks: PSP callback storm, outbox lag, room stuck in DRAWING, DB failover | Backend | S8 | Each runbook rehearsed once in staging |
| F3 | KYB ops team ready (document review SLA, info-request flow) | Ops | S10 | Two test tenants through the full KYB state machine |
| F4 | Commission statements dry-run for one tenant month; tenant confirms on the portal | Finance | S10 | Statement immutable, confirmed, accrual math spot-checked |
| F5 | Pilot tenant signed (D-05) and sandbox-trained | BD | S11 | Tenant portal walkthrough done; first draft approved |
| F6 | Support playbook (player OTP issues, deposit pending >5 min, claim disputes) | Support | S12 | Playbook live; macros in place |

## The switch itself (S13 dress rehearsal, then go)

1. Every line above signed off in a go/no-go review.
2. `terraform apply` the chosen region (the ADR-14 latency matrix decides).
3. Set `PAYMENT_MODE=LIVE` + telebirr credentials → `PLATFORM_PHASE` flips →
   every surface reads real-money wording automatically (phase-driven copy).
4. Watch for 48h: callback success rate, outbox age, settlement lag, support
   volume. Rollback = flip `PAYMENT_MODE=DEMO` (deposits pause; game state and
   ledger stay intact).

*Living document — update rows as sprints complete; the review dates map to
Delivery Plan v1.0 sprints S6–S13.*
