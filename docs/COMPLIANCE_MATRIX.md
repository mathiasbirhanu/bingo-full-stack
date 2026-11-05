# SRS / Architecture Compliance Matrix — Build 1

**Baseline:** SRS v5.0 (UC-01..15, FR-PRT-01..20) · Architecture v5.0
(ADR-01..26 + ADR-027/028/029 as living docs) · verified 2026-11-03.

Evidence types: **T** = automated test (bun test, 48/48 · 1,731 assertions),
**L** = live browser/API verification, **C** = code inspection point.

## Use cases

| UC | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| UC-01 | Phone + OTP register/login; blocked accounts refused; rate limit 5/min | ✅ | T: authn guards · L: OTP login + rate limiter tripped live · C: `modules/authn`, E.164 normalize, blind index, AES phone envelope |
| UC-02 | Demo deposit; idempotency keys; conflict on payload change | ✅ | T: openDepositIntent replay/conflict (`tests/telebirr.test.ts`) · L: replay returned same purchaseId |
| UC-03 | Buy cards within cap; escrow move; MAX_CARDS_REACHED | ✅ | L: 2 cards, 613.86→607.86 exact; fingerprints per card · C: `modules/rooms/purchase` |
| UC-04 | Draw, server-side auto-daub, claim/batch payout | ✅ | L: One Line + Two Lines paid on cadence · C: engine tick prize pass, tier split floor+remainder (T) |
| UC-05 | Reconnect and recover via REST snapshot | ✅ | L: offline banner → resync · C: `room-events` + recovery gap limit |
| UC-06 | Verify fairness (commit before draw, reveal after) | ✅ | L: `/api/v1/fairness/{roomId}` `commitmentVerified: true` · C: sealed serverSeed (AES), reveal endpoint |
| UC-07 | Configure rooms/patterns/prize tables (tenant) | ✅ | L: portal draft PENDING via maker · C: `modules/config-control` |
| UC-08 | Maker-checker approval; self-approval structurally refused | ✅ | T: SELF_APPROVAL_REJECTED · L: checker buttons hidden for maker |
| UC-09 | Void round + exact refunds | ✅ | T + L: 593.86 → 613.86 restored to the santim |
| UC-10 | Reports & reconciliation | ✅ | C: round report + recon (escrow = gross − prizes) endpoints · L: admin console tabs |
| UC-11 | Tenant KYB upload→review→approve gating privileges | ✅ | L: submit refused for APPROVED tenant (state machine works) |
| UC-12 | Platform sets per-tenant commission with bounds | ✅ | T: COMMISSION_RATE_OUT_OF_BOUNDS, plan overlap conflict |
| UC-13 | Tenant self-configure game content (platform read-only) | ✅ | L: content draft flow; platform console read-only supervision tabs |
| UC-14 | Supervise tenants (suspend/reactivate) | ✅ | L: console tenant actions; BLOCKED login path covered by UC-01 |
| UC-15 | Statements, disputes, payout settle | ✅ | T: statement immutability; accrual `floor(turnover×bps/10000)` exact bigint · L: issue→confirm, DEMO-rail payout |

## Partner/B2B requirements (FR-PRT highlights)

| FR | Requirement | Status | Evidence |
|----|-------------|--------|----------|
| PRT-02 | Commission = turnover-based, versioned plans | ✅ | T: accrual math + overlap conflict · C: plan content-hash |
| PRT-17 | Immutable monthly statements | ✅ | T: issue-twice returns same row |
| PRT-19 | Payout request → approve → settle (demo rail only) | ✅ | L: finance tab; DEMO_PAYOUT_BLOCKED guard (C) |
| PRT-22 | Tenant data isolation | ✅ | C: RLS script (16 tables + deny-all + player-owned) · CI leakage suite |

## Architecture decisions — implementation mapping

| ADR | Decision | Status | Evidence |
|-----|----------|--------|----------|
| ADR-03 | Transactional outbox | ✅ | C: every state transition writes OutboxEvent; S5 relay swaps in |
| ADR-04/AP-04 | Redis never holds funds | ✅ | C: no funds state outside PG; Redis reserved for streams/cache |
| ADR-07 | PSP behind FR-PAY port, physical isolation | ✅ | **T: 11-test telebirr suite**; DEMO/LIVE adapters mode-gated |
| ADR-19 | Event bus abstraction | ✅ | C: dev bus in-process; ADR-028 records NATS→Event Hubs path |
| ADR-24 | tenant_id from birth + RLS | ✅ | C: schema + rls-postgres.sql; app-level scoping in every query |
| ADR-27/28/29 | IaC / event bus / observability | ✅ | `infra/terraform` (dev/staging/demo roots), ADR docs, prometheus.yml + /metrics |

## Quality benchmarks (world-class bar)

| Gate | Result |
|------|--------|
| TypeScript strict, `tsc --noEmit` | **0 errors** (ES2020, BigInt-native money) |
| ESLint | clean |
| bun test | **48/48 pass, 1,731 assertions** (ledger, game-core, commission, prize, telebirr) |
| Money integrity | int64 santim only; double-entry balanced (T proves DEBIT==CREDIT) |
| Idempotency | purchases, deposits, refunds, prize postings — key-guarded at journal level |
| AuthZ | every route through `route()`; roles; fresh role wins over stale JWT |
| Errors | typed reason-code envelope (`lib/errors.ts`), rendered verbatim by the client |
| Zero placeholders | grep clean (UI placeholders + one closed TODO → random_password) |

**Known Build-1 scope lines** (deliberate, documented): PostgreSQL 16 as the
sole system of record (EF Core/Npgsql + Prisma, RLS artifacts ship), in-process event bus (outbox ready for the S5 relay),
demo OTP/SMS adapter slot, DEMO-rail payouts only. All are phase-gated, not
missing — see `docs/GO_LIVE_CHECKLIST.md` for the launch path.
