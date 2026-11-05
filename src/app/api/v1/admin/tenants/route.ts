import { jsonOk, route, ROLE } from "@/lib/api";
import { db } from "@/lib/db";
import { checklistStatus, documentSetHash } from "@/modules/tenancy";

/**
 * Supervision (UC-14): tenant list with lifecycle state, live room health and
 * financial aggregates. Read-only — no write path exists from supervision.
 */
export const GET = route(async () => {
  const tenants = await db.tenant.findMany({
    include: {
      users: { select: { id: true, role: true } },
      rooms: { where: { status: { in: ["SCHEDULED", "SALES_OPEN", "LOCKED", "DRAWING"] } }, select: { id: true, title: true, status: true } },
      commissionPlans: { orderBy: { effectiveFrom: "desc" }, take: 1 },
      statements: { orderBy: { issuedAt: "desc" }, take: 3 },
    },
  });
  const out: Array<Record<string, unknown>> = [];
  for (const t of tenants) {
    const docCount = await db.kybDocument.count({ where: { tenantId: t.id } });
    const payable = await db.ledgerAccount.findUnique({ where: { code: `PARTNER_PAYABLE:${t.id}` } });
    const payableProj = payable ? await db.walletBalance.findUnique({ where: { accountId: payable.id } }) : null;
    out.push({
      id: t.id,
      code: t.code,
      legalName: t.legalName,
      tin: t.tin,
      jurisdiction: t.jurisdiction,
      status: t.status,
      statusReason: t.statusReason,
      approvedAt: t.approvedAt?.toISOString() ?? null,
      suspendedAt: t.suspendedAt?.toISOString() ?? null,
      documentSetHash: t.documentSetHash,
      liveDocSetHash: t.status === "UNDER_REVIEW" ? await documentSetHash(t.id) : null,
      staff: t.users,
      liveRooms: t.rooms,
      latestPlan: t.commissionPlans[0]
        ? { rateBps: t.commissionPlans[0].rateBps, basis: t.commissionPlans[0].basis, effectiveFrom: t.commissionPlans[0].effectiveFrom.toISOString() }
        : null,
      latestStatements: t.statements.map((s) => ({ id: s.id, periodMonth: s.periodMonth, status: s.status, payableSantim: s.payableSantim.toString() })),
      kybDocuments: docCount,
      payableSantim: (payableProj?.balanceSantim ?? 0n).toString(),
    });
  }
  return jsonOk(out);
}, { roles: [ROLE.ADMIN, ROLE.SUPERVISOR, ROLE.PLATFORM_COMPLIANCE, ROLE.PLATFORM_FINANCE, ROLE.AUDITOR, ROLE.SUPPORT] });

/** Actions applied to a tenant by the right role. */
