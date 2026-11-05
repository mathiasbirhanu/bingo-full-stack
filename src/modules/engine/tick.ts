/**
 * Draw tick — the hot path of a live round (UC-04, FR-GAME-04..08).
 *
 * One turn per room per tick, strictly sequential in-process (the ADR-01
 * single-threaded grain turn). Per turn:
 *   1. lazily materialise the deterministic ball sequence from the seal
 *      (crash-safe: the sequence is a pure function of committed inputs);
 *   2. if the room's ball interval has elapsed, persist the next BallDraw +
 *      emit BALL_CALLED on the outbox (ADR-19 sequence numbers);
 *   3. award resolution depends on the room's claim mode:
 *        autoClaim=true  → server-side auto-daub (ADR-20): every open
 *                          pattern × every ticket, paying tiers NOW;
 *        autoClaim=false → MANUAL PLAY: nothing auto-pays — players daub and
 *                          tap BINGO! themselves (engine/claim.ts). The tick
 *                          only draws balls and watches for completion.
 *   4. completion: all balls drawn (auto rooms immediately; manual rooms
 *      after CLAIM_GRACE_MS so last-second claims land) or every tier paid
 *      → RESOLVING.
 */
import { db } from "../../lib/db";
import { emitOutbox } from "../../lib/write-path";
import { generateDrawSequence, openSealedSeed } from "../game-core/draw";
import { gridSpec } from "../game-core/variants";
import { isPatternComplete } from "../game-core/patterns";
import type { PrizeRule } from "../prize/rulesets";
import type { EngineRoomState } from "./state";
import { roomState } from "./state";
import { buildRoomState } from "./lifecycle";
import { finishRoom } from "./finish";
import { payTier } from "./pay";
import { CLAIM_GRACE_MS } from "./claim";

type RoomRow = Awaited<ReturnType<typeof db.room.findUniqueOrThrow>>;

/**
 * Pure completion decision (unit-tested): a round completes when every tier
 * paid, or every ball drawn (auto rooms instantly; manual rooms only after
 * the claim grace window so a last-second BINGO! can still land).
 */
export function shouldCompleteRound(args: {
  allBallsDrawn: boolean;
  allTiersPaid: boolean;
  autoClaim: boolean;
  lastBallCalledAt: number | null;
  now: number;
}): boolean {
  if (args.allTiersPaid) return true;
  if (!args.allBallsDrawn) return false;
  if (args.autoClaim) return true;
  if (args.lastBallCalledAt === null) return true;
  return args.now - args.lastBallCalledAt >= CLAIM_GRACE_MS;
}

/** Entry point for a DRAWING room; builds state on first sight (crash-safe). */
export async function tickDrawing(room: RoomRow): Promise<void> {
  let state = await roomStateOrBuild(room);

  if (!state.sequence) {
    const seal = await db.fairnessSeal.findUnique({ where: { roomId: room.id } });
    if (!seal) {
      // Defensive: a DRAWING room without a seal is a protocol violation —
      // send it to completion under the critical-fault path instead of drawing unbound balls.
      console.error(`[engine] ${room.title} DRAWING without seal — voiding`);
      await db.room.update({ where: { id: room.id }, data: { status: "RESOLVING" } });
      return;
    }
    const serverSeed = openSealedSeed(seal.serverSeedEnc);
    state.sequence = await generateDrawSequence(serverSeed, seal.salt, seal.clientSeedContribution, seal.nonce, room.variantId);
    await loadTickets(state);
  }

  const spec = gridSpec(room.variantId);
  const allPaid = state.rules.length > 0 && state.closedRules.size >= state.rules.length;

  // Completion check on entry (covers restart-after-last-ball and the manual
  // grace window without drawing anything).
  const lastAny = await db.ballDraw.findFirst({ where: { roomId: room.id }, orderBy: { seq: "desc" } });
  if (
    shouldCompleteRound({
      allBallsDrawn: state.drawnCount >= spec.ballsTotal,
      allTiersPaid: allPaid,
      autoClaim: room.autoClaim,
      lastBallCalledAt: lastAny?.calledAt.getTime() ?? null,
      now: Date.now(),
    })
  ) {
    await completeRound(room);
    return;
  }

  // Manual claim grace: the deck is out but the window is still open — the
  // drum is empty. Never draw past the last ball while waiting for claims.
  if (state.drawnCount >= spec.ballsTotal) return;

  const last = lastAny;
  const lastAt = last?.calledAt.getTime() ?? room.scheduledAt.getTime();
  if (Date.now() - lastAt < room.ballIntervalMs) return;

  const seq = state.drawnCount + 1;
  if (seq > spec.ballsTotal) return; // defensive: never draw past the deck
  const ball = state.sequence[seq - 1];

  await db.$transaction(async (tx) => {
    await tx.ballDraw.create({ data: { roomId: room.id, seq, ball } });
    await emitOutbox(tx, {
      type: "BALL_CALLED",
      aggregateId: room.id,
      payload: { roomId: room.id, seq, ball },
      consumer: "gateway",
    });
  });
  state.drawnCount = seq;

  const called = new Set(state.sequence.slice(0, seq));
  if (room.autoClaim) {
    await resolveAwards(state, room, seq, ball, called);
  }

  const paidNow = state.rules.length > 0 && state.closedRules.size >= state.rules.length;
  if (
    shouldCompleteRound({
      allBallsDrawn: seq >= spec.ballsTotal,
      allTiersPaid: paidNow,
      autoClaim: room.autoClaim,
      lastBallCalledAt: Date.now(),
      now: Date.now(),
    })
  ) {
    await completeRound(room);
  }
}

/** Entry point for a DRAWING room; builds state on first sight (crash-safe). */
async function roomStateOrBuild(room: RoomRow): Promise<EngineRoomState> {
  const existing = roomState(room.id);
  if (existing) return existing;
  return buildRoomState(room);
}

async function loadTickets(state: EngineRoomState): Promise<void> {
  const rows = await db.ticket.findMany({
    where: { roomId: state.roomId },
    select: { id: true, playerId: true, numbersJson: true },
  });
  state.tickets = new Map(
    rows.map((t) => {
      let cells: (number | null)[][] = [];
      try {
        cells = JSON.parse(t.numbersJson);
      } catch {
        cells = [];
      }
      return [t.id, { playerId: t.playerId, cells }];
    })
  );
}

/**
 * Auto-daub award resolution for one ball tick. Sequential per pattern;
 * each paying tier is exactly one balanced journal + one outbox event
 * (the payment core lives in pay.ts — shared with manual BINGO! claims).
 */
async function resolveAwards(
  state: EngineRoomState,
  room: RoomRow,
  seq: number,
  ball: number,
  called: Set<number>
): Promise<void> {
  if (!state.tickets) return; // no sales — nothing to award

  for (const pattern of state.patterns) {
    if (state.closedRules.has(pattern.entityId)) continue;
    const rule = state.rules.find((r) => r.patternRef === pattern.entityId);
    if (!rule) continue;

    const winners: Array<{ ticketId: string; playerId: string }> = [];
    for (const [ticketId, t] of state.tickets) {
      if (t.cells.length === 0) continue;
      if (isPatternComplete(room.variantId, t.cells, called, pattern.payload).complete) {
        winners.push({ ticketId, playerId: t.playerId });
      }
    }
    if (winners.length === 0) continue;

    const res = await payTier({
      roomId: room.id,
      roomTitle: room.title,
      tenantId: room.tenantId,
      pattern,
      rule: rule as PrizeRule,
      seq,
      ball,
      winners,
      claimKind: "auto",
    });
    state.closedRules.add(pattern.entityId);
    console.log(
      `[engine] ${room.title} → "${pattern.label}" paid ball #${ball} @${seq} (${winners.length} winner(s), ${res.each} each)`
    );
  }
}

async function completeRound(room: RoomRow): Promise<void> {
  const current = await db.room.findUniqueOrThrow({ where: { id: room.id } });
  if (current.status === "DRAWING") {
    await db.room.update({ where: { id: room.id }, data: { status: "RESOLVING" } });
    await emitOutbox(db, {
      type: "ROOM_PHASE",
      aggregateId: room.id,
      payload: { roomId: room.id, status: "RESOLVING" },
      consumer: "gateway",
    });
  }
  await finishRoom(room.id);
}
