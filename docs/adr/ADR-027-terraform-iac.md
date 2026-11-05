# ADR-027: Infrastructure-as-Code with Terraform; Helm for deployment

- **Status:** Accepted (2026-11-02) — extends Architecture v5.0 ADR ledger
- **Context:** The v5.0 architecture fixed Kubernetes + blue-green gateways but
  named no provisioning tool. Sprint 1 (Delivery Plan v1.0) demands a repeatable
  environment story for dev → staging → demo (M4 go-live).
- **Decision:**
  1. **Terraform provisions existence; Helm deploys versions.** Terraform owns
     RG/VNet/AKS/PostgreSQL Flexible/Redis Premium/ACR/Log Analytics.
     Kubernetes workloads are Helm-chart concerns and never appear in TF.
  2. Modules per concern (`infra/terraform/modules/{network,aks,postgres,
     redis,registry,observability}`), composed by env roots under `envs/`,
     remote azurerm state with per-env containers and state locking.
  3. Environments: **dev** (compose data planes, TF minimal), **staging**
     (managed PG16 + Redis Premium P1), **demo** (staging-shaped, the M4
     go-live environment). No production Terraform until the licence path
     (SRS §1.5) resolves.
  4. CI (ADR-27 companion, `infra/ci/pipeline.yml`) gates: lint → domain tests
     → prisma validate → **RLS leakage suite** (cross-tenant read must return
     zero rows) → images on main.
- **Consequences:** (+) reproducible demo go-live, auditable infra drift,
  sprint-mappable work. (−) two deployment vocabularies (TF/Helm) — mitigated
  by the strict ownership split; Key Vault wiring for DB admin password is a
  recorded TODO before staging.
- **Related:** ADR-07 (PSP isolation is network policy + env, same image),
  ADR-13 (blue-green rotation is chart-level), ADR-24 (RLS migration applies
  rls-postgres.sql at init).
