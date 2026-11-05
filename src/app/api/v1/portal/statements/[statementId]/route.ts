import { z } from "zod";
import { jsonOk, route } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { db } from "@/lib/db";
import { confirmStatement, raiseDispute, requestPayout } from "@/modules/commission";

/**
 * Tenant portal — statement actions (UC-15, FR-PRT-18/19).
 * POST { action: "confirm" }                          → binds the hash, closes the month.
 * POST { action: "dispute", reasonCode, note }        → opens the append-only dispute chain.
 * POST { action: "request-payout", amountSantim }     → only on a CONFIRMED statement.
 * Every action verifies the caller owns the statement's tenant before the
 * domain function runs (FR-PRT-22 scoping).
 */

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("dispute"), reasonCode: z.string().min(3).max(64), note: z.string().min(3).max(500) }),
  z.object({ action: z.literal("request-payout"), amountSantim: z.string().regex(/^\d+$/, "amount must be integer santim") }),
]);

async function ownedStatement(statementId: string, tenantId: string) {
  const s = await db.statement.findUnique({ where: { id: statementId } });
  if (!s) throw new ApiError("NOT_FOUND", "statement");
  if (s.tenantId !== tenantId) throw new ApiError("FORBIDDEN", "not this tenant's statement");
  return s;
}

export const POST = route(
  async ({ params, body, user }) => {
    if (!user!.tenantId) throw new ApiError("FORBIDDEN", "portal requires a tenant membership");
    const tenantId = user!.tenantId;
    const input = bodySchema.parse(body);
    const statement = await ownedStatement(params.statementId, tenantId);

    switch (input.action) {
      case "confirm": {
        await confirmStatement(statement.id, user!.id);
        return jsonOk({ status: "CONFIRMED" });
      }
      case "dispute": {
        await raiseDispute(statement.id, input.reasonCode, input.note, user!.id);
        return jsonOk({ status: "DISPUTED" });
      }
      case "request-payout": {
        const payout = await requestPayout(statement.id, BigInt(input.amountSantim), user!.id);
        return jsonOk({ payoutId: payout.id, status: payout.status });
      }
    }
  },
  { roles: ["TENANT_OWNER", "TENANT_SUPERVISOR"], schema: bodySchema }
);
