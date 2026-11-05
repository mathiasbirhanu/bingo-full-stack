"use client";

/**
 * Lobby — the casino floor: live room cards with countdowns, prize pools and
 * one-tap entry. Polls the room list on a slow cycle (low-data: this endpoint
 * is a few hundred bytes; the live action happens inside a room only).
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Users, Ticket, Trophy, Timer, Radio } from "lucide-react";
import { apiGet, etb } from "@/lib/client/api";
import { useApp } from "@/lib/client/store";
import { usePhase, phaseCopy } from "@/lib/phase";
import { ROOM_STATUS_LABEL, type RoomListItem } from "@/lib/client/types";
import { playSfx } from "@/lib/client/sfx";

function Countdown({ target, status }: { target: string; status: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (status !== "SCHEDULED" && status !== "SALES_OPEN") return null;
  const diff = new Date(target).getTime() - now;
  if (diff <= 0) return <span className="tabular-nums text-accent-foreground font-black">starting…</span>;
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  const urgent = diff < 90_000;
  return (
    <span className={`tabular-nums font-black inline-flex items-center gap-1 ${urgent ? "text-accent-foreground" : "text-primary"}`}>
      <Timer className={`w-3.5 h-3.5 ${urgent ? "live-dot" : ""}`} />
      {m}:{s.toString().padStart(2, "0")}
    </span>
  );
}

/** Warm accent themes — no blue, matches the Royale palette. */
const THEMES: CSSProperties[] = [
  { "--rc1": "oklch(0.64 0.19 28)", "--rc2": "oklch(0.48 0.16 32)" } as CSSProperties,   // crimson
  { "--rc1": "oklch(0.8 0.15 88)", "--rc2": "oklch(0.6 0.13 74)" } as CSSProperties,    // gold
  { "--rc1": "oklch(0.64 0.13 155)", "--rc2": "oklch(0.44 0.1 158)" } as CSSProperties, // emerald
  { "--rc1": "oklch(0.62 0.11 50)", "--rc2": "oklch(0.44 0.09 44)" } as CSSProperties,  // bronze
  { "--rc1": "oklch(0.68 0.17 12)", "--rc2": "oklch(0.5 0.14 16)" } as CSSProperties,   // rose
];
function themeFor(id: string): CSSProperties {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return THEMES[h % THEMES.length];
}

function RoomCard({ room, onEnter }: { room: RoomListItem; onEnter: () => void }) {
  const live = room.status === "DRAWING";
  const salesOpen = room.status === "SALES_OPEN";
  const fill = room.maxCards > 0 ? Math.min(100, Math.round((room.tickets / room.maxCards) * 100)) : 0;
  return (
    <article
      style={themeFor(room.id)}
      className={`room-card gold-frame rounded-2xl bg-card/85 p-4 pt-5 space-y-3 ${live ? "room-live ring-1 ring-accent/50" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-black truncate text-base">{room.title}</h3>
          <p className="text-[11px] text-muted-foreground">
            {room.variantId === "BALL_75" ? "75-ball · American" : "90-ball · UK style"}
            {room.tenantId ? " · partner hall" : " · house hall"}
          </p>
        </div>
        {live ? (
          <Badge className="bg-accent text-accent-foreground gap-1.5 font-black">
            <Radio className="w-3 h-3 live-dot" /> LIVE
          </Badge>
        ) : (
          <Badge variant="outline" className={salesOpen ? "border-primary/60 text-primary font-bold" : "text-muted-foreground"}>
            {ROOM_STATUS_LABEL[room.status] ?? room.status}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-background/55 py-1.5">
          <p className="text-[9px] uppercase tracking-widest text-muted-foreground">Card</p>
          <p className="font-black text-primary text-sm">{etb(room.priceSantim)}<span className="text-[9px] font-normal text-muted-foreground"> ETB</span></p>
        </div>
        <div className="rounded-lg bg-background/55 py-1.5">
          <p className="text-[9px] uppercase tracking-widest text-muted-foreground">Players</p>
          <p className="font-bold text-sm inline-flex items-center gap-1"><Users className="w-3 h-3 text-muted-foreground" />{room.players}</p>
        </div>
        <div className="rounded-lg bg-background/55 py-1.5">
          <p className="text-[9px] uppercase tracking-widest text-muted-foreground">In play</p>
          <p className="font-bold text-sm inline-flex items-center gap-1"><Trophy className="w-3 h-3 text-primary" />{room.tickets}</p>
        </div>
      </div>

      {/* seat fill — scarcity you can see */}
      <div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
          <span className="inline-flex items-center gap-1"><Ticket className="w-3 h-3" />{room.tickets} / {room.maxCards} cards</span>
          <span>{fill}% sold</span>
        </div>
        <div className="h-1.5 rounded-full bg-background/70 overflow-hidden">
          <div className="fill-bar h-full rounded-full transition-all duration-700" style={{ width: `${fill}%` }} />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pt-0.5">
        <div className="text-sm text-muted-foreground">
          {live || salesOpen ? (
            <span className="inline-flex items-center gap-1"><Trophy className="w-3.5 h-3.5 text-primary" /><Countdown target={room.scheduledAt} status={room.status} /></span>
          ) : (
            <span>Opens <Countdown target={room.salesOpenAt} status={room.status} /></span>
          )}
        </div>
        <Button
          size="sm"
          className="btn-gold btn-shine btn-juice font-black min-h-10 px-6 tracking-wide"
          onClick={() => { playSfx("tap"); onEnter(); }}
        >
          {live ? "WATCH LIVE" : salesOpen ? "PLAY NOW" : "PREVIEW"}
        </Button>
      </div>
    </article>
  );
}

export function Lobby() {
  const { openRoom, setBalance } = useApp();
  const phase = usePhase();
  const [rooms, setRooms] = useState<RoomListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<RoomListItem[]>("/api/v1/rooms", { retries: 2, timeoutMs: 9000 });
      setRooms(data);
      setError(null);
    } catch {
      setError("The hall is momentarily unreachable — retrying…");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    void apiGet<{ balanceDisplay: string }>("/api/v1/wallet").then((w) => setBalance(w.balanceDisplay)).catch(() => undefined);
    const t = setInterval(load, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, setBalance]);

  const order: Record<string, number> = { DRAWING: 0, SALES_OPEN: 1, LOCKED: 2, SCHEDULED: 3, RESOLVING: 4, COMPLETED: 5, VOIDED: 6 };
  const sorted = rooms ? [...rooms].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()) : null;

  return (
    <div className="space-y-4">
      <div className="marquee gold-frame rounded-xl bg-card/70 py-2" aria-hidden>
        <div className="marquee-track text-xs text-muted-foreground">
          {[0, 1].map((copy) => (
            <span key={copy} className="inline-flex gap-10">
              <span>🎰 {phaseCopy.lobbyBanner(phase)}</span>
              <span>🏆 Winners are paid from the live pool, floor-division exact</span>
              <span>🔐 Every draw is commit-reveal verifiable</span>
              <span>📱 Works on 2G — server-side auto-daub, tiny payloads</span>
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="font-black text-xl gold-text">The Floor</h2>
        <span className="text-xs text-muted-foreground">{rooms ? `${rooms.length} rounds on the board` : "dealing…"}</span>
      </div>

      {error && <p className="text-accent-foreground bg-accent/20 border border-accent/40 rounded-lg px-3 py-2 text-sm">{error}</p>}

      {!sorted && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full rounded-2xl bg-card/60" />)}
        </div>
      )}

      <div className="space-y-3">
        {sorted?.map((room) => <RoomCard key={room.id} room={room} onEnter={() => openRoom(room.id)} />)}
      </div>
    </div>
  );
}
