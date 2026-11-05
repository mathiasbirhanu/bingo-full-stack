/**
 * Void round and refund (UC-09, FR-ROOM-04, FR-ADM-05).
 *
 * Allowed from SALES_OPEN / LOCKED, and from DRAWING only with the
 * critical-fault reason (operator alert). One reversing journal entry per
 * purchase, idempotent by key `refund:{purchaseId}` — duplicate void requests
 * deduplicate naturally. Postcondition: escrow zero, refund total == gross.
 */
import { db } from "../../lib/db";
import { ApiError } from "../../lib/errors";
import { AccountCodes, postTransaction } from "../ledger";
import { emitOutbox } from "../../lib/write-path";

export const CRITICAL_FAULT_REASON = "CRITICAL_FAULT";

export interface VoidResult {
  refundedSantim: bigint;
  refundCount: number;
  alreadyVoided: boolean;
}

export async function voidRound(roomId: string, reasonCode: string, actorId: string): Promise<VoidResult> {
  if (!reasonCode || reasonCode.length < 3) throw new ApiError("VALIDATION_FAILED", "reason code required");

  return db.$transaction(async (tx) => {
    const room = await tx.room.findUnique({ where: { id: roomId } });
    if (!room) throw new ApiError("ROOM_NOT_FOUND");
    if (room.status === "VOIDED") {
      return { refundedSantim: room.grossSantim, refundCount: 0, alreadyVoided: true };
    }
    if (!["SALES_OPEN", "LOCKED", "DRAWING", "RESOLVING"].includes(room.status)) {
      throw new ApiError("VALIDATION_FAILED", `cannot void a ${room.status} round`);
    }
    if (room.status === "DRAWING" && reasonCode !== CRITICAL_FAULT_REASON) {
      throw new ApiError("VALIDATION_FAILED", "void during DRAWING requires the critical-fault reason");
    }

    const purchases = await tx.purchase.findMany({ where: { roomId, status: "CONFIRMED" } });
    let refunded = 0n;
    for (const p of purchases) {
      if (p.status === "REFUNDED") continue;
      await postTransaction(tx, {
        kind: "REFUND",
        idempotencyKey: `refund:${p.id}`,
        memo: `Void refund — room ${room.title}, reason ${reasonCode}`,
        roundId: roomId,
        tenantId: room.tenantId,
        entries: [
          {
            accountCode: AccountCodes.roundEscrow(roomId),
            accountType: "LIABILITY",
            accountName: `Round escrow — ${room.title}`,
            direction: "DEBIT",
            amount: p.totalSantim,
            tenantId: room.tenantId,
          },
          {
            accountCode: AccountCodes.playerWallet(p.playerId),
            accountType: "LIABILITY",
            accountName: "Player wallet",
            direction: "CREDIT",
            amount: p.totalSantim,
            ownerUserId: p.playerId,
          },
        ],
      });
      await tx.purchase.update({ where: { id: p.id }, data: { status: "REFUNDED" } });
      refunded += p.totalSantim;
    }

    await tx.room.update({
      where: { id: roomId },
      data: { status: "VOIDED", voidedAt: new Date(), voidReason: reasonCode },
    });

    // Wake the engine to stop the room and notify holders.
    await emitOutbox(tx, {
      type: "ROUND_VOIDED",
      aggregateId: roomId,
      payload: { roomId, reasonCode, refunded: refunded.toString() },
      consumer: "gateway",
    });

    return { refundedSantim: refunded, refundCount: purchases.length, alreadyVoided: false };
  });
}
