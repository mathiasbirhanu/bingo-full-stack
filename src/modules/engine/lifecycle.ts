/**
 * Round lifecycle driver (UC-03/04/05, FR-ROOM) — the time-driven half of the
 * room grain turn:
 *
 *   SCHEDULED ──(salesOpenAt)──▶ SALES_OPEN ──(salesCloseAt)──▶ LOCKED
 *   LOCKED ──(scheduledAt)──▶ DRAWING ──(all balls / all tiers paid)──▶
 *   RESOLVING ──▶ COMPLETED            (VOIDED from sales/drawing paths)
 *
 * The LOCK transition publishes the commit-reveal envelope (ADR-18) and pins
 * the config entities the round resolved against (FR-ROOM-02): template,
 * ruleset and patterns are locked for the room's lifetime, unlocked at
 * completion.
 */
import { db } from "../../lib/db";
import { parseJson } from "../../lib/json";
import { emitOutbox } from "../../lib/write-path";
import { makeCommitment } from "../game-core/draw";
import type { PatternPayload } from "../game-core/patterns";
import type { PrizeRule, RulesetPayload } from "../prize/rulesets";
import { setRoomState, dropRoomState, type EnginePattern, type EngineRoomState } from "./state";

type RoomRow = Awaited<ReturnType<typeof db.room.findUniqueOrThrow>>;

/** Build (or rebuild) the engine state of a room purely from the database. */
export async function buildRoomState(room: RoomRow): Promise<EngineRoomState> {
  const versionIds = parseJson<string[]>(room.patternVersionIds, "patternPins");
  const patternVersions = versionIds.length
    ? await db.configVersion.findMany({ where: { id: { in: versionIds } } })
    : [];
  const patternEntities = patternVersions.length
    ? await db.configEntity.findMany({ where: { id: { in: patternVersions.map((v) => v.entityId) } } })
    : [];

  const patterns: EnginePattern[] = patternVersions
    .map((pv) => {
      const entity = patternEntities.find((e) => e.id === pv.entityId);
      return {
        entityId: pv.entityId,
        versionId: pv.id,
        label: entity?.name ?? pv.entityId,
        payload: parseJson<PatternPayload>(pv.payloadJson, `pattern:${pv.id}`),
      };
    })
    .filter((p) => p.payload !== null);

  const rulesetVersion = await db.configVersion.findUnique({ where: { id: room.rulesetVersionId } });
  const ruleset = parseJson<RulesetPayload>(rulesetVersion?.payloadJson ?? '{"rules":[]}', "ruleset");
  const rules: PrizeRule[] = ruleset.rules ?? [];

  const drawnCount = await db.ballDraw.count({ where: { roomId: room.id } });
  const confirmed = await db.claim.findMany({
    where: { roomId: room.id, status: "CONFIRMED" },
    select: { patternVersionId: true },
    distinct: ["patternVersionId"],
  });
  const closedVersionIds = new Set(confirmed.map((c) => c.patternVersionId));
  const closedRules = new Set<string>();
  for (const p of patterns) if (closedVersionIds.has(p.versionId)) closedRules.add(p.entityId);

  const state: EngineRoomState = {
    roomId: room.id,
    variantId: room.variantId,
    patterns,
    rules,
    sequence: null,
    drawnCount,
    closedRules,
    tickets: null,
  };
  setRoomState(state);
  return state;
}

export async function transitionSalesOpen(room: RoomRow): Promise<void> {
  await db.room.update({ where: { id: room.id }, data: { status: "SALES_OPEN" } });
  await emitOutbox(db, {
    type: "ROOM_PHASE",
    aggregateId: room.id,
    payload: { roomId: room.id, status: "SALES_OPEN", title: room.title },
    consumer: "gateway",
  });
  console.log(`[engine] ${room.title} → SALES_OPEN`);
}

/**
 * LOCK: sales close, the fairness envelope is published (commitment visible
 * to every player from this moment), and all pinned config entities are
 * locked against edits while the round resolves against them.
 */
export async function transitionLock(room: RoomRow): Promise<void> {
  const tickets = await db.ticket.findMany({ where: { roomId: room.id }, select: { id: true }, orderBy: { id: "asc" } });
  const commitment = makeCommitment(tickets.map((t) => t.id));

  await db.$transaction(async (tx) => {
    await tx.room.update({ where: { id: room.id }, data: { status: "LOCKED" } });
    await tx.fairnessSeal.create({
      data: {
        roomId: room.id,
        commitment: commitment.commitment,
        clientSeedContribution: commitment.clientSeedContribution,
        salt: commitment.salt,
        serverSeedEnc: commitment.serverSeedSealed,
        nonce: commitment.nonce,
        inputHash: "PENDING_RESOLUTION",
      },
    });
    const pinnedIds = [room.templateVersionId, room.rulesetVersionId, ...parseJson<string[]>(room.patternVersionIds, "pins")];
    const versions = await tx.configVersion.findMany({ where: { id: { in: pinnedIds } }, select: { entityId: true } });
    for (const v of versions) {
      await tx.configEntity.update({ where: { id: v.entityId }, data: { locked: true } });
    }
    await emitOutbox(tx, {
      type: "ROOM_PHASE",
      aggregateId: room.id,
      payload: { roomId: room.id, status: "LOCKED", commitment: commitment.commitment },
      consumer: "gateway",
    });
  });
  console.log(`[engine] ${room.title} → LOCKED (commitment ${commitment.commitment.slice(0, 12)}…)`);
}

export async function transitionDrawing(room: RoomRow): Promise<void> {
  await db.room.update({ where: { id: room.id }, data: { status: "DRAWING" } });
  await emitOutbox(db, {
    type: "ROOM_PHASE",
    aggregateId: room.id,
    payload: { roomId: room.id, status: "DRAWING", ballIntervalMs: room.ballIntervalMs },
    consumer: "gateway",
  });
  console.log(`[engine] ${room.title} → DRAWING`);
}

/** Remove engine state for a room that left the live set (completed/voided). */
export function retireRoom(roomId: string): void {
  dropRoomState(roomId);
}
