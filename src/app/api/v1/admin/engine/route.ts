import { jsonOk, route, ROLE } from "@/lib/api";
import { db } from "@/lib/db";
import { engineStatus } from "@/modules/engine";

/** Ops console — engine health (S1 walking-skeleton observability). */
export const GET = route(async () => {
  const live = await db.room.findMany({
    where: { status: { in: ["SCHEDULED", "SALES_OPEN", "LOCKED", "DRAWING", "RESOLVING"] } },
    orderBy: { scheduledAt: "asc" },
    select: { id: true, title: true, status: true, scheduledAt: true, ballIntervalMs: true, autoClaim: true, grossSantim: true },
  });
  const outboxLag = await db.outboxEvent.count({ where: { publishedAt: null } });
  return jsonOk({ engine: engineStatus(), liveRooms: live.map((r) => ({ ...r, grossSantim: r.grossSantim.toString() })), outboxPending: outboxLag });
}, { roles: [ROLE.ADMIN, ROLE.SUPERVISOR, ROLE.AUDITOR] });
