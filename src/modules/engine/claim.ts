/**
 * Player BINGO! claims — the manual-play path (UC-04, room.autoClaim = false).
 *
 * Semantics (honest by construction):
 *   · The server never trusts client daubs — it validates every claim against
 *     the CALLED-ball set (the same source the auto-claim engine uses).
 *   · The caller's completed tickets select the tier; the tier then pays
 *     across EVERY ticket in the room that completes it at this ball — the
 *     "simultaneous winners split evenly" rule survives manual claiming.
 *   · The tier closes at first payment (identical to auto-claim), and the
 *     in-process grain state is updated in the same turn so the next tick
 *     never double-pays (ADR-01 single-process grain).
 *   · Claims are serialized per room with an in-process mutex: two BINGO!
 *     taps racing the same tick resolve one after the other, never twice.
 *
 * Completion waiting: with autoClaim=false the round does NOT complete on the
 * last ball — it waits CLAIM_GRACE_MS so last-second claims can land, then
 * the unclaimed residual flows to the house via the normal finish path.
 */
import { db } from "../../lib/db";
import { gridSpec } from "../game-core/variants";
import { isPatternComplete, type PatternPayload } from "../game-core/patterns";
import type { PrizeRule } from "../prize/rulesets";
import { buildRoomState } from "./lifecycle";
import { roomState, type EnginePattern, type EngineRoomState } from "./state";
import { payTier } from "./pay";

/** How long a manual room waits on the last ball for late BINGO! claims. */
export const CLAIM_GRACE_MS = 20_000;

export interface ClaimOutcome {
  claimed: boolean;
  reason?: string;
  message?: string;
  label?: string;
  eachSantim?: string;
  ballSeq?: number;
  winners?: number;
  best?: { label: string; remaining: number } | null;
}

/* ---------------------------------------------------------------------------
 * Pure decision core (unit-tested, no DB)
 * ------------------------------------------------------------------------- */

export interface ClaimPatternDef {
  entityId: string;
  versionId: string;
  label: string;
  payload: PatternPayload;
}

export type PickRules = Array<{ patternRef: string; label?: string }>;

export interface PickInput {
  variantId: string;
  /** Ruleset rules in payout order. */
  rules: PickRules;
  patterns: ClaimPatternDef[];
  /** Pattern entityIds already paid this round. */
  closedRules: Set<string>;
  /** The claimer's card grids. */
  myTickets: Array<(number | null)[][]>;
  /** Every ticket in the room (fair split across all completers). */
  allTickets: Array<{ ticketId: string; playerId: string; cells: (number | null)[][] }>;
  called: Set<number>;
}

export type PickResult =
  | { pattern: ClaimPatternDef; ruleIndex: number; winners: Array<{ ticketId: string; playerId: string }> }
  | { pattern: null; best: { label: string; remaining: number } | null };

/** How many more marks a card needs to complete this pattern (0 = complete). */
export function patternRemaining(variantId: string, cells: (number | null)[][], called: Set<number>, payload: PatternPayload): number {
  const spec = gridSpec(variantId);
  const isMarked = (r: number, c: number): boolean => {
    const n = cells[r]?.[c];
    if (n === null) return spec.freeCells.some(([fr, fc]) => fr === r && fc === c);
    return called.has(n);
  };
  switch (payload.kind) {
    case "CELLS":
      return payload.cells.filter(([r, c]) => !isMarked(r, c)).length;
    case "ROWS_MIN": {
      let done = 0;
      for (let r = 0; r < spec.rows; r++) {
        let all = true;
        for (let c = 0; c < spec.cols; c++) {
          if (cells[r][c] !== null && !called.has(cells[r][c] as number)) {
            all = false;
            break;
          }
        }
        if (all) done++;
      }
      return Math.max(0, payload.rows - done);
    }
    case "FULL_HOUSE": {
      let missing = 0;
      for (const row of cells) for (const n of row) if (n !== null && !called.has(n)) missing++;
      return missing;
    }
  }
}

/**
 * First payable tier for the caller, in ruleset order, across the caller's
 * own tickets. When nothing completes, returns the closest open pattern for
 * a friendly "2 more for Top Line!" message.
 */
export function pickClaim(input: PickInput): PickResult {
  const { variantId, rules, patterns, closedRules, myTickets, allTickets, called } = input;
  const byEntity = new Map(patterns.map((p) => [p.entityId, p]));
  let best: { label: string; remaining: number } | null = null;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const pattern = byEntity.get(rule.patternRef);
    if (!pattern || closedRules.has(pattern.entityId)) continue;

    let myRemaining = Infinity;
    for (const cells of myTickets) {
      const rem = patternRemaining(variantId, cells, called, pattern.payload);
      if (rem < myRemaining) myRemaining = rem;
    }
    if (myRemaining === Infinity) continue;
    if (myRemaining > 0) {
      if (!best || myRemaining < best.remaining) best = { label: pattern.label, remaining: myRemaining };
      continue;
    }

    // The caller completed this tier → pay across every ticket in the room
    // that completes it at this same ball (split fairness, FR-PRZ).
    const winners: Array<{ ticketId: string; playerId: string }> = [];
    for (const t of allTickets) {
      if (t.cells.length === 0) continue;
      if (isPatternComplete(variantId, t.cells, called, pattern.payload).complete) {
        winners.push({ ticketId: t.ticketId, playerId: t.playerId });
      }
    }
    if (winners.length === 0) continue;
    return { pattern, ruleIndex: i, winners };
  }
  return { pattern: null, best };
}

/* ---------------------------------------------------------------------------
 * Server action (DB)
 * ------------------------------------------------------------------------- */

async function loadTicketsInto(state: EngineRoomState): Promise<void> {
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

/** Per-room claim mutex — serializes BINGO! claims within the grain (ADR-01). */
const locks = new Map<string, Promise<void>>();

export async function claimPrize(roomId: string, playerId: string): Promise<ClaimOutcome> {
  const prev = locks.get(roomId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  locks.set(
    roomId,
    prev.then(() => gate)
  );
  await prev;
  try {
    return await claimPrizeInner(roomId, playerId);
  } finally {
    release();
    if (locks.get(roomId) === gate) locks.delete(roomId);
  }
}

async function claimPrizeInner(roomId: string, playerId: string): Promise<ClaimOutcome> {
  const room = await db.room.findUnique({ where: { id: roomId } });
  if (!room) return { claimed: false, reason: "ROOM_NOT_FOUND", message: "Round not found." };
  if (room.status !== "DRAWING") {
    return { claimed: false, reason: "ROOM_NOT_DRAWING", message: "The round is not drawing right now." };
  }
  if (room.autoClaim) {
    return { claimed: false, reason: "AUTO_CLAIM_ROOM", message: "This hall pays automatically — no tap needed." };
  }

  // Grain state (rebuilt from the DB any time — crash-safe).
  let state = roomState(roomId);
  if (!state) state = await buildRoomState(room);
  if (!state.tickets) await loadTicketsInto(state);

  // The called set from the system of record — client daubs are only UI.
  const balls = await db.ballDraw.findMany({
    where: { roomId },
    orderBy: { seq: "asc" },
    select: { seq: true, ball: true },
  });
  const called = new Set(balls.map((b) => b.ball));
  const seq = balls.length ? balls[balls.length - 1].seq : 0;
  const ball = balls.length ? balls[balls.length - 1].ball : 0;

  const myTickets: Array<(number | null)[][]> = [];
  const allTickets: Array<{ ticketId: string; playerId: string; cells: (number | null)[][] }> = [];
  for (const [ticketId, t] of state.tickets!) {
    allTickets.push({ ticketId, playerId: t.playerId, cells: t.cells });
    if (t.playerId === playerId) myTickets.push(t.cells);
  }
  if (myTickets.length === 0) {
    return { claimed: false, reason: "NO_TICKETS", message: "You hold no cards in this round." };
  }

  const pick = pickClaim({
    variantId: room.variantId,
    rules: state.rules as PickRules,
    patterns: state.patterns as ClaimPatternDef[],
    closedRules: state.closedRules,
    myTickets,
    allTickets,
    called,
  });

  if (!pick.pattern) {
    return {
      claimed: false,
      reason: "NOT_YET",
      message: pick.best ? `Not yet — ${pick.best.remaining} more for ${pick.best.label}!` : "Not yet — keep tapping!",
      best: pick.best,
    };
  }

  const rule = state.rules[pick.ruleIndex];
  const res = await payTier({
    roomId,
    roomTitle: room.title,
    tenantId: room.tenantId,
    pattern: pick.pattern,
    rule,
    seq,
    ball,
    winners: pick.winners,
    claimKind: "player",
    claimPlayerId: playerId,
  });

  // Keep the in-process grain in sync: the next tick must not re-award.
  state.closedRules.add(pick.pattern.entityId);

  console.log(
    `[engine] ${room.title} ← BINGO! claim "${pick.pattern.label}" paid ball #${ball} @${seq} (${pick.winners.length} winner(s))`
  );
  return {
    claimed: true,
    label: pick.pattern.label,
    eachSantim: res.each.toString(),
    ballSeq: seq,
    winners: pick.winners.length,
  };
}
