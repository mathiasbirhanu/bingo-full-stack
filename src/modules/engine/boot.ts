/**
 * Engine boot — the game-gateway heartbeat. A 1-second process-level loop
 * drives every live room exactly one grain turn per tick (ADR-01), plus the
 * rolling demo-room scheduler every 30 s so the lobby never runs dry.
 *
 * Booted from src/instrumentation.ts on the nodejs runtime; the globalThis
 * guard makes hot-reload double-boot impossible. A re-entrancy flag keeps
 * turns non-overlapping even when a slow tick exceeds the interval.
 */
import { db } from "../../lib/db";
import { ensureRollingRooms } from "../rooms/queries";
import { transitionSalesOpen, transitionLock, transitionDrawing } from "./lifecycle";
import { tickDrawing } from "./tick";
import { finishRoom } from "./finish";
import { registrySize } from "./state";

const TICK_MS = 1_000;
const SCHEDULER_EVERY_MS = 30_000;

interface EngineGlobals {
  booted?: boolean;
  ticking?: boolean;
  lastTickAt?: number;
  lastTickMs?: number;
  lastError?: string;
  ticks?: number;
}

const g = globalThis as unknown as { __bingoEngine?: EngineGlobals };

function state(): EngineGlobals {
  if (!g.__bingoEngine) g.__bingoEngine = { booted: false, ticks: 0 };
  return g.__bingoEngine;
}

export function bootEngine(): void {
  const s = state();
  if (s.booted) return;
  s.booted = true;
  console.log("[engine] game engine booted — 1s grain turns, rolling scheduler 30s");

  const timer = setInterval(() => {
    void runTurn();
  }, TICK_MS);
  // Never hold the process open on its own account.
  timer.unref?.();
}

async function runTurn(): Promise<void> {
  const s = state();
  if (s.ticking) return; // non-reentrant grain turns
  s.ticking = true;
  const started = Date.now();
  try {
    await tickAll();
    s.ticks = (s.ticks ?? 0) + 1;
    s.lastTickAt = started;
    s.lastTickMs = Date.now() - started;
    s.lastError = undefined;
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : String(err);
    console.error("[engine] turn failed:", err);
  } finally {
    s.ticking = false;
  }
}

/** One process tick: every live room gets at most one sequential turn. */
export async function tickAll(): Promise<void> {
  const rooms = await db.room.findMany({
    where: { status: { in: ["SCHEDULED", "SALES_OPEN", "LOCKED", "DRAWING", "RESOLVING"] } },
    orderBy: { scheduledAt: "asc" },
  });

  for (const room of rooms) {
    try {
      switch (room.status) {
        case "SCHEDULED":
          if (Date.now() >= room.salesOpenAt.getTime()) await transitionSalesOpen(room);
          break;
        case "SALES_OPEN":
          if (Date.now() >= room.salesCloseAt.getTime()) await transitionLock(room);
          break;
        case "LOCKED":
          if (Date.now() >= room.scheduledAt.getTime()) await transitionDrawing(room);
          break;
        case "DRAWING":
          await tickDrawing(room);
          break;
        case "RESOLVING":
          await finishRoom(room.id); // crash-safe: every step idempotent
          break;
      }
    } catch (err) {
      console.error(`[engine] room ${room.id} (${room.title}) turn failed:`, err);
    }
  }

  await maybeRunScheduler();
}

let lastSchedulerRun = 0;
async function maybeRunScheduler(): Promise<void> {
  const now = Date.now();
  if (now - lastSchedulerRun < SCHEDULER_EVERY_MS) return;
  lastSchedulerRun = now;
  try {
    const created = await ensureRollingRooms(3);
    if (created.length > 0) console.log(`[engine] scheduler created ${created.length} room(s)`);
  } catch (err) {
    console.error("[engine] scheduler failed:", err);
  }
}

/** Health/introspection payload for the ops console. */
export function engineStatus(): {
  booted: boolean;
  ticking: boolean;
  cachedRooms: number;
  ticks: number;
  lastTickAt: string | null;
  lastTickMs: number | null;
  lastError: string | null;
} {
  const s = state();
  return {
    booted: s.booted ?? false,
    ticking: s.ticking ?? false,
    cachedRooms: registrySize(),
    ticks: s.ticks ?? 0,
    lastTickAt: s.lastTickAt ? new Date(s.lastTickAt).toISOString() : null,
    lastTickMs: s.lastTickMs ?? null,
    lastError: s.lastError ?? null,
  };
}
