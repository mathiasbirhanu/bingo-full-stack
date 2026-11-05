/**
 * Round completion (UC-05/06, FR-ADM-08) — the RESOLVING half-turn:
 *   1. drain the escrow: positive remainder → HOUSE_REVENUE (ROUND_RESIDUAL),
 *      negative remainder (defensive, over-award) → house covers (ADJUSTMENT);
 *   2. reveal the commit-reveal envelope (ADR-18): seed + salt published, the
 *      input hash binds the exact award inputs;
 *   3. persist the immutable round report (FR-ADM-08);
 *   4. mark COMPLETED, emit ROUND_COMPLETED, unlock pinned config entities;
 *   5. trigger the tenant-day commission accrual (UC-15) — idempotent.
 *
 * Every step is idempotent (ledger keys, seal guard, report upsert, status
 * guard) so a crash mid-completion simply re-runs the turn.
 */
import { db } from "../../lib/db";
import { hashPayload } from "../../lib/crypto";
import { dayKey } from "../../lib/json";
import { emitOutbox } from "../../lib/write-path";
import { AccountCodes, postTransaction } from "../ledger";
import { openSealedSeed } from "../game-core/draw";
import { persistRoundReport } from "../reporting/reports";
import { runAccrualForTenantDay } from "../commission/accrual";
import { dropRoomState } from "./state";

export async function finishRoom(roomId: string): Promise<void> {
  const room = await db.room.findUnique({ where: { id: roomId }, include: { seal: true } });
  if (!room || room.status === "COMPLETED" || room.status === "VOIDED") {
    dropRoomState(roomId);
    return;
  }

  // 1. Escrow drain — read the projection beside the journal (ADR-04); the
  //    projection is the fastest honest view of the escrow's remaining stake.
  const escrow = await db.ledgerAccount.findUnique({ where: { code: AccountCodes.roundEscrow(roomId) } });
  const proj = escrow ? await db.walletBalance.findUnique({ where: { accountId: escrow.id } }) : null;
  const residual = proj?.balanceSantim ?? 0n;

  if (residual > 0n) {
    await postTransaction(db, {
      kind: "ROUND_RESIDUAL",
      idempotencyKey: `residual:${roomId}`,
      memo: `Round residual — ${room.title}: unawarded pool to house revenue`,
      roundId: roomId,
      tenantId: room.tenantId,
      entries: [
        {
          accountCode: AccountCodes.roundEscrow(roomId),
          accountType: "LIABILITY",
          accountName: `Round escrow — ${room.title}`,
          direction: "DEBIT",
          amount: residual,
          tenantId: room.tenantId,
        },
        {
          accountCode: AccountCodes.houseRevenue(),
          accountType: "REVENUE",
          accountName: "House revenue",
          direction: "CREDIT",
          amount: residual,
          tenantId: room.tenantId,
        },
      ],
    });
  } else if (residual < 0n) {
    // Defensive: over-award can only happen with a FIXED rule above the pool.
    // The house covers the shortfall so the escrow closes at exactly zero.
    await postTransaction(db, {
      kind: "ADJUSTMENT",
      idempotencyKey: `escrow-cover:${roomId}`,
      memo: `Escrow shortfall cover — ${room.title}`,
      roundId: roomId,
      tenantId: room.tenantId,
      entries: [
        {
          accountCode: AccountCodes.houseRevenue(),
          accountType: "REVENUE",
          accountName: "House revenue",
          direction: "DEBIT",
          amount: -residual,
          tenantId: room.tenantId,
        },
        {
          accountCode: AccountCodes.roundEscrow(roomId),
          accountType: "LIABILITY",
          accountName: `Round escrow — ${room.title}`,
          direction: "CREDIT",
          amount: -residual,
          tenantId: room.tenantId,
        },
      ],
    });
  }

  // 2. Fairness reveal (ADR-18 step 3): anyone can now regenerate the exact
  //    sequence and verify it against the commitment published at LOCK.
  if (room.seal && !room.seal.revealedAt) {
    const revealedSeed = openSealedSeed(room.seal.serverSeedEnc);
    await db.fairnessSeal.update({
      where: { roomId },
      data: {
        revealedSeed,
        revealedAt: new Date(),
        inputHash: hashPayload({
          roomId,
          grossSantim: room.grossSantim.toString(),
          netPoolSantim: room.netPoolSantim.toString(),
          tickets: (await db.ticket.count({ where: { roomId } })),
        }),
      },
    });
  }

  // 3. Immutable round report (FR-ADM-08).
  await persistRoundReport(roomId);

  // 4. Terminal state + event + config unlock.
  await db.room.update({ where: { id: roomId }, data: { status: "COMPLETED", completedAt: new Date() } });
  const prizesPaid = room.grossSantim - room.netPoolSantim;
  await emitOutbox(db, {
    type: "ROUND_COMPLETED",
    aggregateId: roomId,
    payload: {
      roomId,
      title: room.title,
      gross: room.grossSantim.toString(),
      netPool: room.netPoolSantim.toString(),
      prizesPaid: prizesPaid.toString(),
      residual: residual > 0n ? residual.toString() : "0",
    },
    consumer: "gateway",
  });

  const pinnedIds = [room.templateVersionId, room.rulesetVersionId];
  try {
    pinnedIds.push(...JSON.parse(room.patternVersionIds));
  } catch {
    /* patternVersionIds always written by us — defensive only */
  }
  const versions = await db.configVersion.findMany({ where: { id: { in: pinnedIds } }, select: { entityId: true } });
  for (const v of versions) {
    await db.configEntity.update({ where: { id: v.entityId }, data: { locked: false } });
  }

  // 5. Commission accrual for the tenant-day (UC-15) — idempotent per
  //    tenant-day; failure must never block round completion.
  if (room.tenantId) {
    try {
      const outcome = await runAccrualForTenantDay(room.tenantId, dayKey(new Date()));
      if (!outcome.skipped) {
        console.log(`[engine] commission accrual ${room.tenantId} ${outcome.day}: turnover ${outcome.turnoverSantim} × ${outcome.rateBps}bps = ${outcome.commissionSantim}`);
      }
    } catch (err) {
      console.error(`[engine] accrual failed for tenant ${room.tenantId} (non-blocking):`, err);
    }
  }

  dropRoomState(roomId);
  console.log(`[engine] ${room.title} → COMPLETED (gross ${room.grossSantim}, prizes ${prizesPaid})`);
}
