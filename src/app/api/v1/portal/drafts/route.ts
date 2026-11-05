import { z } from "zod";
import { jsonOk, route, requireTenantAccess } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { db } from "@/lib/db";
import { submitDraft, approveDraft, rejectDraft } from "@/modules/config-control";

/**
 * Tenant portal — self-service game content (UC-13, FR-PRT-11..14).
 * The tenant authors its own patterns / prize rule sets / room templates;
 * every save runs the platform validation pipeline + guardrails; publishing
 * goes through the same maker-checker machine as house content (UC-08) with
 * the TENANT_SUPERVISOR as the checker of the tenant's own money-affecting
 * config. Platform staff never mutate tenant content — they supervise
 * read-only (FR-PRT-20).
 *
 * GET   → this tenant's drafts + config entities + enabled variants.
 * POST  → submit a draft (maker). tenantId is FORCED from the session —
 *         a tenant can never author for another tenant (FR-PRT-22).
 * PATCH → checker decision on one of this tenant's pending drafts.
 */

const submitSchema = z.object({
  entityId: z.string().nullable().optional(),
  type: z.enum(["PATTERN", "ROOM_TEMPLATE", "PRIZE_RULESET"]),
  title: z.string().min(1).max(120),
  payload: z.unknown(),
});

const decideSchema = z.object({
  draftId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  reason: z.string().max(280).optional(),
});

async function scopedTenantId(tenantId: string | null): Promise<string> {
  if (!tenantId) throw new ApiError("FORBIDDEN", "portal requires a tenant membership");
  return tenantId;
}

export const GET = route(
  async ({ user }) => {
    const tenantId = await scopedTenantId(user!.tenantId);
    const [drafts, entities, variants] = await Promise.all([
      db.configDraft.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: 60,
        include: { entity: { select: { name: true, currentVersion: true } } },
      }),
      db.configEntity.findMany({ where: { tenantId }, orderBy: { updatedAt: "desc" } }),
      db.variant.findMany(),
    ]);
    return jsonOk({
      drafts: drafts.map((d) => ({
        id: d.id, type: d.type, title: d.title, status: d.status,
        entityId: d.entityId, entityName: d.entity?.name ?? null,
        currentVersion: d.entity?.currentVersion ?? 0,
        payloadHash: d.payloadHash, makerId: d.makerId, checkerId: d.checkerId,
        rejectReason: d.rejectReason, createdAt: d.createdAt.toISOString(),
      })),
      entities: entities.map((e) => ({
        id: e.id, type: e.type, name: e.name, currentVersion: e.currentVersion,
        locked: e.locked, updatedAt: e.updatedAt.toISOString(),
      })),
      variants,
    });
  },
  { roles: ["TENANT_OWNER", "TENANT_SUPERVISOR"] }
);

export const POST = route(
  async ({ body, user }) => {
    const input = body as z.infer<typeof submitSchema>;
    const tenantId = await scopedTenantId(user!.tenantId);
    // COMMISSION_PLAN is platform-finance territory (UC-12) — structurally not
    // submittable from the tenant portal even with a forged body.
    const draft = await submitDraft({
      entityId: input.entityId ?? null,
      type: input.type,
      tenantId,
      title: input.title,
      payload: input.payload,
      makerId: user!.id,
      makerRole: user!.role,
    });
    return jsonOk({ draftId: draft.id, payloadHash: draft.payloadHash, status: draft.status });
  },
  { roles: ["TENANT_OWNER"], schema: submitSchema }
);

export const PATCH = route(
  async ({ body, user }) => {
    const input = body as z.infer<typeof decideSchema>;
    const tenantId = await scopedTenantId(user!.tenantId);
    const draft = await db.configDraft.findUnique({ where: { id: input.draftId } });
    if (!draft) throw new ApiError("NOT_FOUND", "draft");
    if (draft.tenantId !== tenantId) throw new ApiError("FORBIDDEN", "not this tenant's draft");
    // TENANT_SUPERVISOR (or platform ADMIN as fallback checker) decides;
    // self-approval is refused inside the domain function either way.
    if (user!.role !== "TENANT_SUPERVISOR" && user!.role !== "ADMIN") {
      throw new ApiError("FORBIDDEN", "checker must be TENANT_SUPERVISOR");
    }
    if (input.action === "approve") {
      const out = await approveDraft(input.draftId, user!.id, user!.role);
      return jsonOk(out);
    }
    const out = await rejectDraft(input.draftId, user!.id, user!.role, input.reason ?? "tenant supervisor rejection");
    return jsonOk(out);
  },
  { roles: ["TENANT_OWNER", "TENANT_SUPERVISOR", "ADMIN"], schema: decideSchema }
);
