/**
 * Engine per-room state — the in-process equivalent of one Orleans RoomGrain
 * activation (ADR-01: one non-reentrant turn per live room). The registry is
 * rebuilt lazily from the system of record at any time (crash-safe): the draw
 * sequence derives deterministically from the FairnessSeal, so a room that
 * "re-materialises" after a restart continues its exact ball order.
 */
import type { PatternPayload } from "../game-core";
import type { PrizeRule } from "../prize";

export interface EnginePattern {
  /** ConfigEntity id of the pattern — also the prize rule's patternRef. */
  entityId: string;
  versionId: string;
  label: string;
  payload: PatternPayload;
}

export interface EngineRoomState {
  roomId: string;
  variantId: string;
  patterns: EnginePattern[];
  rules: PrizeRule[];
  /** Lazily generated from the seal on first draw — never serialised. */
  sequence: number[] | null;
  drawnCount: number;
  /** Pattern entityIds whose tier has already paid (tier closes at first award). */
  closedRules: Set<string>;
  /** Lazily loaded ticket index at first draw: ticketId → { playerId, cells }. */
  tickets: Map<string, { playerId: string; cells: (number | null)[][] }> | null;
}

const registry = new Map<string, EngineRoomState>();

export function roomState(roomId: string): EngineRoomState | undefined {
  return registry.get(roomId);
}

export function setRoomState(state: EngineRoomState): void {
  registry.set(state.roomId, state);
}

export function dropRoomState(roomId: string): void {
  registry.delete(roomId);
}

export function registrySize(): number {
  return registry.size;
}
