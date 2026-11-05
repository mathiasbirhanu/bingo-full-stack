/**
 * Room queries — lists, detail with rules + live prize preview (FR-PLY-02:
 * the prize table shown equals the live preview recomputed from confirmed
 * sales), and scheduling helpers used by the worker.
 */
import { db } from "../../lib/db";
import { parseJson } from "../../lib/json";
import { tierAmountFor, type RulesetPayload, type PrizeRule } from "../prize";
import type { PatternPayload } from "../game-core/patterns";
import type { Santim } from "../../lib/money";

export interface RoomListItem {
  id: string;
  title: string;
  variantId: string;
  status: string;
  tenantId: string | null;
  priceSantim: string;
  maxCards: number;
  scheduledAt: string;
  salesOpenAt: string;
  players: number;
  tickets: number;
}

export async function listRooms(): Promise<RoomListItem[]> {
  const rooms = await db.room.findMany({
    orderBy: { scheduledAt: "asc" },
    include: { _count: { select: { tickets: true } } },
  });
  // distinct players per room
  const groups = await db.ticket.groupBy({ by: ["roomId", "playerId"] });
  const playerCounts = new Map<string, number>();
  for (const g of groups) playerCounts.set(g.roomId, (playerCounts.get(g.roomId) ?? 0) + 1);

  return rooms.map((r) => ({
    id: r.id,
    title: r.title,
    variantId: r.variantId,
    status: r.status,
    tenantId: r.tenantId,
    priceSantim: r.priceSantim.toString(),
    maxCards: r.maxCardsPerPlayer,
    scheduledAt: r.scheduledAt.toISOString(),
    salesOpenAt: r.salesOpenAt.toISOString(),
    players: playerCounts.get(r.id) ?? 0,
    tickets: r._count.tickets,
  }));
}

export interface PrizePreviewRow {
  patternId: string;
  patternLabel: string;
  awardType: string;
  tierSantim: string;
}

export interface RoomDetail {
  id: string;
  title: string;
  variantId: string;
  status: string;
  tenantId: string | null;
  priceSantim: string;
  maxCards: number;
  ballIntervalMs: number;
  autoClaim: boolean;
  /** Distinct players holding cards this round — powers the live info bar. */
  players: number;
  scheduledAt: string;
  salesOpenAt: string;
  salesCloseAt: string;
  grossSantim: string;
  netPoolSantim: string;
  prizeTable: PrizePreviewRow[];
  /** Pinned pattern shapes — the client draws the "how to win" diagrams and
   *  validates the BINGO! tap from exactly what the round resolves against. */
  patterns: Array<{ patternId: string; label: string; payload: PatternPayload }>;
  myTickets: Array<{ ticketId: string; numbers: (number | null)[][] }>;
}

/**
 * Live prize preview for a room: rules resolved from the pinned ruleset
 * version, tier amounts recomputed from CURRENT confirmed sales (gross −
 * prizes paid). This is the exact function the player UI shows pre-purchase.
 */
export async function roomDetail(roomId: string, viewerPlayerId?: string): Promise<RoomDetail> {
  const room = await db.room.findUnique({
    where: { id: roomId },
    include: {
      tickets: viewerPlayerId ? { where: { playerId: viewerPlayerId } } : false,
    },
  });
  if (!room) throw new Error("ROOM_NOT_FOUND");

  // Distinct players in the round (the live info bar's "N players" chip).
  const playerRows = await db.ticket.groupBy({ by: ["playerId"], where: { roomId: room.id } });

  const rulesetVersion = await db.configVersion.findUnique({ where: { id: room.rulesetVersionId } });
  const ruleset = parseJson<RulesetPayload>(rulesetVersion?.payloadJson ?? "{}", "ruleset");
  const netPool = room.netPoolSantim; // gross − prizes paid so far

  // Resolve pattern labels from the pinned pattern versions.
  const patternVersionIds = parseJson<string[]>(room.patternVersionIds, "pins");
  const patternVersions = await db.configVersion.findMany({ where: { id: { in: patternVersionIds } } });
  const entities = await db.configEntity.findMany({
    where: { id: { in: patternVersions.map((v) => v.entityId) } },
  });
  const labelByEntity = new Map(entities.map((e) => [e.id, e.name]));

  const prizeTable: PrizePreviewRow[] = ruleset.rules.map((rule: PrizeRule) => {
    const pv = patternVersions.find((v) => v.entityId === rule.patternRef);
    return {
      patternId: rule.patternRef,
      patternLabel: labelByEntity.get(rule.patternRef) ?? rule.label ?? rule.patternRef,
      awardType: rule.awardType,
      tierSantim: tierAmountFor(rule, room.grossSantim, netPool).toString(),
      ...(pv ? {} : {}),
    };
  });

  // Pattern shapes for the player UI (same pinned versions the round resolves
  // against — FR-ROOM-02). A failed parse drops the diagram, never the round.
  const patterns = patternVersions
    .map((pv) => ({
      patternId: pv.entityId,
      label: labelByEntity.get(pv.entityId) ?? pv.entityId,
      payload: parseJson<PatternPayload>(pv.payloadJson, `pattern:${pv.id}`),
    }))
    .filter((p): p is { patternId: string; label: string; payload: PatternPayload } => p.payload !== null);

  return {
    id: room.id,
    title: room.title,
    variantId: room.variantId,
    status: room.status,
    tenantId: room.tenantId,
    priceSantim: room.priceSantim.toString(),
    maxCards: room.maxCardsPerPlayer,
    patterns,
    ballIntervalMs: room.ballIntervalMs,
    autoClaim: room.autoClaim,
    players: playerRows.length,
    scheduledAt: room.scheduledAt.toISOString(),
    salesOpenAt: room.salesOpenAt.toISOString(),
    salesCloseAt: room.salesCloseAt.toISOString(),
    grossSantim: room.grossSantim.toString(),
    netPoolSantim: netPool.toString(),
    prizeTable,
    myTickets: viewerPlayerId
      ? (room.tickets as Array<{ id: string; numbersJson: string }>).map((t) => ({
          ticketId: t.id,
          numbers: parseJson<(number | null)[][]>(t.numbersJson, "ticket"),
        }))
      : [],
  };
}

/**
 * Rolling scheduler input: for each published room template, ensure the next
 * `keep` rounds exist. Used by the platform worker (S1 walking skeleton keeps
 * demo rooms flowing without manual scheduling).
 */
export async function ensureRollingRooms(keepAhead = 3) {
  const templates = await db.configEntity.findMany({
    where: { type: "ROOM_TEMPLATE", currentVersion: { gt: 0 }, locked: false },
  });
  const created: string[] = [];
  for (const tpl of templates) {
    const version = await db.configVersion.findFirst({
      where: { entityId: tpl.id, version: tpl.currentVersion },
      orderBy: { version: "desc" },
    });
    if (!version) continue;
    const payload = parseJson<{
      title: string;
      variantId: string;
      priceSantim: string;
      cadenceMinutes: number;
      salesOpenMinutes: number;
      salesMinutes: number;
      ballIntervalMs?: number;
      autoClaim?: boolean;
      rulesetRef: string;
      patternRefs: string[];
    }>(version.payloadJson, "template");

    const last = await db.room.findFirst({
      where: { templateVersionId: version.id, status: { in: ["SCHEDULED", "SALES_OPEN", "LOCKED", "DRAWING"] } },
      orderBy: { scheduledAt: "desc" },
    });
    const upcoming = await db.room.count({
      where: { templateVersionId: version.id, status: { in: ["SCHEDULED", "SALES_OPEN", "LOCKED", "DRAWING"] } },
    });

    let nextStart = last ? new Date(last.scheduledAt.getTime() + payload.cadenceMinutes * 60_000) : new Date(Date.now() + 90_000);
    if (nextStart.getTime() < Date.now()) nextStart = new Date(Date.now() + 90_000);

    for (let i = upcoming; i < keepAhead; i++) {
      const salesOpen = new Date(nextStart.getTime() - payload.salesOpenMinutes * 60_000);
      const salesClose = new Date(nextStart.getTime() + payload.salesMinutes * 60_000);
      const rulesetVersionRow = await db.configVersion.findFirst({
        where: { entityId: payload.rulesetRef, version: (await db.configEntity.findUniqueOrThrow({ where: { id: payload.rulesetRef } })).currentVersion },
      });
      if (!rulesetVersionRow) break;
      const patternVersionIds: string[] = [];
      for (const pref of payload.patternRefs) {
        const ent = await db.configEntity.findUnique({ where: { id: pref } });
        if (!ent || ent.currentVersion === 0) continue;
        const pv = await db.configVersion.findFirst({ where: { entityId: pref, version: ent.currentVersion } });
        if (pv) patternVersionIds.push(pv.id);
      }
      const room = await db.room.create({
        data: {
          tenantId: tpl.tenantId,
          title: payload.title,
          templateVersionId: version.id,
          rulesetVersionId: rulesetVersionRow.id,
          patternVersionIds: JSON.stringify(patternVersionIds),
          variantId: payload.variantId,
          priceSantim: BigInt(payload.priceSantim),
          ballIntervalMs: payload.ballIntervalMs ?? 4000,
          autoClaim: payload.autoClaim ?? true,
          scheduledAt: nextStart,
          salesOpenAt: salesOpen,
          salesCloseAt: salesClose,
        },
      });
      created.push(room.id);
      nextStart = new Date(nextStart.getTime() + payload.cadenceMinutes * 60_000);
    }
  }
  return created;
}

export type { Santim };
