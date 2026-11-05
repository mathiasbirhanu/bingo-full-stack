"use client";

/**
 * useRoomLive — the low-connectivity live-room hook (ADR-19 client half).
 *
 * Transport strategy, in order of preference:
 *   1. socket.io push (websocket → polling upgrade path built in);
 *   2. on socket failure/gap → REST sequence-addressed catch-up
 *      (?afterSeq=N) and compact polling (default 4 s ± jitter) until the
 *      socket returns;
 *   3. gap larger than the recovery window → full resnapshot (afterSeq=0).
 *
 * The hook merges everything into one deduplicated room-state model:
 * balls (sequence-addressed), awards (per tick, CONFIRMED only), phase.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import { apiGet } from "./api";

export interface RoomEventPayload {
  roomId: string;
  seq?: number;
  ball?: number;
  status?: string;
  ballIntervalMs?: number;
  commitment?: string;
  [k: string]: unknown;
}

export interface AwardRow {
  seq: number;
  label: string;
  winners: Array<[string, string, string?]>; // [alias, amountDisplay, playerId?]
}

export interface LiveRoomState {
  status: string;
  balls: Array<{ seq: number; ball: number }>;
  awards: AwardRow[];
  lastSeq: number;
  nextBallInMs: number | null;
  /** Live caller cadence — follows admin speed changes mid-round. */
  intervalMs: number | null;
  /** Live claim mode — follows admin toggles mid-round. */
  autoClaim: boolean | null;
  /** Deck size (75/90) from the events snapshot — powers the "balls left" chip. */
  ballsTotal: number | null;
  transport: "socket" | "polling" | "connecting";
}

const RECOVERY_GAP = 2048; // mirrors RECOVERY_GAP_LIMIT (UC-05)

export function useRoomLive(roomId: string | null, initialStatus: string): LiveRoomState {
  const [state, setState] = useState<LiveRoomState>({
    status: initialStatus,
    balls: [],
    awards: [],
    lastSeq: 0,
    nextBallInMs: null,
    intervalMs: null,
    autoClaim: null,
    ballsTotal: null,
    transport: "connecting",
  });
  const socketRef = useRef<Socket | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeqRef = useRef(0);
  const seenEvents = useRef<Set<string>>(new Set());

  const mergeBalls = useCallback((incoming: Array<[number, number]>) => {
    setState((s) => {
      if (incoming.length === 0) return s;
      const maxSeq = Math.max(s.lastSeq, ...incoming.map((b) => b[0]));
      const map = new Map(s.balls.map((b) => [b.seq, b.ball]));
      for (const [seq, ball] of incoming) map.set(seq, ball);
      const balls = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([seq, ball]) => ({ seq, ball }));
      return { ...s, balls, lastSeq: maxSeq };
    });
    const maxSeq = incoming.length ? Math.max(...incoming.map((b) => b[0])) : 0;
    if (maxSeq > lastSeqRef.current) lastSeqRef.current = maxSeq;
  }, []);

  const mergeAwards = useCallback((rows: AwardRow[]) => {
    if (rows.length === 0) return;
    setState((s) => {
      // Key by (seq, label): two tiers can complete on the same ball tick.
      const map = new Map(s.awards.map((a) => [`${a.seq}|${a.label}`, a]));
      for (const row of rows) {
        const key = `${row.seq}|${row.label}`;
        const existing = map.get(key);
        map.set(key, existing ? { ...row, winners: [...existing.winners, ...row.winners] } : row);
      }
      return { ...s, awards: [...map.values()].sort((a, b) => a.seq - b.seq) };
    });
  }, []);

  /** Sequence-addressed catch-up — also the polling fallback body. */
  const catchUp = useCallback(
    async (full = false) => {
      if (!roomId) return;
      const after = full ? 0 : lastSeqRef.current;
      try {
        const snap = await apiGet<{
          status: string;
          lastSeq: number;
          balls: Array<[number, number]>;
          awards: AwardRow[];
          nextBallInMs: number | null;
          ballIntervalMs?: number;
          ballsTotal?: number;
        }>(`/api/v1/rooms/${roomId}/events?afterSeq=${after}`, { retries: 1, timeoutMs: 9000 });
        if (full) {
          lastSeqRef.current = 0;
          seenEvents.current.clear();
          setState((s) => ({ ...s, balls: [], awards: [] }));
        }
        mergeBalls(snap.balls);
        mergeAwards(snap.awards);
        setState((s) => ({
          ...s,
          status: snap.status,
          nextBallInMs: snap.nextBallInMs,
          intervalMs: snap.ballIntervalMs ?? s.intervalMs,
          ballsTotal: typeof snap.ballsTotal === "number" ? snap.ballsTotal : s.ballsTotal,
          transport: socketRef.current?.connected ? "socket" : "polling",
        }));
      } catch {
        setState((s) => ({ ...s, transport: "polling" }));
      }
    },
    [roomId, mergeBalls, mergeAwards]
  );

  const schedulePollRef = useRef<() => void>(() => undefined);

  const schedulePoll = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(async () => {
      await catchUp(false);
      if (!socketRef.current?.connected) schedulePollRef.current(); // re-arm via ref (no self-reference)
    }, 4000 + Math.floor(Math.random() * 900)); // jitter avoids thundering herd
  }, [catchUp]);

  useEffect(() => {
    schedulePollRef.current = schedulePoll;
  }, [schedulePoll]);

  useEffect(() => {
    if (!roomId) return;
    let disposed = false;

    // 0. immediate snapshot so the UI paints instantly (cache-friendly).
    // State initialisation happens in useState above; per-room resets come
    // from the consumer remounting this hook with key={roomId}. Deferred so
    // no setState can run synchronously inside the effect body.
    lastSeqRef.current = 0;
    seenEvents.current.clear();
    const first = setTimeout(() => void catchUp(true), 0);

    // 1. socket push channel.
    const socket = io("/?XTransformPort=3003", {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1200,
      reconnectionDelayMax: 6000, // capped backoff — friendly to flaky radios
      timeout: 10_000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      if (disposed) return;
      socket.emit("subscribe", { roomId, lastSeq: lastSeqRef.current });
      setState((s) => ({ ...s, transport: "socket" }));
      // Push channel is up — the safety-net poll can stand down.
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
      // Subscribe raced a live draw? Catch-up closes any gap instantly.
      void catchUp(false);
    });

    const degradeToPolling = () => {
      if (disposed) return;
      setState((s) => (s.transport === "polling" ? s : { ...s, transport: "polling" }));
      schedulePoll(); // degrade gracefully to REST polling
    };

    // The fallback must arm on EVERY failure shape: a socket that never
    // connects fires connect_error (never disconnect), and a mid-session drop
    // fires disconnect. The 5s safety net covers anything else — schedulePoll
    // self-re-arms only while the socket stays down, so 2G radios stay quiet.
    socket.on("disconnect", degradeToPolling);
    socket.on("connect_error", degradeToPolling);
    const safetyNet = setInterval(() => {
      if (!disposed && !socketRef.current?.connected) schedulePollRef.current();
    }, 5_000);

    socket.on("room-event", (evt: { id: string; type: string; payload: RoomEventPayload }) => {
      if (disposed || !evt || evt.payload?.roomId !== roomId) return;
      if (seenEvents.current.has(evt.id)) return; // at-least-once dedupe
      seenEvents.current.add(evt.id);
      if (seenEvents.current.size > 5000) seenEvents.current = new Set([...seenEvents.current].slice(-2500));

      switch (evt.type) {
        case "BALL_CALLED":
          if (typeof evt.payload.seq === "number" && typeof evt.payload.ball === "number") {
            mergeBalls([[evt.payload.seq, evt.payload.ball]]);
          }
          break;
        case "AWARDS_RESOLVED": {
          const winners = (evt.payload.winners as Array<{ playerId: string; award: string }>) ?? [];
          const label = (evt.payload.label as string) ?? "Prize";
          if (winners.length > 0) {
            mergeAwards([
              {
                seq: evt.payload.seq ?? 0,
                label,
                winners: winners.map((w) => [
                  `Player ${w.playerId.slice(-4).toUpperCase()}`,
                  formatEtb(w.award),
                  w.playerId,
                ]),
              },
            ]);
          }
          break;
        }
        case "ROOM_PHASE":
        case "ROUND_COMPLETED":
        case "ROUND_VOIDED":
          setState((s) => ({
            ...s,
            status: (evt.payload.status as string) ?? (evt.type === "ROUND_COMPLETED" ? "COMPLETED" : evt.type === "ROUND_VOIDED" ? "VOIDED" : s.status),
            // Admin cadence/claim-mode changes ride ROOM_PHASE live.
            intervalMs: typeof evt.payload.ballIntervalMs === "number" ? evt.payload.ballIntervalMs : s.intervalMs,
            autoClaim: typeof evt.payload.autoClaim === "boolean" ? evt.payload.autoClaim : s.autoClaim,
          }));
          break;
      }
    });

    return () => {
      disposed = true;
      clearTimeout(first);
      clearInterval(safetyNet);
      if (pollTimer.current) clearTimeout(pollTimer.current);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, initialStatus, catchUp, mergeAwards, mergeBalls, schedulePoll]);

  return state;
}

function formatEtb(santim: string): string {
  const n = Number(santim);
  const whole = Math.floor(Math.abs(n) / 100);
  const frac = (Math.abs(n) % 100).toString().padStart(2, "0");
  return `${whole.toLocaleString("en-US")}.${frac}`;
}
