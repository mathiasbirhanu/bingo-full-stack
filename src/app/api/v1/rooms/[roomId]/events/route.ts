import { jsonOk, route } from "@/lib/api";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { gridSpec } from "@/modules/game-core/variants";
import { santimToEtb } from "@/lib/money";

/**
 * Room events — ADR-19 sequence-addressed catch-up in compact form.
 *
 * GET /api/v1/rooms/[roomId]/events?afterSeq=N
 *
 * This is the low-connectivity lifeline: after any reconnect (or as a pure
 * polling fallback when websockets are unusable), the client asks "everything
 * after seq N" and gets tiny arrays — balls as [seq, ball] pairs, awards
 * grouped per ball with masked aliases. Server-driven cadence (nextBallInMs)
 * lets the client render the countdown without its own timer drift.
 */
export const GET = route(
  async ({ params, req }) => {
    const url = new URL(req.url);
    const after = Math.max(0, Number.parseInt(url.searchParams.get("afterSeq") ?? "0", 10) || 0);

    const room = await db.room.findUnique({ where: { id: params.roomId } });
    if (!room) throw new ApiError("ROOM_NOT_FOUND");

    const balls = await db.ballDraw.findMany({
      where: { roomId: room.id, seq: { gt: after } },
      orderBy: { seq: "asc" },
      select: { seq: true, ball: true },
    });
    const lastSeq =
      after === 0
        ? (
            await db.ballDraw.findFirst({
              where: { roomId: room.id },
              orderBy: { seq: "desc" },
              select: { seq: true },
            })
          )?.seq ?? 0
        : (balls[balls.length - 1]?.seq ?? after);

    // Confirmed awards after the requested sequence, grouped per ball tick.
    const claims = await db.claim.findMany({
      where: { roomId: room.id, status: "CONFIRMED", ballSeq: { gt: after } },
      include: { player: { select: { id: true, displayName: true } } },
      orderBy: { ballSeq: "asc" },
    });
    const versionIds = [...new Set(claims.map((c) => c.patternVersionId))];
    const versions = versionIds.length ? await db.configVersion.findMany({ where: { id: { in: versionIds } } }) : [];
    const entities = versions.length
      ? await db.configEntity.findMany({ where: { id: { in: versions.map((v) => v.entityId) } } })
      : [];
    const labelOf = new Map(
      versions.map((v) => [v.id, entities.find((e) => e.id === v.entityId)?.name ?? v.entityId])
    );

    const byBall = new Map<number, { seq: number; label: string; winners: string[][] }>();
    for (const c of claims) {
      const alias = c.player.displayName ?? `Player ${c.player.id.slice(-4).toUpperCase()}`;
      const row =
        byBall.get(c.ballSeq) ??
        { seq: c.ballSeq, label: labelOf.get(c.patternVersionId) ?? "Prize", winners: [] as string[][] };
      row.winners.push([alias, santimToEtb(c.awardSantim ?? 0n), c.playerId]);
      byBall.set(c.ballSeq, row);
    }

    const lastBallAt = (
      await db.ballDraw.findFirst({ where: { roomId: room.id }, orderBy: { seq: "desc" }, select: { calledAt: true } })
    )?.calledAt;
    const nextBallInMs =
      room.status === "DRAWING" && lastBallAt
        ? Math.max(0, lastBallAt.getTime() + room.ballIntervalMs - Date.now())
        : null;

    return jsonOk(
      {
        roomId: room.id,
        status: room.status,
        variantId: room.variantId,
        ballsTotal: gridSpec(room.variantId).ballsTotal,
        ballIntervalMs: room.ballIntervalMs,
        lastSeq,
        balls: balls.map((b) => [b.seq, b.ball]),
        awards: [...byBall.values()],
        nextBallInMs,
        grossEtb: santimToEtb(room.grossSantim),
        serverTime: new Date().toISOString(),
      },
      { headers: { "cache-control": "no-store" } } // live endpoint — never cached
    );
  },
  { anon: true }
);
