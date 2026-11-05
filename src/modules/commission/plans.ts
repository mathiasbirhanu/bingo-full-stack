/**
 * Commission plans (UC-12, FR-PRT-07/08).
 *
 * A plan is (tenant, basis=TURNOVER, rateBps, effectiveFrom). Versioning rule:
 * plans are append-only; a new plan's effectiveFrom must be strictly after the
 * existing last plan's effectiveFrom → COMMISSION_PLAN_CONFLICT otherwise.
 * Rate must sit inside the market bounds (OD-12) → COMMISSION_RATE_OUT_OF_BOUNDS.
 */
import { db } from "../../lib/db";
import { ApiError } from "../../lib/errors";
import { COMMISSION_RATE_BPS_BOUNDS } from "../../lib/env";
import { hashPayload } from "../../lib/crypto";

export interface PlanDraft {
  tenantId: string;
  rateBps: number;
  basis?: "TURNOVER";
  effectiveFrom: Date;
}

/** Validation used by BOTH the draft validator and the approval path (UC-12). */
export async function validatePlanDraft(draft: PlanDraft): Promise<void> {
  if ((draft.basis ?? "TURNOVER") !== "TURNOVER") {
    throw new ApiError("COMMISSION_RATE_OUT_OF_BOUNDS", "only TURNOVER basis exists for MVP (D-PRT-02)");
  }
  const { min, max } = COMMISSION_RATE_BPS_BOUNDS;
  if (!Number.isInteger(draft.rateBps) || draft.rateBps < min || draft.rateBps > max) {
    throw new ApiError("COMMISSION_RATE_OUT_OF_BOUNDS", `rate must be ${min}..${max} bps`);
  }
  const last = await db.commissionPlan.findFirst({
    where: { tenantId: draft.tenantId },
    orderBy: { effectiveFrom: "desc" },
  });
  if (last && draft.effectiveFrom.getTime() <= last.effectiveFrom.getTime()) {
    throw new ApiError("COMMISSION_PLAN_CONFLICT", "a later plan already exists for this tenant");
  }
}

/** Called by the maker-checker approval path once the draft is approved. */
export async function activatePlan(
  draft: PlanDraft,
  approvedById: string,
  draftId: string
): Promise<{ id: string }> {
  await validatePlanDraft(draft); // re-validate the exact payload being approved
  const payloadHash = hashPayload({
    tenantId: draft.tenantId,
    basis: draft.basis ?? "TURNOVER",
    rateBps: draft.rateBps,
    effectiveFrom: draft.effectiveFrom.toISOString(),
  });
  const plan = await db.commissionPlan.create({
    data: {
      tenantId: draft.tenantId,
      basis: draft.basis ?? "TURNOVER",
      rateBps: draft.rateBps,
      effectiveFrom: draft.effectiveFrom,
      payloadHash,
      approvedById,
      draftId,
    },
  });
  return { id: plan.id };
}

/** The plan governing a moment in time (accrual input). */
export async function activePlanAt(tenantId: string, at: Date) {
  return db.commissionPlan.findFirst({
    where: { tenantId, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: "desc" },
  });
}
