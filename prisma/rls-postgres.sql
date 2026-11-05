-- ═══════════════════════════════════════════════════════════════════════════
-- Bingo Real-Money Platform — PostgreSQL 16 row-level security (production)
--
-- Companion to prisma/schema.prisma (ADR-24: "tenant-ready from birth" +
-- defence-in-depth isolation per FR-PRT-22 / NFR-MT-01). SQLite cannot express
-- RLS, so the demo runs application-level scoping (src/lib/api.ts route guards
-- + module-level where clauses); THIS script is applied in every PostgreSQL
-- environment (staging / demo / production) so that even a bug in the
-- application layer cannot cross tenant boundaries.
--
-- Application connects as `bingo_app` (BYRLS role); migrations run as
-- `bingo_migrator` (BYPASSRLS). Every tenant-scoped table gets:
--   · a policy keyed on current_setting('app.tenant_id', true);
--   · platform staff read access through the explicit staff policy below.
-- The setting is set per connection/pool: `SET app.tenant_id = '<id>'` —
-- the Prisma client wrapper (src/lib/db.ts, production profile) does this
-- from the verified session claims, never from request input.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Roles --------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bingo_app') THEN
    CREATE ROLE bingo_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bingo_migrator') THEN
    CREATE ROLE bingo_migrator NOLOGIN BYPASSRLS;
  END IF;
END $$;

-- Helper: the current request's tenant scope (NULL when unscoped).
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '');
$$;

-- Platform staff arrive with app.role set by the session wrapper.
CREATE OR REPLACE FUNCTION app_is_platform_staff() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.role', true) IN
    ('ADMIN','SUPERVISOR','SUPPORT','AUDITOR','PLATFORM_COMPLIANCE','PLATFORM_FINANCE'), false);
$$;

-- Tenant-scoped tables (tenant_id NOT NULL) ---------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'KybDocument', 'KybReview', 'ConfigEntity', 'ConfigDraft',
    'DailyAccrual', 'Statement', 'StatementDispute', 'PayoutRequest'
  ]
  LOOP
    EXECUTE format($f$
      CREATE POLICY tenant_isolation_%s ON "%s"
        USING ("tenantId" = app_tenant_id() OR app_is_platform_staff())
        WITH CHECK ("tenantId" = app_tenant_id() OR app_is_platform_staff());
      ALTER TABLE "%s" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "%s" FORCE ROW LEVEL SECURITY;
    $f$, lower(t), t, t, t);
  END LOOP;
END $$;

-- Nullable-tenant tables (tenant_id NULL = platform-owned house content) ----
-- Sessions scoped by the room/entity they belong to; house rows (NULL) are
-- visible to all app users (they are shared catalogue/game content).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['User', 'ConfigVersion', 'Room', 'Ticket', 'Purchase',
                           'Claim', 'JournalTransaction', 'JournalEntry']
  LOOP
    EXECUTE format($f$
      CREATE POLICY tenant_or_house_%s ON "%s"
        USING ("tenantId" IS NULL OR "tenantId" = app_tenant_id() OR app_is_platform_staff())
        WITH CHECK ("tenantId" IS NULL OR "tenantId" = app_tenant_id() OR app_is_platform_staff());
      ALTER TABLE "%s" ENABLE ROW LEVEL SECURITY;
    $f$, lower(t), t, t);
  END LOOP;
END $$;

-- Append-only platform tables: tenants never see them at all ---------------
-- OutboxEvent, AuditRecord, FairnessSeal, BallDraw, RoundReport, ReconReport,
-- CommissionPlan, LedgerAccount, WalletBalance, OtpCode, Session, Variant,
-- Tenant, DepositIntent: no tenant policy → RLS with no policy denies all
-- non-staff reads. Staff/worker roles read via BYPASSRLS paths only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['OutboxEvent','AuditRecord','FairnessSeal','BallDraw',
                           'RoundReport','ReconReport','CommissionPlan','LedgerAccount',
                           'WalletBalance','OtpCode','Session','Variant','Tenant','DepositIntent']
  LOOP
    EXECUTE format('ALTER TABLE "%s" ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- Deposits are player-owned; scoping rides the wallet account, not a tenant
-- column: the session wrapper sets app.user_id for per-user policies.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '');
$$;

CREATE POLICY player_own_deposit ON "DepositIntent"
  USING ("userId" = app_user_id() OR app_is_platform_staff())
  WITH CHECK ("userId" = app_user_id());
ALTER TABLE "DepositIntent" FORCE ROW LEVEL SECURITY;

COMMIT;

-- Verification harness (run after migrations in CI, ADR-27):
--   SET app.tenant_id = 'tenant_A';
--   SELECT count(*) FROM "Statement";          -- only tenant_A rows
--   SELECT count(*) FROM "OutboxEvent";        -- zero rows (denied)
-- A cross-tenant read returning rows fails the pipeline deploy gate.
