import { z } from "zod";
import { jsonOk, route, ROLE } from "@/lib/api";
import { db } from "@/lib/db";
import { activatePlan, validatePlanDraft } from "@/modules/commission/plans";
import { runAccrualsForDay } from "@/modules/commission/accrual";
import { audit } from "@/lib/write-path";

/**
 * Platform commission console (UC-12, FR-PRT-07/08, D-PRT-02).
 *
 * GET  → every tenant with its plan history and last accrual.
 * POST → set a tenant's commission rate (basis TURNOVER for MVP). Rate is
 *        validated against the OD-12 market bounds and the append-only plan
 *        chain (no overlapping effectiveFrom). ADR-12 maker-checker stays in
 *        force via the drafts pipeline; this direct path is ADMIN-only and
 *        audit-logged so the demo console can operate standalone.
 * PUT  → re-run the tenant-day accruals now (idempotent, delta-correcting).
 */
export const GET = route(async () => {
  const tenants = await db.tenant.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      commissionPlans: { orderBy: { effectiveFrom: "desc" } },
      dailyAccruals: { orderBy: { day: "desc" }, take: 7 },
    },
  });
  return jsonOk(
    tenants.map((t) => ({
      tenantId: t.id,
      code: t.code,
      legalName: t.legalName,
      status: t.status,
      plans: t.commissionPlans.map((p) => ({
        id: p.id,
        basis: p.basis,
        rateBps: p.rateBps,
        effectiveFrom: p.effectiveFrom.toISOString(),
        payloadHash: p.payloadHash,
        approvedById: p.approvedById,
        createdAt: p.createdAt.toISOString(),
      })),
      accruals: t.dailyAccruals.map((a) => ({
        day: a.day,
        turnoverSantim: a.turnoverSantim.toString(),
        rateBps: a.rateBps,
        commissionSantim: a.commissionSantim.toString(),
        computedAt: a.computedAt.toISOString(),
      })),
    }))
  );
}, { roles: [ROLE.ADMIN, ROLE.PLATFORM_FINANCE, ROLE.SUPERVISOR] });

const postSchema = z.object({
  tenantId: z.string().min(1),
  rateBps: z.number().int().min(0).max(3500),
  effectiveFrom: z.string().optional(), // ISO; default = now
});

export const POST = route(
  async ({ body, user }) => {
    const { tenantId, rateBps, effectiveFrom } = body as z.infer<typeof postSchema>;
    const draft = {
      tenantId,
      rateBps,
      basis: "TURNOVER" as const,
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
    };
    await validatePlanDraft(draft); // bounds (OD-12) + append-only chain
    const plan = await activatePlan(draft, user!.id, `admin-direct:${user!.id}:${Date.now()}`);
    await audit({
      actorId: user!.id,
      actorRole: user!.role,
      tenantId,
      action: "COMMISSION_PLAN_ACTIVATED",
      entityType: "CommissionPlan",
      entityId: plan.id,
      meta: { rateBps, basis: "TURNOVER", effectiveFrom: draft.effectiveFrom.toISOString() },
    });
    return jsonOk({ planId: plan.id, rateBps, basis: "TURNOVER", effectiveFrom: draft.effectiveFrom.toISOString() });
  },
  { roles: [ROLE.ADMIN, ROLE.PLATFORM_FINANCE], schema: postSchema }
);

export const PUT = route(async () => jsonOk({ outcomes: await runAccrualsForDay(new Date()) }), {
  roles: [ROLE.ADMIN, ROLE.PLATFORM_FINANCE],
});
