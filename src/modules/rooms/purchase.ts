/**
 * Purchase saga (UC-03, FR-PLY-03/04, FR-FIN-01).
 *
 * One SQLite interactive transaction per purchase = the demo equivalent of the
 * SERIALIZABLE debit path in the production finance service. Guarantees:
 *   · exactly one debit and one card set per idempotency key (retry replays);
 *   · MAX_CARDS_REACHED / SALES_CLOSED / INSUFFICIENT_FUNDS checked BEFORE any debit;
 *   · CSPRNG cards with fingerprint uniqueness (retry on the rare collision);
 *   · TICKET_CONFIRMED reaches the event stream for the room engine.
 */
import { db } from "../../lib/db";
import { ApiError } from "../../lib/errors";
import { generateCard } from "../game-core";
import { AccountCodes, postTransaction } from "../ledger";
import { emitOutbox, auditTx } from "../../lib/write-path";

export interface PurchaseRequest {
  roomId: string;
  playerId: string;
  quantity: number;
  idempotencyKey: string;
}

export interface PurchaseResult {
  replayed: boolean;
  purchaseId: string;
  cards: Array<{ ticketId: string; numbers: (number | null)[][]; fingerprint: string }>;
  balanceSantim: bigint;
  newBalanceSantim: bigint;
}

export async function purchaseCards(req: PurchaseRequest): Promise<PurchaseResult> {
  if (!Number.isInteger(req.quantity) || req.quantity < 1) {
    throw new ApiError("VALIDATION_FAILED", "quantity must be a positive integer");
  }
  if (!req.idempotencyKey || req.idempotencyKey.length < 8 || req.idempotencyKey.length > 128) {
    throw new ApiError("VALIDATION_FAILED", "idempotency key required");
  }

  return db.$transaction(async (tx) => {
    // 1. Idempotent replay: same key → stored original result, never double-debit.
    const existing = await tx.purchase.findUnique({
      where: { idempotencyKey: req.idempotencyKey },
      include: { room: true },
    });
    if (existing) {
      const tickets = await tx.ticket.findMany({
        where: { roomId: existing.roomId, playerId: req.playerId, createdAt: { lte: existing.createdAt } },
        orderBy: { createdAt: "asc" },
      });
      const wallet = await tx.ledgerAccount.findUnique({ where: { code: AccountCodes.playerWallet(req.playerId) } });
      const proj = wallet ? await tx.walletBalance.findUnique({ where: { accountId: wallet.id } }) : null;
      return {
        replayed: true,
        purchaseId: existing.id,
        cards: tickets.map((t) => ({ ticketId: t.id, numbers: JSON.parse(t.numbersJson), fingerprint: t.fingerprint })),
        balanceSantim: existing.totalSantim,
        newBalanceSantim: proj?.balanceSantim ?? 0n,
      };
    }

    // 2. Room must be in sales window.
    const room = await tx.room.findUnique({ where: { id: req.roomId } });
    if (!room) throw new ApiError("ROOM_NOT_FOUND");
    if (room.status !== "SALES_OPEN") throw new ApiError("SALES_CLOSED", `room is ${room.status}`);

    // 3. Card cap BEFORE any debit (FR-PLY-03).
    const held = await tx.ticket.count({ where: { roomId: req.roomId, playerId: req.playerId } });
    if (held + req.quantity > room.maxCardsPerPlayer) {
      throw new ApiError("MAX_CARDS_REACHED", `holds ${held} of ${room.maxCardsPerPlayer}`);
    }

    // 4. Funds check BEFORE any debit.
    const total = room.priceSantim * BigInt(req.quantity);
    const wallet = await tx.ledgerAccount.findUnique({ where: { code: AccountCodes.playerWallet(req.playerId) } });
    const proj = wallet ? await tx.walletBalance.findUnique({ where: { accountId: wallet.id } }) : null;
    const balance = proj?.balanceSantim ?? 0n;
    if (balance < total) throw new ApiError("INSUFFICIENT_FUNDS");

    // 5. Issue CSPRNG cards (retry on the rare fingerprint collision).
    const tickets: Array<{ id: string; numbers: (number | null)[][]; fingerprint: string }> = [];
    for (let i = 0; i < req.quantity; i++) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const card = generateCard(room.variantId);
        try {
          const row = await tx.ticket.create({
            data: {
              roomId: room.id,
              playerId: req.playerId,
              tenantId: room.tenantId,
              numbersJson: JSON.stringify(card.cells),
              fingerprint: card.fingerprint,
            },
          });
          tickets.push({ id: row.id, numbers: card.cells, fingerprint: card.fingerprint });
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          if (!msg.includes("UNIQUE")) throw err;
          if (attempt === 4) throw new ApiError("INTERNAL", "card fingerprint collision after 5 attempts");
        }
      }
    }

    // 6. Debit wallet → escrow, balanced and idempotent.
    const posted = await postTransaction(tx, {
      kind: "PURCHASE",
      idempotencyKey: `purchase:${req.idempotencyKey}`,
      memo: `${req.quantity} card(s) @ ${(Number(room.priceSantim) / 100).toFixed(2)} ETB — room ${room.title}`,
      roundId: room.id,
      tenantId: room.tenantId,
      entries: [
        {
          accountCode: AccountCodes.playerWallet(req.playerId),
          accountType: "LIABILITY",
          accountName: "Player wallet",
          direction: "DEBIT",
          amount: total,
          ownerUserId: req.playerId,
        },
        {
          accountCode: AccountCodes.roundEscrow(room.id),
          accountType: "LIABILITY",
          accountName: `Round escrow — ${room.title}`,
          direction: "CREDIT",
          amount: total,
          tenantId: room.tenantId,
        },
      ],
    });

    const purchase = await tx.purchase.create({
      data: {
        idempotencyKey: req.idempotencyKey,
        roomId: room.id,
        playerId: req.playerId,
        quantity: req.quantity,
        totalSantim: total,
        journalTxId: posted.id,
      },
    });

    // 7. Round financial counters (gross up, net pool follows gross until prizes flow).
    await tx.room.update({
      where: { id: room.id },
      data: { grossSantim: room.grossSantim + total, netPoolSantim: room.netPoolSantim + total },
    });

    // 8. Ticket event for the room engine (gateway relay consumes it).
    await emitOutbox(tx, {
      type: "TICKET_CONFIRMED",
      aggregateId: room.id,
      payload: { purchaseId: purchase.id, playerId: req.playerId, quantity: req.quantity, ticketIds: tickets.map((t) => t.id) },
      consumer: "gateway",
    });
    await auditTx(tx, {
      actorId: req.playerId,
      actorRole: "PLAYER",
      tenantId: room.tenantId,
      action: "PURCHASE_CONFIRMED",
      entityType: "Purchase",
      entityId: purchase.id,
      meta: { quantity: req.quantity, total: total.toString(), journalTxId: posted.id },
    });

    const projAfter = await tx.walletBalance.findUniqueOrThrow({ where: { accountId: wallet!.id } });
    return {
      replayed: false,
      purchaseId: purchase.id,
      cards: tickets.map((t) => ({ ticketId: t.id, numbers: t.numbers, fingerprint: t.fingerprint })),
      balanceSantim: balance,
      newBalanceSantim: projAfter.balanceSantim,
    };
  });
}
