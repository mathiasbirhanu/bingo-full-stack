import { z } from "zod";
import { jsonOk, route, ROLE } from "@/lib/api";
import { db } from "@/lib/db";
import { reviewTenant, approveTenant, setTenantSuspension, assertTenantOperational } from "@/modules/tenancy/lifecycle";
import { checklistStatus } from "@/modules/tenancy/vault";

/** Tenant drill-down — read-only, audit-logged view (UC-14). */
export const GET = route(
  async ({ params }) => {
    const tenant = await db.tenant.findUnique({
      where: { id: params.tenantId },
      include: {
        documents: true,
        reviews: { orderBy: { createdAt: "desc" } },
        rooms: { orderBy: { scheduledAt: "desc" }, take: 10 },
        commissionPlans: { orderBy: { effectiveFrom: "desc" } },
        statements: { orderBy: { issuedAt: "desc" } },
      },
    });
    if (!tenant) return jsonOk({ tenant: null });
    const configEntities = await db.configEntity.findMany({ where: { tenantId: tenant.id } });
    return jsonOk({
      tenant: {
        ...tenant,
        beneficialOwners: JSON.parse(tenant.beneficialOwners),
        documents: tenant.documents.map((d) => ({ id: d.id, type: d.type, version: d.version, fileName: d.fileName, sha256: d.sha256, sizeBytes: d.sizeBytes, createdAt: d.createdAt.toISOString() })),
        reviews: tenant.reviews.map((r) => ({ id: r.id, officerId: r.officerId, decision: r.decision, note: r.note, documentSetHash: r.documentSetHash, createdAt: r.createdAt.toISOString() })),
        rooms: tenant.rooms.map((r) => ({ id: r.id, title: r.title, status: r.status, scheduledAt: r.scheduledAt.toISOString(), grossSantim: r.grossSantim.toString() })),
        plans: tenant.commissionPlans.map((p) => ({ id: p.id, rateBps: p.rateBps, basis: p.basis, effectiveFrom: p.effectiveFrom.toISOString() })),
        statements: tenant.statements.map((s) => ({ id: s.id, periodMonth: s.periodMonth, status: s.status, turnoverSantim: s.turnoverSantim.toString(), commissionSantim: s.commissionSantim.toString(), payableSantim: s.payableSantim.toString(), issuedAt: s.issuedAt.toISOString() })),
        configEntities: configEntities.map((e) => ({ id: e.id, type: e.type, name: e.name, currentVersion: e.currentVersion, locked: e.locked })),
      },
      checklist: await checklistStatus(tenant.id),
    });
  },
  { roles: [ROLE.ADMIN, ROLE.SUPERVISOR, ROLE.PLATFORM_COMPLIANCE, ROLE.PLATFORM_FINANCE, ROLE.AUDITOR, ROLE.SUPPORT] }
);

/** Lifecycle actions with role separation (UC-11/14). */
const schema = z.object({
  action: z.enum(["review-info", "review-reject", "approve", "suspend", "restore", "assert-operational"]),
  note: z.string().optional(),
  reasonCode: z.string().optional(),
});

export const POST = route(
  async ({ body, params, user }) => {
    const { action, note, reasonCode } = body as z.infer<typeof schema>;
    switch (action) {
      case "review-info":
        return jsonOk(await reviewTenant(params.tenantId, user!.id, "INFO_REQUESTED", note ?? "info requested"));
      case "review-reject":
        return jsonOk(await reviewTenant(params.tenantId, user!.id, "REJECTED", note ?? "rejected"));
      case "approve":
        return jsonOk(await approveTenant(params.tenantId, user!.id));
      case "suspend":
        return jsonOk(await setTenantSuspension(params.tenantId, true, reasonCode ?? "", user!.id));
      case "restore":
        return jsonOk(await setTenantSuspension(params.tenantId, false, reasonCode ?? "RESTORE", user!.id));
      case "assert-operational":
        await assertTenantOperational(params.tenantId);
        return jsonOk({ operational: true });
    }
  },
  { roles: [ROLE.ADMIN, ROLE.PLATFORM_COMPLIANCE], schema }
);
