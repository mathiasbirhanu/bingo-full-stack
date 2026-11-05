/**
 * Tier payment — the shared awarding core (FR-PLY-02, ADR-16). Both awarding
 * paths use this exact code so the maths can never drift:
 *   · engine auto-claim (room.autoClaim = true) — pays on the ball tick;
 *   · player BINGO! claims (room.autoClaim = false) — pays on claim (UC-04).
 *
 * One paying tier is exactly: one balanced PRIZE journal, one Claim row per
 * winning ticket, one AWARDS_RESOLVED outbox event, one audit line — and the
 * net-pool decrement on the room row. Simultaneous winners split floor-first
 * (bigint division truncates), the remainder stays in the round escrow.
 */
import { db } from "../../lib/db";
import { emitOutbox, auditTx } from "../../lib/write-path";
import { tierAmountFor, type PrizeRule } from "../prize/rulesets";
import { AccountCodes, postTransaction } from "../ledger";

export interface TierWinner {
  ticketId: string;
  playerId: string;
}

export interface PayTierInput {
  roomId: string;
  roomTitle: string;
  tenantId: string | null;
  pattern: { entityId: string; versionId: string; label: string };
  rule: PrizeRule;
  /** Ball sequence the tier is paid at (also the idempotency salt). */
  seq: number;
  ball: number;
  winners: TierWinner[];
  /** "auto" = engine tick, "player" = BINGO! claim (audit attribution). */
  claimKind: "auto" | "player";
  claimPlayerId?: string;
}

export interface PayTierResult {
  tier: bigint;
  each: bigint;
  total: bigint;
}

export async function payTier(input: PayTierInput): Promise<PayTierResult> {
  const { roomId, pattern, rule, seq, ball, winners } = input;

  // Tier amounts always recompute from the room row (FR-PLY-02: live preview
  // equals engine maths — same function, same inputs).
  const fresh = await db.room.findUniqueOrThrow({ where: { id: roomId } });
  const tier = tierAmountFor(rule, fresh.grossSantim, fresh.netPoolSantim);
  // bigint division truncates toward zero = floor(tier / k).
  const each = tier > 0n ? tier / BigInt(winners.length) : 0n;
  const total = each * BigInt(winners.length);

  await db.$transaction(async (tx) => {
    const posted =
      total > 0n
        ? await postTransaction(tx, {
            kind: "PRIZE",
            idempotencyKey: `prize:${roomId}:${pattern.entityId}:${seq}`,
            memo: `Prize "${pattern.label}" — ${winners.length} winner(s), ball #${ball} @${seq}${input.claimKind === "player" ? " (BINGO! claim)" : ""}`,
            roundId: roomId,
            tenantId: input.tenantId,
            entries: [
              {
                accountCode: AccountCodes.roundEscrow(roomId),
                accountType: "LIABILITY" as const,
                accountName: `Round escrow — ${input.roomTitle}`,
                direction: "DEBIT" as const,
                amount: total,
                tenantId: input.tenantId,
              },
              ...winners.map((w) => ({
                accountCode: AccountCodes.playerWallet(w.playerId),
                accountType: "LIABILITY" as const,
                accountName: "Player wallet",
                direction: "CREDIT" as const,
                amount: each,
                ownerUserId: w.playerId,
              })),
            ],
          })
        : null;

    for (const w of winners) {
      const prefix = input.claimKind === "auto" ? "auto" : `player:${input.claimPlayerId}`;
      await tx.claim.create({
        data: {
          clientClaimId: `${prefix}:${roomId}:${pattern.entityId}:${w.ticketId}`,
          roomId,
          ticketId: w.ticketId,
          playerId: w.playerId,
          patternVersionId: pattern.versionId,
          ballSeq: seq,
          status: "CONFIRMED",
          awardSantim: total > 0n ? each : null,
          journalTxId: posted?.id ?? null,
          decidedAt: new Date(),
        },
      });
    }

    if (total > 0n) {
      await tx.room.update({
        where: { id: roomId },
        data: { netPoolSantim: fresh.netPoolSantim - total },
      });
    }

    await emitOutbox(tx, {
      type: "AWARDS_RESOLVED",
      aggregateId: roomId,
      payload: {
        roomId,
        seq,
        ball,
        patternId: pattern.entityId,
        label: pattern.label,
        tier: tier.toString(),
        each: each.toString(),
        winners: winners.map((w) => ({ playerId: w.playerId, ticketId: w.ticketId, award: each.toString() })),
      },
      consumer: "gateway",
    });

    await auditTx(tx, {
      actorId: input.claimKind === "player" ? (input.claimPlayerId ?? null) : null,
      actorRole: input.claimKind === "auto" ? "ENGINE" : "PLAYER",
      tenantId: input.tenantId,
      action: "AWARD_CONFIRMED",
      entityType: "Claim",
      entityId: `${roomId}:${pattern.entityId}:${seq}`,
      meta: { ball, seq, winners: winners.length, tier: tier.toString(), each: each.toString(), via: input.claimKind },
    });
  });

  return { tier, each, total };
}
