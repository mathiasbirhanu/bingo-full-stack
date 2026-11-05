import { jsonOk, route } from "@/lib/api";
import { db } from "@/lib/db";
import { buildReveal, commitmentHolds } from "@/modules/game-core";
import { ApiError } from "@/lib/errors";
import { parseJson } from "@/lib/json";

/**
 * Fairness reveal — UC-06. Publishes commitment, revealed seed + salt, client
 * contribution, nonce and the regenerated sequence; the browser page
 * recomputes with the SAME isomorphic game-core code.
 */
export const GET = route(
  async ({ params }) => {
    const room = await db.room.findUnique({ where: { id: params.roomId }, include: { seal: true } });
    if (!room) throw new ApiError("ROOM_NOT_FOUND");
    if (!room.seal) return jsonOk({ phase: room.status, reveal: null });
    const seal = room.seal;
    if (!seal.revealedSeed) {
      // Commitment is public from lock; seed stays sealed until completion.
      return jsonOk({ phase: room.status, reveal: null, commitment: seal.commitment });
    }
    const reveal = await buildReveal(
      {
        commitment: seal.commitment,
        clientSeedContribution: seal.clientSeedContribution,
        salt: seal.salt,
        serverSeedSealed: seal.serverSeedEnc, // schema field name (sealed AES envelope)
        nonce: seal.nonce,
      },
      room.variantId
    );
    const balls = await db.ballDraw.findMany({ where: { roomId: room.id }, orderBy: { seq: "asc" } });
    const prizeTx = await db.journalTransaction.findMany({
      where: { roundId: room.id, kind: { in: ["PRIZE", "PRIZE_ADJUSTMENT"] } },
      include: { entries: true },
    });
    let awarded = 0n;
    for (const t of prizeTx) for (const e of t.entries) if (e.direction === "CREDIT") awarded += e.amountSantim;
    return jsonOk({
      phase: room.status,
      commitment: seal.commitment,
      commitmentVerified: commitmentHolds(seal.commitment, reveal.serverSeed, seal.salt),
      inputHash: seal.inputHash,
      reveal,
      calledSequence: balls.map((b) => b.ball),
      matchesServerDraw:
        balls.length === reveal.drawSequence.length &&
        balls.every((b, i) => b.ball === reveal.drawSequence[i]),
      awards: { totalSantim: awarded.toString() },
      tickets: (await db.ticket.count({ where: { roomId: room.id } })),
      ticketIds: (await db.ticket.findMany({ where: { roomId: room.id }, select: { id: true } })).map((t) => t.id),
      variantId: room.variantId,
      demo: true,
    });
  },
  { anon: true }
);
