import { z } from "zod";
import { jsonOk, route, ROLE } from "@/lib/api";
import { db } from "@/lib/db";
import { voidRound } from "@/modules/rooms/void";
import { persistRoundReport, buildRoundReport } from "@/modules/reporting";

/** Rounds list for the console (with report payloads when present). */
export const GET = route(async () => {
  const rooms = await db.room.findMany({
    orderBy: { scheduledAt: "desc" },
    take: 50,
    include: { report: true, _count: { select: { tickets: true, claims: true } } },
  });
  return jsonOk(
    rooms.map((r) => ({
      id: r.id,
      title: r.title,
      variantId: r.variantId,
      tenantId: r.tenantId,
      status: r.status,
      scheduledAt: r.scheduledAt.toISOString(),
      grossSantim: r.grossSantim.toString(),
      tickets: r._count.tickets,
      claims: r._count.claims,
      voidReason: r.voidReason,
      report: r.report ? JSON.parse(r.report.payloadJson) : null,
    }))
  );
}, { roles: [ROLE.ADMIN, ROLE.SUPERVISOR, ROLE.AUDITOR, ROLE.SUPPORT] });

/** Round detail actions — report regeneration, void with reason (UC-09). */
const postSchema = z.object({
  action: z.enum(["report", "void"]),
  reasonCode: z.string().optional(),
});

export const POST = route(
  async ({ body, params, user }) => {
    const { action, reasonCode } = body as z.infer<typeof postSchema>;
    if (action === "report") {
      return jsonOk(await buildRoundReport(params.roomId));
    }
    const result = await voidRound(params.roomId, reasonCode ?? "OPERATOR_REQUEST", user!.id);
    return jsonOk(result);
  },
  { roles: [ROLE.ADMIN, ROLE.SUPERVISOR], schema: postSchema }
);
