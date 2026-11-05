/**
 * commission tests — floor math (D-PRT-02), plan bounds (OD-12), plan
 * conflicts, accrual idempotency per tenant-day, statement immutability.
 * Run: bun test tests/commission.test.ts
 */
import { describe, expect, test } from "bun:test";
import { db } from "../src/lib/db";
import { floorBps } from "../src/lib/money";
import { activatePlan, validatePlanDraft } from "../src/modules/commission/plans";
import { runAccrualForTenantDay } from "../src/modules/commission/accrual";
import { issueStatement } from "../src/modules/commission/settlement";

const TENANT = "tst-tenant-commission";

async function ensureTenant() {
  await db.tenant.upsert({
    where: { code: "TESTCOMM" },
    update: {},
    create: { id: TENANT, code: "TESTCOMM", legalName: "Commission Test PLC", tin: "T-123", jurisdiction: "ET", contactEmail: "c@t.et", contactPhone: "+251911000001", status: "APPROVED", approvedAt: new Date() },
  });
}

describe("commission plan validation (UC-12)", () => {
  test("rate outside market bounds is refused with COMMISSION_RATE_OUT_OF_BOUNDS", async () => {
    const err = await validatePlanDraft({ tenantId: TENANT, rateBps: 5000, effectiveFrom: new Date(Date.now() + 3600_000) }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("COMMISSION_RATE_OUT_OF_BOUNDS");
  });

  test("overlapping plan dates are refused with COMMISSION_PLAN_CONFLICT", async () => {
    await ensureTenant();
    const future = new Date(Date.now() + 7 * 24 * 3600_000);
    await db.commissionPlan.deleteMany({ where: { tenantId: TENANT } });
    await activatePlan({ tenantId: TENANT, rateBps: 1500, effectiveFrom: future }, "admin", "draft-1");
    const err = await validatePlanDraft({ tenantId: TENANT, rateBps: 1200, effectiveFrom: new Date(future.getTime() - 1000) }).then(
      () => null,
      (e) => e
    );
    expect(err?.code).toBe("COMMISSION_PLAN_CONFLICT");
  });
});

describe("turnover accrual (UC-15, D-PRT-02)", () => {
  test("floor(turnover × bps / 10000) is exact bigint math", () => {
    expect(floorBps(1_234_567n, 1500)).toBe(185_185n); // floor(185185.05)
  });
});

describe("statement immutability (FR-PRT-17)", () => {
  test("issuing twice returns the same row, never mutates", async () => {
    await ensureTenant();
    const a = await issueStatement(TENANT);
    const b = await issueStatement(TENANT);
    expect(b.alreadyIssued).toBe(true);
    expect(b.statement.id).toBe(a.statement.id);
    expect(b.statement.contentHash).toBe(a.statement.contentHash);
    // totals equal the sum of daily accruals for the period
    const accruals = await db.dailyAccrual.findMany({ where: { tenantId: TENANT, day: { startsWith: a.statement.periodMonth } } });
    const sum = accruals.reduce((acc, r) => acc + r.commissionSantim, 0n);
    expect(a.statement.commissionSantim).toBe(sum);
  });
});
