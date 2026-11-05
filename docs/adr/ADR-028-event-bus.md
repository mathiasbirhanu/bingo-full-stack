# ADR-028: Event bus strategy — NATS JetStream now, Kafka-compatible later

- **Status:** Accepted (2026-11-02) — extends Architecture v5.0 ADR ledger
- **Context:** ADR-19 selected transactional outbox → JetStream-class bus and
  explicitly rejected per-room Kafka streams for the game path. The sponsor
  asked to "consider Kafka". A managed Kafka (Azure Event Hubs, Kafka API)
  remains desirable at B2B scale; running Strimzi in MVP was rejected by the
  delivery plan (no self-managed Kafka before pilot economics are proven).
- **Decision:**
  1. MVP event plane = **NATS JetStream, 3-node raft cluster** (compose dev
     profile ships the single-node `nats -js`).
  2. Every producer/consumer codes against **IEventBus** (`src/modules/events`),
     so the Phase-2 swap to **Azure Event Hubs (Kafka API)** is an adapter
     change plus a consumer re-registration — no domain edits.
  3. Topics mirror the architecture: `room.{id}.events` (ordered, per-room,
     seq-numbered per FR-ROOM-05), `wallet.operations`, `commission.accruals`,
     `audit.records`. Outbox relay is the only publisher (ADR-03).
  4. Ordering + idempotency live in the payload (seq + idempotencyKey), never
     in broker assumptions, so the swap cannot corrupt semantics.
- **Consequences:** (+) tiny ops surface now, real replay/lag semantics
  (`/jsz` monitoring), clean Phase-2 path. (−) Event Hubs' Kafka API differs in
  consumer-group semantics; the re-registration test is part of the Phase-2
  exit criteria, post-M4.
- **Related:** ADR-03 (outbox), ADR-19 (bus selection), ADR-29 (lag alerts).
