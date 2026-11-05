import { jsonOk, route } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { db } from "@/lib/db";

/**
 * Tenant portal — monthly statements (UC-15, FR-PRT-17..19).
 * GET → the tenant's issued statements, newest first, with totals and status.
 * Confirmation / dispute / payout live on the [statementId] route (actions).
 */
export const GET = route(
  async ({ user }) => {
    if (!user!.tenantId) throw new ApiError("FORBIDDEN", "portal requires a tenant membership");
    const tenantId = user!.tenantId;
    const statements = await db.statement.findMany({
      where: { tenantId },
      orderBy: { periodMonth: "desc" },
      take: 24,
      include: {
        disputes: { orderBy: { createdAt: "desc" }, take: 3 },
        payoutRequests: { orderBy: { requestedAt: "desc" }, take: 3 },
      },
    });
    return jsonOk({
      statements: statements.map((s) => ({
        id: s.id,
        periodMonth: s.periodMonth,
        turnoverSantim: s.turnoverSantim.toString(),
        prizesSantim: s.prizesSantim.toString(),
        commissionSantim: s.commissionSantim.toString(),
        payableSantim: s.payableSantim.toString(),
        residualSantim: s.residualSantim.toString(),
        contentHash: s.contentHash,
        status: s.status,
        issuedAt: s.issuedAt.toISOString(),
        confirmedAt: s.confirmedAt?.toISOString() ?? null,
        latestDispute: s.disputes[0]
          ? { reasonCode: s.disputes[0].reasonCode, note: s.disputes[0].note, resolvedAt: s.disputes[0].resolvedAt?.toISOString() ?? null }
          : null,
        latestPayout: s.payoutRequests[0]
          ? { status: s.payoutRequests[0].status, amountSantim: s.payoutRequests[0].amountSantim.toString() }
          : null,
      })),
    });
  },
  { roles: ["TENANT_OWNER", "TENANT_SUPERVISOR"] }
);
