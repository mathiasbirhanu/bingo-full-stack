/**
 * room-events relay — the demo-phase event fan-out (Architecture ch. 4.2,
 * ADR-19). The Next.js game engine writes sequence-addressed events to the
 * transactional outbox (ADR-03); this relay tails the outbox and pushes each
 * published row to the room's subscriber set.
 *
 * Guarantees:
 *  · at-least-once from the relay's viewpoint; the client dedupes by event id
 *    and recovers gaps via the REST catch-up endpoint (sequence-addressed).
 *  · read-only against SQLite (bun:sqlite, WAL) — the system of record is
 *    never mutated here.
 *  · no monetary state is held in memory (AP-04 discipline).
 *
 * Transport contract (sandbox gateway): the browser connects with
 * io("/?XTransformPort=3003") and Caddy forwards to this port.
 */
import { Server } from "socket.io";
import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.RELAY_PORT ?? 3003);

// db/custom.db lives at the repo root: mini-services/room-events → up two.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const db = new Database(join(root, "db", "custom.db"), { readonly: true, create: false });
db.exec("PRAGMA busy_timeout = 3000;");

const io = new Server({
  cors: { origin: true, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

const BROADCAST_TYPES = new Set([
  "BALL_CALLED",
  "AWARDS_RESOLVED",
  "ROOM_PHASE",
  "ROUND_COMPLETED",
  "ROUND_VOIDED",
]);

let lastId = 0n;
{
  // Start from "now" — fresh connections backfill history via REST catch-up.
  const row = db
    .query("SELECT COALESCE(MAX(id), 0) AS m FROM OutboxEvent WHERE publishedAt IS NOT NULL")
    .get() as { m: number | bigint };
  lastId = BigInt(row.m);
  console.log(`[relay] tailing outbox from id ${lastId}`);
}

// ── socket API ───────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let joined: string | null = null;

  socket.on("subscribe", ({ roomId, lastSeq }: { roomId: string; lastSeq?: number }) => {
    if (!roomId || typeof roomId !== "string") return;
    if (joined) socket.leave(`room:${joined}`);
    joined = roomId;
    socket.join(`room:${roomId}`);
    // Small immediate ack with the server view; authoritative gap-filling is
    // the REST catch-up (?afterSeq=) which this ack also advises.
    socket.emit("subscribed", { roomId, lastSeq: lastSeq ?? 0, adviseCatchup: true });
    console.log(`[relay] ${socket.id} → room:${roomId} (lastSeq ${lastSeq ?? 0})`);
  });

  socket.on("unsubscribe", ({ roomId }: { roomId: string }) => {
    if (roomId) socket.leave(`room:${roomId}`);
    if (joined === roomId) joined = null;
  });

  socket.on("disconnect", () => {
    if (joined) socket.leave(`room:${joined}`);
  });
});

// ── outbox tail ──────────────────────────────────────────────────────────────
const poll = () => {
  try {
    const rows = db
      .query(
        `SELECT id, type, aggregateId, payloadJson, createdAt
           FROM OutboxEvent
          WHERE id > ? AND publishedAt IS NOT NULL
          ORDER BY id ASC
          LIMIT 200`
      )
      .all(lastId.toString()) as Array<{ id: number | bigint; type: string; aggregateId: string; payloadJson: string; createdAt: string }>;

    for (const r of rows) {
      lastId = BigInt(r.id);
      if (!BROADCAST_TYPES.has(r.type)) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(r.payloadJson);
      } catch {
        continue;
      }
      io.to(`room:${r.aggregateId}`).emit("room-event", {
        id: r.id.toString(),
        type: r.type,
        roomId: r.aggregateId,
        at: r.createdAt,
        payload,
      });
    }
  } catch (err) {
    console.error("[relay] tail error:", err);
  }
};
setInterval(poll, 700);
poll();

io.listen(PORT);
console.log(`[relay] room-events relay listening on :${PORT}`);
