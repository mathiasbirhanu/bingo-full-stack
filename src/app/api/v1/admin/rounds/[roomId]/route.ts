import { z } from "zod";
import { jsonOk, route, ROLE } from "@/lib/api";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { emitOutbox, auditTx } from "@/lib/write-path";
import { voidRound } from "@/modules/rooms/void";
import { persistRoundReport } from "@/modules/reporting";
import { gridSpec } from "@/modules/game-core/variants";
import { generateDrawSequence, openSealedSeed } from "@/modules/game-core/draw";

/**
 * Round actions from the console (UC-09, FR-ROOM-04, FR-ADM-05).
 *   POST { action: "void", reasonCode }            → void + refunds (idempotent)
 *   POST { action: "set-speed", ballIntervalMs }   → live caller speed (500–20000 ms);
 *                                                    the engine reads the room row every
 *                                                    tick, so the very next ball uses it.
 *   POST { action: "set-claim-mode", autoClaim }   → auto-pay vs manual BINGO! claims.
 * Completed rounds get their report persisted here so the report page can
 * render reveal data (FR-GAME-07).
 */

const LIVE_STATUSES = ["SCHEDULED", "SALES_OPEN", "LOCKED", "DRAWING"];

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("void"), reasonCode: z.string().min(3).max(64) }),
  z.object({ action: z.literal("set-speed"), ballIntervalMs: z.number().int().min(500).max(20000) }),
  z.object({ action: z.literal("set-claim-mode"), autoClaim: z.boolean() }),
]);

export const POST = route(
  async ({ params, body, user }) => {
    const input = bodySchema.parse(body);
    const room = await db.room.findUniqueOrThrow({ where: { id: params.roomId } });

    if (input.action === "void") {
      const result = await voidRound(params.roomId, input.reasonCode, user!.id);
      const after = await db.room.findUniqueOrThrow({ where: { id: params.roomId } });
      if (after.status === "COMPLETED") {
        // Ensure the round report (with fairness reveal) exists for the viewer.
        const existing = await db.roundReport.findUnique({ where: { roomId: params.roomId } });
        if (!existing) {
          await persistRoundReport(params.roomId);
        }
      }
      return jsonOk({
        alreadyVoided: result.alreadyVoided,
        refundCount: result.refundCount,
        refundedSantim: result.refundedSantim.toString(),
        status: after.status,
      });
    }

    if (!LIVE_STATUSES.includes(room.status)) {
      throw new ApiError("VALIDATION_FAILED", `round is ${room.status} — only live rounds can be tuned`);
    }

    if (input.action === "set-speed") {
      await db.room.update({ where: { id: room.id }, data: { ballIntervalMs: input.ballIntervalMs } });
      await emitOutbox(db, {
        type: "ROOM_PHASE",
        aggregateId: room.id,
        payload: { roomId: room.id, status: room.status, ballIntervalMs: input.ballIntervalMs },
        consumer: "gateway",
      });
      await auditTx(db, {
        actorId: user!.id,
        actorRole: user!.role,
        tenantId: room.tenantId,
        action: "ROUND_SPEED_SET",
        entityType: "Room",
        entityId: room.id,
        meta: { from: room.ballIntervalMs, to: input.ballIntervalMs },
      });
      console.log(`[admin] ${room.title} caller speed → ${input.ballIntervalMs}ms`);
      return jsonOk({ ballIntervalMs: input.ballIntervalMs, status: room.status });
    }

    // set-claim-mode
    await db.room.update({ where: { id: room.id }, data: { autoClaim: input.autoClaim } });
    await emitOutbox(db, {
      type: "ROOM_PHASE",
      aggregateId: room.id,
      payload: { roomId: room.id, status: room.status, autoClaim: input.autoClaim },
      consumer: "gateway",
    });
    await auditTx(db, {
      actorId: user!.id,
      actorRole: user!.role,
      tenantId: room.tenantId,
      action: "ROUND_CLAIM_MODE_SET",
      entityType: "Room",
      entityId: room.id,
      meta: { autoClaim: input.autoClaim },
    });
    console.log(`[admin] ${room.title} claim mode → ${input.autoClaim ? "AUTO" : "MANUAL BINGO!"}`);
    return jsonOk({ autoClaim: input.autoClaim, status: room.status });
  },
  { roles: [ROLE.ADMIN, ROLE.SUPERVISOR], schema: bodySchema }
);

export const GET = route(
  async ({ params }) => {
    const room = await db.room.findUniqueOrThrow({ where: { id: params.roomId } });
    const report = await db.roundReport.findUnique({ where: { roomId: params.roomId } });

    // ── Owner/ops draw monitor (owner-only surface) ──────────────────────
    // The called list and the future draw order live HERE and only here —
    // players see one ball at a time on the play screen, never the sequence.
    // The draw order is a deterministic shuffle of 1..N (each number exactly
    // once — also enforced by BallDraw's @@unique([roomId, ball])).
    const [balls, playerRows, ticketCount, seal] = await Promise.all([
      db.ballDraw.findMany({ where: { roomId: room.id }, orderBy: { seq: "asc" }, select: { seq: true, ball: true } }),
      db.ticket.groupBy({ by: ["playerId"], where: { roomId: room.id } }),
      db.ticket.count({ where: { roomId: room.id } }),
      db.fairnessSeal.findUnique({ where: { roomId: room.id } }),
    ]);
    let drawOrder: number[] | null = null;
    if (seal) {
      try {
        drawOrder = await generateDrawSequence(
          openSealedSeed(seal.serverSeedEnc),
          seal.salt,
          seal.clientSeedContribution,
          seal.nonce,
          room.variantId
        );
      } catch {
        drawOrder = null; // seal unreadable — monitor degrades, round unaffected
      }
    }

    return jsonOk({
      id: room.id,
      title: room.title,
      status: room.status,
      variantId: room.variantId,
      ballIntervalMs: room.ballIntervalMs,
      autoClaim: room.autoClaim,
      grossSantim: room.grossSantim.toString(),
      voidReason: room.voidReason,
      // monitor fields
      priceSantim: room.priceSantim.toString(),
      netPoolSantim: room.netPoolSantim.toString(),
      scheduledAt: room.scheduledAt.toISOString(),
      salesCloseAt: room.salesCloseAt.toISOString(),
      players: playerRows.length,
      tickets: ticketCount,
      ballsTotal: gridSpec(room.variantId).ballsTotal,
      calledBalls: balls.map((b) => ({ seq: b.seq, ball: b.ball })),
      drawOrder,
      report: report ? JSON.parse(report.payloadJson) : null,
    });
  },
  { roles: [ROLE.ADMIN, ROLE.SUPERVISOR, ROLE.AUDITOR] }
);
