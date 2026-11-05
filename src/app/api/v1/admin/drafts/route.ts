import { z } from "zod";
import { jsonOk, route, ROLE } from "@/lib/api";
import { db } from "@/lib/db";
import { submitDraft } from "@/modules/config-control";
import { ensureRollingRooms } from "@/modules/rooms/queries";

/** Admin console data — drafts list + submission (UC-07). */
const submitSchema = z.object({
  entityId: z.string().nullable().optional(),
  type: z.enum(["PATTERN", "ROOM_TEMPLATE", "PRIZE_RULESET", "COMMISSION_PLAN"]),
  tenantId: z.string().nullable().optional(),
  title: z.string().min(1).max(120),
  payload: z.unknown(),
});

export const GET = route(
  async () => {
    const drafts = await db.configDraft.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { entity: { select: { name: true, currentVersion: true, type: true } } },
    });
    const entities = await db.configEntity.findMany({
      orderBy: { updatedAt: "desc" },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    const variants = await db.variant.findMany();
    return jsonOk({
      drafts: drafts.map((d) => ({
        id: d.id,
        type: d.type,
        title: d.title,
        status: d.status,
        tenantId: d.tenantId,
        entityId: d.entityId,
        entityName: d.entity?.name ?? null,
        currentVersion: d.entity?.currentVersion ?? 0,
        payload: JSON.parse(d.payloadJson),
        payloadHash: d.payloadHash,
        makerId: d.makerId,
        checkerId: d.checkerId,
        rejectReason: d.rejectReason,
        createdAt: d.createdAt.toISOString(),
      })),
      entities: entities.map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
        tenantId: e.tenantId,
        currentVersion: e.currentVersion,
        locked: e.locked,
        latestPayload: e.versions[0] ? JSON.parse(e.versions[0].payloadJson) : null,
        updatedAt: e.updatedAt.toISOString(),
      })),
      variants,
    });
  },
  { roles: [ROLE.ADMIN, ROLE.SUPERVISOR] }
);

export const POST = route(
  async ({ body, user }) => {
    const input = body as z.infer<typeof submitSchema>;
    const draft = await submitDraft({
      entityId: input.entityId ?? null,
      type: input.type,
      tenantId: input.tenantId ?? null,
      title: input.title,
      payload: input.payload,
      makerId: user!.id,
      makerRole: user!.role,
    });
    return jsonOk({ draftId: draft.id, payloadHash: draft.payloadHash, status: draft.status });
  },
  { roles: [ROLE.ADMIN, ROLE.SUPERVISOR], schema: submitSchema }
);

/** Utility action: force the rolling scheduler to top up demo rooms. */
export const PUT = route(async () => jsonOk({ created: await ensureRollingRooms(3) }), {
  roles: [ROLE.ADMIN, ROLE.SUPERVISOR],
});
