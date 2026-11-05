"use client";

/**
 * RoomView — the live round, TV-show grade (Bingo-Blitz benchmark):
 *   · caller panel — spinning drum, popping ball, depleting countdown ring,
 *     and the FULL CALLED BOARD side by side with your cards (75-ball: the
 *     classic B-I-N-G-O rows; 90-ball: the 9×10 chart) — everything called
 *     lights up the moment it pops;
 *   · manual play (ADR-20 rooms with autoClaim=false): the card does NOT
 *     touch itself — the player taps each called number, invalid taps buzz
 *     and shake, and when a pattern completes the BINGO! button arms; the
 *     server re-validates every claim against the called set (honest);
 *   · AUTO toggle — one tap back to auto-daub for 2G players who prefer it;
 *   · "n TO GO!" banner — honest by construction: pure card geometry (best
 *     horizontal line across my tickets), never claims the engine's patterns;
 *   · BIG WIN splash — gold title, coin shower, confetti (ADR-16: PROVISIONAL
 *     still shows "checking"; CONFIRMED celebrates) — deduped across the
 *     claim response and the live awards feed (one splash per prize);
 *   · PatternGuide popup — the round's actual patterns as dot diagrams;
 *   · live prize table (FR-PLY-02), fairness chip → commitment → reveal.
 * Transport: useRoomLive (socket push → REST sequence catch-up fallback).
 * Sounds: WebAudio synth (zero assets) — ball, daub, error buzz, win fanfare.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import {
  Trophy, ShieldCheck, Loader2, ChevronLeft, Lock, Wifi, WifiOff, PartyPopper, Info, Zap, Hand, Sparkles,
  Clock, Users, Ticket, Coins, Gauge, CircleDot,
} from "lucide-react";
import { apiGet, apiPost, etb, newIdempotencyKey, ApiClientError } from "@/lib/client/api";
import { useApp } from "@/lib/client/store";
import { useRoomLive } from "@/lib/client/useRoomLive";
import { ROOM_STATUS_LABEL, ballClass, type RoomDetail } from "@/lib/client/types";
import { isPatternComplete } from "@/modules/game-core/patterns";
import { playSfx } from "@/lib/client/sfx";
import { BingoCard } from "./BingoCard";
import { PatternGuide } from "./PatternGuide";
import { PatternStrip } from "./PatternStrip";

/** Elapsed seconds since the round started — ticks only while drawing. */
function useElapsed(fromIso: string | null, active: boolean): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active || !fromIso) return;
    const tick = () => setSec(Math.max(0, Math.floor((Date.now() - new Date(fromIso).getTime()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [fromIso, active]);
  return sec;
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * RoundInfoBar — the admin-determined round facts, live (FR-PLY-01):
 * start time + running clock, players in the round, card price, caller
 * speed, balls called/left and the growing prize pool. Every number here is
 * owner-tuned (price/speed in the console) or engine-truth — no local maths.
 */
function RoundInfoBar({
  detail,
  intervalMs,
  calledCount,
  ballsTotal,
  drawing,
}: {
  detail: RoomDetail;
  intervalMs: number;
  calledCount: number;
  ballsTotal: number | null;
  drawing: boolean;
}) {
  const started = drawing || detail.status === "RESOLVING" || detail.status === "COMPLETED";
  const startLabel = new Date(detail.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const elapsed = useElapsed(started ? detail.scheduledAt : null, drawing);
  const total = ballsTotal ?? null;
  const left = total !== null ? Math.max(0, total - calledCount) : null;

  const chips: Array<{ icon: ReactNode; label: string; value: string; hue: string }> = [
    { icon: <Clock className="w-3.5 h-3.5" />, label: started ? "Started" : "Starts", value: drawing ? `${startLabel} · ${fmtClock(elapsed)}` : startLabel, hue: "oklch(0.78 0.15 200)" },
    { icon: <Users className="w-3.5 h-3.5" />, label: "Players", value: String(detail.players), hue: "oklch(0.78 0.17 155)" },
    { icon: <Ticket className="w-3.5 h-3.5" />, label: "Card", value: `${etb(detail.priceSantim)} ETB`, hue: "oklch(0.84 0.17 88)" },
    { icon: <Gauge className="w-3.5 h-3.5" />, label: "Speed", value: `${(intervalMs / 1000).toFixed(1)}s/ball`, hue: "oklch(0.72 0.19 35)" },
    {
      icon: <CircleDot className="w-3.5 h-3.5" />,
      label: total !== null ? "Balls" : "Called",
      value: total !== null ? (drawing ? `${calledCount}/${total} · ${left} left` : `${calledCount}/${total}`) : String(calledCount),
      hue: "oklch(0.72 0.19 320)",
    },
    { icon: <Coins className="w-3.5 h-3.5" />, label: "Prize pool", value: `${etb(detail.netPoolSantim)} ETB`, hue: "oklch(0.8 0.14 70)" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5" role="group" aria-label="Round information">
      {chips.map((c) => (
        <div
          key={c.label}
          className="info-chip rounded-xl px-2.5 py-1.5 flex items-center gap-2 min-w-0"
          style={{ "--ic": c.hue } as CSSProperties}
        >
          <span className="text-[--ic] flex-none" style={{ color: c.hue }}>{c.icon}</span>
          <span className="min-w-0">
            <span className="block text-[9px] uppercase tracking-wider text-muted-foreground font-bold leading-none">{c.label}</span>
            <span className="block text-[12px] font-black tabular-nums truncate leading-tight" style={{ color: c.hue }}>{c.value}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function BallStage({
  balls,
  nextBallInMs,
  intervalMs,
  status,
  toGo,
  hasTickets,
}: {
  balls: Array<{ seq: number; ball: number }>;
  nextBallInMs: number | null;
  intervalMs: number;
  status: string;
  toGo: number;
  hasTickets: boolean;
}) {
  const last = balls[balls.length - 1] ?? null;
  const prev = balls.slice(-5, -1).reverse(); // exactly 4 ghosts — history lives in the admin console
  // Countdown as derived state: a deadline memo (recomputed only when the
  // server cadence changes) minus a 100ms clock — no sync setState effects.
  const deadline = useMemo(() => (nextBallInMs === null ? null : Date.now() + nextBallInMs), [nextBallInMs]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== "DRAWING") return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [status]);
  const eta = deadline === null ? null : Math.max(0, deadline - now);

  // Depleting ring: full at the start of the interval, empty at the pop.
  const R = 84;
  const C = 2 * Math.PI * R;
  const progress = status === "DRAWING" && eta !== null ? Math.min(1, Math.max(0, eta / Math.max(1, intervalMs))) : 0;
  const drawing = status === "DRAWING";

  return (
    <section className="gold-frame rounded-2xl bg-card/85 p-3 space-y-2.5">
      {/* Drum + live strip — side by side */}
      <div className="flex items-center gap-3">
        <div className="relative w-28 h-28 flex-none" role="img" aria-label={last ? `Last ball: ${last.ball}` : "Waiting for the first ball"}>
          <svg viewBox="0 0 200 200" className="absolute inset-0 w-full h-full -rotate-90" aria-hidden>
            <circle cx="100" cy="100" r={R} fill="none" stroke="oklch(1 0 0 / 7%)" strokeWidth="10" />
            <circle
              cx="100" cy="100" r={R} fill="none" stroke="var(--gold)" strokeWidth="10" strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={C * (1 - progress)}
              style={{ transition: "stroke-dashoffset 0.12s linear", filter: "drop-shadow(0 0 6px oklch(0.8 0.15 88 / 60%))" }}
            />
          </svg>
          <div aria-hidden className="stage-ring absolute inset-[9px] rounded-full" />
          <div className="absolute inset-0 grid place-items-center">
            {last ? (
              <span key={last.seq} className={`ball-stage ball-sphere ${ballClass(last.ball)} w-[4.5rem] h-[4.5rem] text-4xl ${drawing ? "ball-pop" : ""}`}>
                {last.ball}
              </span>
            ) : (
              <span className="ball-stage w-16 h-16 rounded-full grid place-items-center text-center px-2">
                <span className="text-[8px] uppercase tracking-widest text-primary/80 font-bold">
                  {status === "SALES_OPEN" ? "buy & wait" : "…"}
                </span>
              </span>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Badge className={drawing ? "bg-accent text-accent-foreground gap-1.5 font-black" : "bg-secondary text-secondary-foreground"}>
              {drawing && <span className="live-dot inline-block w-1.5 h-1.5 rounded-full bg-white" />}
              {ROOM_STATUS_LABEL[status] ?? status}
            </Badge>
            {drawing && (
              <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                {eta !== null && eta <= 0 ? "popping now…" : `next in ${((eta ?? intervalMs) / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>

          {/* One ball at a time — the four before it as fading ghosts. The
              full called list and the draw order live in the admin console. */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {prev.map((b, i) => (
              <span
                key={b.seq}
                className={`ball-sphere ${ballClass(b.ball)} w-8 h-8 text-xs ${drawing ? "ball-pop" : ""}`}
                style={{ opacity: 1 - i * 0.22, ...(drawing ? { animationDelay: `${(prev.length - i) * 0.04}s` } : {}) }}
              >
                {b.ball}
              </span>
            ))}
            {prev.length === 0 && <span className="text-[11px] text-muted-foreground">the drum is warming up…</span>}
          </div>

          {/* n TO GO — honest geometry: best horizontal line across my tickets */}
          {drawing && hasTickets && toGo >= 1 && toGo <= 3 && (
            <div className={`to-go rounded-lg text-center py-1.5 font-black tracking-wide ${toGo === 1 ? "text-base" : "text-sm"}`} role="status" aria-live="polite">
              {toGo === 1 ? "⚡ 1 TO GO — BEST LINE!" : `${toGo} TO GO · BEST LINE`}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function RoomView({ roomId, onBack }: { roomId: string; onBack: () => void }) {
  const { user, setBalance } = useApp();
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [reveal, setReveal] = useState<{ commitment: string; serverSeed: string; salt: string; clientSeedContribution: string } | null>(null);
  const [buying, setBuying] = useState(false);
  const [quantity, setQuantity] = useState(1);

  const load = useCallback(async () => {
    try {
      const d = await apiGet<RoomDetail>(`/api/v1/rooms/${roomId}`, { retries: 2 });
      setDetail(d);
    } catch {
      /* room list refresh will recover; keep the last view */
    }
  }, [roomId]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(load, 8_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const live = useRoomLive(roomId, detail?.status ?? "SCHEDULED");
  const calledSet = useMemo(() => new Set(live.balls.map((b) => b.ball)), [live.balls]);
  const lastBall = live.balls.length ? live.balls[live.balls.length - 1] : null;

  const manual = detail ? !detail.autoClaim : false; // manual = tap + BINGO!
  const [guideOpen, setGuideOpen] = useState(false);

  // ---------------------------------------------------------------- daub mode
  // null = not chosen yet → follow the hall's mode (manual halls start manual).
  const [daubMode, setDaubMode] = useState<"auto" | "manual" | null>(null);
  useEffect(() => {
    try {
      const pref = localStorage.getItem("bingo.daub");
      if (pref === "auto" || pref === "manual") setDaubMode(pref);
    } catch {
      /* private mode — session default */
    }
  }, []);
  const autoDaub = daubMode === null ? detail ? detail.autoClaim : true : daubMode === "auto";
  const chooseDaubMode = (mode: "auto" | "manual") => {
    setDaubMode(mode);
    try {
      localStorage.setItem("bingo.daub", mode);
    } catch {
      /* session-only */
    }
    playSfx("tap");
  };

  // My daubs — the ball numbers I tapped (manual) or the server caught up for
  // me (auto). On reconnect the already-called numbers are marked instantly
  // (fair catch-up); only live balls demand taps.
  const [daubed, setDaubed] = useState<Set<number>>(new Set());
  const caughtUpRef = useRef(false);
  useEffect(() => {
    setDaubed(new Set());
    caughtUpRef.current = false;
  }, [roomId]);
  useEffect(() => {
    if (autoDaub) {
      caughtUpRef.current = false;
      setDaubed(calledSet);
      return;
    }
    if (!caughtUpRef.current) {
      caughtUpRef.current = true;
      setDaubed(calledSet);
    }
  }, [autoDaub, calledSet]);

  const [freshTap, setFreshTap] = useState<number | null>(null);
  const [shake, setShake] = useState<{ n: number; k: number } | null>(null);
  const tapCell = (n: number) => {
    if (daubed.has(n)) return;
    if (calledSet.has(n)) {
      const next = new Set(daubed);
      next.add(n);
      setDaubed(next);
      setFreshTap(n);
      playSfx("daub");
    } else {
      playSfx("error");
      setShake((s) => ({ n, k: (s?.k ?? 0) + 1 }));
    }
  };

  const markedSet = autoDaub ? calledSet : daubed;
  const freshBall = autoDaub ? (lastBall?.ball ?? null) : freshTap;

  // My confirmed wins in this room — award winners carry the player id on
  // both transports (REST catch-up + socket), so ownership is client-side.
  const myWins = live.awards.filter((a) => a.winners.some((w) => w[2] === user?.id));
  const anyWin = live.awards.length > 0;

  // Ball pop sound — fires once per new ball (seq-guarded). The auto-daub hit
  // sound only rings in auto mode; manual players hear it from their own taps.
  const prevSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (lastBall && lastBall.seq !== prevSeqRef.current) {
      prevSeqRef.current = lastBall.seq;
      playSfx("ball");
      if (autoDaub) {
        const mine = detail?.myTickets.some((t) => t.numbers.some((row) => row.some((n) => n === lastBall.ball)));
        if (mine) {
          const t = setTimeout(() => playSfx("daub"), 260);
          return () => clearTimeout(t);
        }
      }
    }
  }, [lastBall, detail, autoDaub]);

  // Honest "best line" to-go: remaining cells on the closest horizontal row
  // across all my tickets (pure geometry — does not guess tenant patterns).
  const toGo = useMemo(() => {
    let best = Infinity;
    for (const t of detail?.myTickets ?? []) {
      for (const row of t.numbers) {
        const need = row.filter((n) => n !== null && !calledSet.has(n)).length;
        if (need < best) best = need;
      }
    }
    return best;
  }, [detail?.myTickets, calledSet]);

  // ------------------------------------------------------------- BINGO! claim
  const canBingo = useMemo(() => {
    if (!manual || !detail || !markedSet || markedSet.size === 0) return false;
    if (live.status !== "DRAWING") return false;
    for (const t of detail.myTickets) {
      for (const p of detail.patterns) {
        if (isPatternComplete(detail.variantId, t.numbers, markedSet, p.payload).complete) return true;
      }
    }
    return false;
  }, [manual, detail, markedSet, live.status]);

  const wasReadyRef = useRef(false);
  useEffect(() => {
    if (canBingo && !wasReadyRef.current) playSfx("ready");
    wasReadyRef.current = canBingo;
  }, [canBingo]);

  // One splash per prize — the claim response and the live awards feed can
  // both announce the same tier; the key set keeps the TV moment singular.
  const splashedKeys = useRef<Set<string>>(new Set());
  const [wonFlash, setWonFlash] = useState<string | null>(null);
  const [splash, setSplash] = useState<{ label: string; amount: string; seed: number } | null>(null);

  const showSplash = useCallback(
    (label: string, amount: string, key: string) => {
      if (splashedKeys.current.has(key)) return;
      splashedKeys.current.add(key);
      setWonFlash(`${label} — ${amount} ETB`);
      setSplash((prev) => ({ label, amount, seed: (prev?.seed ?? 0) + 1 }));
      playSfx("win");
      // Prize landed — refresh the balance chip immediately (money truth).
      void apiGet<{ balanceDisplay: string }>("/api/v1/wallet", { retries: 1 })
        .then((w) => setBalance(w.balanceDisplay))
        .catch(() => undefined);
    },
    [setBalance]
  );

  useEffect(() => {
    for (const a of myWins) {
      const key = `${a.seq}|${a.label}`;
      if (splashedKeys.current.has(key)) continue;
      const mine = a.winners.find((w) => w[2] === user?.id);
      showSplash(a.label, mine?.[1] ?? a.winners[0]?.[1] ?? "0", key);
    }
  }, [myWins, user?.id, showSplash]);

  const [claiming, setClaiming] = useState(false);
  const claim = async () => {
    if (claiming) return;
    setClaiming(true);
    playSfx("tap");
    try {
      const res = await apiPost<{ claimed: boolean; reason?: string; message?: string; label?: string; eachSantim?: string; ballSeq?: number }>(
        `/api/v1/rooms/${roomId}/claim`,
        {}
      );
      if (res.claimed) {
        showSplash(res.label ?? "BINGO!", etb(res.eachSantim ?? "0"), `${res.ballSeq ?? 0}|${res.label ?? "BINGO!"}`);
        toast({ title: "BINGO! confirmed 🎉", description: `${res.label} — prize credited instantly.` });
      } else {
        playSfx("error");
        toast({
          title: res.reason === "NOT_YET" ? "Not yet!" : (res.reason ?? "NOT_YET"),
          description: res.message ?? "Keep tapping the called numbers on your card.",
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({
        title: err instanceof ApiClientError ? err.code : "Claim failed",
        description: err instanceof ApiClientError ? err.message : "Try again",
        variant: "destructive",
      });
    } finally {
      setClaiming(false);
    }
  };

  // Coin/confetti positions — deterministic per splash (no re-render jitter).
  const splashFx = useMemo(() => {
    if (!splash) return null;
    const seed = splash.seed * 7919;
    const rand = (i: number, m: number) => (((seed + i * 2654435761) % 1000) / 1000) * m;
    return {
      coins: Array.from({ length: 14 }, (_, i) => ({
        left: rand(i, 96),
        delay: rand(i + 40, 0.5),
        dur: 1.6 + rand(i + 80, 0.6),
      })),
      confetti: Array.from({ length: 18 }, (_, i) => ({
        left: rand(i + 120, 98),
        delay: rand(i + 160, 0.6),
        color: ["#F5C542", "#E4572E", "#7FB069", "#FFF8E7"][i % 4],
      })),
    };
  }, [splash]);

  useEffect(() => {
    if (!splash) return;
    const t = setTimeout(() => setSplash(null), 4200);
    return () => clearTimeout(t);
  }, [splash]);

  useEffect(() => {
    if (detail && (detail.status === "COMPLETED" || detail.status === "RESOLVING")) {
      void apiGet<{ commitment: string; reveal: { serverSeed: string; salt: string; clientSeedContribution: string } | null }>(
        `/api/v1/fairness/${roomId}`
      )
        .then((d) => d.reveal && setReveal({ commitment: d.commitment, ...d.reveal }))
        .catch(() => undefined);
    }
  }, [detail?.status, roomId]);

  const buy = async () => {
    setBuying(true);
    try {
      const res = await apiPost<{ replayed: boolean; newBalanceSantim: string; cards: unknown[] }>(`/api/v1/rooms/${roomId}/purchase`, {
        quantity,
        idempotencyKey: newIdempotencyKey("buy"),
      });
      setBalance(etb(res.newBalanceSantim));
      playSfx("coin");
      toast({ title: res.replayed ? "Purchase already confirmed" : `${quantity} card${quantity > 1 ? "s" : ""} confirmed!`, description: "Good luck in there 🍀" });
      await load();
    } catch (err) {
      if (err instanceof ApiClientError) {
        const copy: Record<string, string> = {
          INSUFFICIENT_FUNDS: "Not enough balance — top up in the wallet.",
          MAX_CARDS_REACHED: "You reached the card limit for this round.",
          SALES_CLOSED: "Sales just closed — the round is starting.",
        };
        toast({ title: err.code, description: copy[err.code] ?? err.message, variant: "destructive" });
      }
    } finally {
      setBuying(false);
    }
  };

  if (!detail) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}><ChevronLeft className="w-4 h-4" /> Lobby</Button>
        <Skeleton className="h-44 w-full rounded-2xl bg-card/60" />
        <Skeleton className="h-64 w-full rounded-2xl bg-card/60" />
      </div>
    );
  }

  const salesOpen = detail.status === "SALES_OPEN";
  const finished = detail.status === "COMPLETED" || detail.status === "VOIDED";
  const intervalMs = live.intervalMs ?? detail.ballIntervalMs;

  return (
    <div className="space-y-3">
      {/* BIG WIN splash — the TV moment */}
      {splash && splashFx && (
        <div className="fixed inset-0 z-50 pointer-events-none grid place-items-center" role="status" aria-live="assertive">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] win-fade" />
          <div aria-hidden className="absolute inset-0 overflow-hidden">
            {splashFx.coins.map((c, i) => (
              <span key={`coin-${i}`} className="coin" style={{ left: `${c.left}%`, animationDelay: `${c.delay}s`, animationDuration: `${c.dur}s` }} />
            ))}
            {splashFx.confetti.map((p, i) => (
              <span key={`conf-${i}`} className="confetti-piece" style={{ left: `${p.left}%`, animationDelay: `${p.delay}s`, background: p.color }} />
            ))}
          </div>
          <div className="win-splash relative text-center px-8">
            <p className="win-title text-6xl font-black tracking-tight">BIG WIN!</p>
            <p className="mt-2 text-lg font-bold text-primary">{splash.label}</p>
            <p className="text-5xl font-black gold-text tabular-nums">+{splash.amount}<span className="text-xl"> ETB</span></p>
            <p className="text-xs text-muted-foreground mt-2">credited instantly to your wallet</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}><ChevronLeft className="w-4 h-4" /> Lobby</Button>
        <span className={`inline-flex items-center gap-1 text-[11px] ${live.transport === "socket" ? "text-emerald-500" : "text-muted-foreground"}`}>
          {live.transport === "socket" ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          {live.transport === "socket" ? "live push" : live.transport === "polling" ? "data-saver sync" : "connecting"}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <h2 className="font-black text-lg gold-text truncate">{detail.title}</h2>
        <span className="text-xs text-muted-foreground whitespace-nowrap">{etb(detail.priceSantim)} ETB / card</span>
      </div>

      {/* Round facts — start time, players, price, speed, balls, pool (owner-set) */}
      <RoundInfoBar
        detail={detail}
        intervalMs={intervalMs}
        calledCount={live.balls.length}
        ballsTotal={live.ballsTotal}
        drawing={live.status === "DRAWING"}
      />

      {/* The winning patterns — always visible ABOVE the caller, fade when won */}
      <PatternStrip
        variantId={detail.variantId}
        patterns={detail.patterns}
        prizeTable={detail.prizeTable}
        awards={live.awards}
        status={live.status}
      />

      <BallStage
        balls={live.balls}
        nextBallInMs={live.nextBallInMs}
        intervalMs={intervalMs}
        status={live.status}
        toGo={toGo}
        hasTickets={detail.myTickets.length > 0}
      />

      {/* Win banner (ADR-16: PROVISIONAL shows as "checking"; CONFIRMED celebrates) */}
      {wonFlash && (
        <div className="rounded-xl border border-primary/60 bg-primary/15 px-4 py-3 flex items-center gap-2 pulse-gold" role="status">
          <PartyPopper className="w-5 h-5 text-primary flex-none" />
          <p className="text-sm font-bold text-primary">Winner! {wonFlash} — credited instantly.</p>
        </div>
      )}

      {/* My cards — the playing area: cards sit right under the caller board */}
      {detail.myTickets.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-bold">
              My cards ({detail.myTickets.length}){" "}
              <span className="font-normal text-muted-foreground">
                — {autoDaub ? "auto-daubed for you" : "tap the called numbers!"}
              </span>
            </h3>
            {manual && live.status === "DRAWING" && !autoDaub && (
              <span className="text-[10px] font-bold text-accent-foreground bg-accent/20 border border-accent/50 rounded-full px-2 py-0.5">MANUAL</span>
            )}
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {detail.myTickets.map((t) => (
              <BingoCard
                key={t.ticketId}
                cells={t.numbers}
                variantId={detail.variantId}
                marked={markedSet}
                freshBall={freshBall}
                interactive={manual && !autoDaub && live.status === "DRAWING"}
                onTapCell={tapCell}
                shake={shake}
              />
            ))}
          </div>
        </section>
      )}

      {/* Purchase bar */}
      {salesOpen && user && (
        <section className="gold-frame rounded-2xl bg-card/85 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold">Buy cards <span className="text-muted-foreground font-normal">(max {detail.maxCards})</span></h3>
            <span className="text-xs text-muted-foreground">You hold {detail.myTickets.length}</span>
          </div>
          <div className="flex gap-2">
            {[1, 2, 4, 6].filter((q) => detail.myTickets.length + q <= detail.maxCards).map((q) => (
              <button
                key={q}
                onClick={() => { setQuantity(q); playSfx("tap"); }}
                aria-pressed={quantity === q}
                className={`flex-1 min-h-10 rounded-lg text-sm font-black border transition-colors btn-juice ${quantity === q ? "border-primary bg-primary/20 text-primary" : "border-border bg-background/40 hover:border-primary/50"}`}
              >
                ×{q}
              </button>
            ))}
          </div>
          <Button className="btn-gold btn-shine btn-juice w-full font-black min-h-12 text-base" disabled={buying || detail.myTickets.length >= detail.maxCards} onClick={buy}>
            {buying ? <Loader2 className="w-4 h-4 animate-spin" /> : `Buy ${quantity} for ${etb(String(Number(detail.priceSantim) * quantity))} ETB`}
          </Button>
        </section>
      )}
      {salesOpen && !user && <p className="text-center text-sm text-muted-foreground">Sign in from the lobby to buy cards.</p>}

      {/* Prize table */}
      <section className="gold-frame rounded-2xl bg-card/85 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold inline-flex items-center gap-1.5"><Trophy className="w-4 h-4 text-primary" /> Prize table — live pool</h3>
          <button
            className="inline-flex items-center gap-1 text-[11px] font-bold text-primary border border-primary/40 rounded-full px-2.5 py-1 btn-juice"
            onClick={() => { playSfx("tap"); setGuideOpen(true); }}
          >
            <Sparkles className="w-3 h-3" /> How to win
          </button>
        </div>
        <div className="space-y-1.5">
          {detail.prizeTable.map((row) => {
            const paidRow = live.awards.find((a) => a.label === row.patternLabel);
            return (
              <div key={row.patternId} className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${paidRow ? "bg-primary/10 line-through decoration-primary/60" : "bg-background/40"}`}>
                <span className="font-semibold">{row.patternLabel}</span>
                {/* Paid tiers freeze at the amount actually awarded; open tiers
                    track the live pool (FR-PLY-02). */}
                <span className={`font-bold tabular-nums ${paidRow ? "text-primary" : ""}`}>
                  {paidRow ? paidRow.winners.map((w) => w[1]).join(" / ") : etb(row.tierSantim)}
                  <span className="text-[10px] font-normal text-muted-foreground"> ETB</span>
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">Pool grows with every confirmed sale. Simultaneous winners split the tier evenly; the floor remainder stays in the round.</p>
      </section>

      {/* Winners feed */}
      {anyWin && (
        <section className="gold-frame rounded-2xl bg-card/85 p-4 space-y-2">
          <h3 className="text-sm font-bold">Winners this round</h3>
          <div className="luxe-scroll max-h-40 overflow-y-auto space-y-1.5 pr-1">
            {[...live.awards].reverse().map((a) => (
              <div key={`${a.seq}|${a.label}`} className="flex items-center justify-between rounded-lg bg-background/40 px-3 py-2 text-sm">
                <span className="font-semibold text-primary">{a.label}</span>
                <span className="text-xs text-muted-foreground">
                  ball #{live.balls.find((b) => b.seq === a.seq)?.ball ?? a.seq} ·{" "}
                  {a.winners.map((w) => `${w[0]} +${w[1]}`).join(", ")} ETB
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Fairness */}
      <section className="rounded-xl border border-border/60 bg-card/60 p-3 flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 text-primary mt-0.5 flex-none" />
        <div className="text-[11px] text-muted-foreground space-y-1">
          {!finished ? (
            <p>
              Fairness commitment is published at lock and verifiable on completion.
              The draw sequence is fixed before the first ball and cannot change.
              {manual ? " Claims are checked against the called balls — a valid BINGO! always pays." : ""}
            </p>
          ) : reveal ? (
            <details>
              <summary className="cursor-pointer text-foreground/90 font-semibold">Draw provenance revealed — verify it yourself</summary>
              <p className="mt-1">server seed <span className="font-mono break-all text-foreground/70">{reveal.serverSeed}</span></p>
              <p>salt <span className="font-mono text-foreground/70">{reveal.salt}</span></p>
              <p>client-seed contribution <span className="font-mono break-all text-foreground/70">{reveal.clientSeedContribution}</span></p>
              <p>commitment <span className="font-mono break-all text-foreground/70">{reveal.commitment}</span></p>
              <p className="pt-1">SHA-256(seed:salt) must equal the commitment; the ball order regenerates from the seed with the same public code.</p>
            </details>
          ) : (
            <p className="inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Seed sealed until the round settles.</p>
          )}
        </div>
      </section>

      {/* BINGO! bar — manual halls: claim is yours to tap (sticky above the nav) */}
      {manual && detail.myTickets.length > 0 && !finished && (
        <div className="sticky bottom-[60px] z-40 pt-1">
          <div className="gold-frame rounded-2xl bg-card/90 backdrop-blur-md p-2 flex items-center gap-2 shadow-[0_8px_24px_oklch(0_0_0/35%)]">
            <button
              aria-label="How to win"
              onClick={() => { playSfx("tap"); setGuideOpen(true); }}
              className="w-11 h-11 grid place-items-center rounded-xl border border-primary/40 text-primary flex-none"
            >
              <Info className="w-5 h-5" />
            </button>
            <button
              onClick={() => chooseDaubMode(autoDaub ? "manual" : "auto")}
              aria-pressed={!autoDaub}
              aria-label={autoDaub ? "Switch to manual daubing" : "Switch to auto daubing"}
              className={`w-11 h-11 grid place-items-center rounded-xl border flex-none ${autoDaub ? "border-emerald-600/60 text-emerald-500" : "border-accent/60 text-accent-foreground"}`}
            >
              {autoDaub ? <Zap className="w-5 h-5" /> : <Hand className="w-5 h-5" />}
            </button>
            <button
              disabled={!canBingo || claiming}
              onClick={claim}
              aria-live="polite"
              className={`flex-1 min-h-12 rounded-xl font-black text-xl tracking-widest btn-juice transition-all
                ${canBingo ? "bingo-ready bg-accent text-accent-foreground cursor-pointer" : "bg-secondary/60 text-muted-foreground cursor-not-allowed"}`}
            >
              {claiming ? <Loader2 className="w-5 h-5 animate-spin inline" /> : canBingo ? "⚡ BINGO!" : "BINGO!"}
            </button>
          </div>
          {manual && live.status === "DRAWING" && !autoDaub && !canBingo && (
            <p className="mt-1 text-center text-[11px] font-semibold text-accent-foreground bg-background/85 backdrop-blur-sm rounded-lg py-1 px-2 border border-accent/30">
              Tap the called numbers on your card — then hit BINGO!
            </p>
          )}
        </div>
      )}

      <PatternGuide open={guideOpen} onOpenChange={setGuideOpen} patterns={detail.patterns} variantId={detail.variantId} />
    </div>
  );
}
