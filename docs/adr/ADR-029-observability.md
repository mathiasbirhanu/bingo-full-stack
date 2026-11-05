# ADR-029: Observability — Prometheus + OpenTelemetry, App Insights optional

- **Status:** Accepted (2026-11-02) — extends Architecture v5.0 ADR ledger
- **Context:** The architecture requires PERF-01/03 enforcement, outbox-age
  alerting (§11.4) and audited operations, but pinned no metrics stack. The
  sponsor asked to "consider Prometheus and App Insights".
- **Decision:**
  1. **kube-prometheus-stack** (Prometheus + Alertmanager + Grafana) is the
     metrics backbone in every K8s environment; compose dev ships plain
     Prometheus (`infra/observability/prometheus.yml`).
  2. Applications emit **OpenTelemetry SDK** metrics/traces at `/metrics` +
    OTLP; **Application Insights is only an OTel exporter switch**
    (`OTEL_EXPORTER_OTLP_ENDPOINT`), never a code dependency — a Grafana Tempo
    backend can replace it without touching application code.
  3. Domain SLO counters shipped from day one (module `reporting`):
     `outbox_dispatch_age_seconds` (page at p95 > 5 s, SRS §11.4),
     `ball_call_latency_ms` (p99 ≤ 50 ms, PERF-01), `room_event_seq_gaps_total`
     (fan-out integrity), `purchase_saga_duration_ms`, `claim_batch_window_miss_total`,
     `award_state_transition_seconds` (PROVISIONAL→CONFIRMED),
     `commission_accrual_lag_seconds`, `signalr_connections_per_gateway`.
  4. Alerts page on money-adjacent symptoms first (outbox age, accrual lag,
     seq gaps); infra symptoms second.
- **Consequences:** (+) one query language for all environments, vendor exit
  kept cheap, SLOs map 1:1 to SRS acceptance criteria. (−) dashboards are our
  own work (no managed APM niceties) — accepted: the SLO list above is the
  dashboard backlog.
- **Related:** ADR-28 (JetStream `/jsz` lag), §11.4 alert catalogue.
