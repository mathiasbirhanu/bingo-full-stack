"use client";

/**
 * BingoCard — one ticket for both variants, two marking modes:
 *   · auto — server-driven daub state (ADR-20), a pure function of the called set;
 *   · manual (tap-to-daub) — the player taps each called number; invalid taps
 *     buzz + shake and mark nothing. The server still validates every claim
 *     against the called set, so manual marking is engagement, not trust.
 *
 * The same cells render 5×5 (75-ball, FREE centre) and 3×9 (90-ball strip).
 * 75-ball column headers carry the classic per-letter colours (B crimson,
 * I gold, N emerald, G bronze, O rose) — the Royale warm palette.
 */
import { memo } from "react";
import { Star } from "lucide-react";
import { ballClass } from "@/lib/client/types";

/** Warm header colours — no blue, matches the THEMES palette. */
const LETTER_COLORS = [
  "oklch(0.66 0.2 25)",   // B — crimson
  "oklch(0.8 0.15 88)",   // I — gold
  "oklch(0.64 0.13 155)", // N — emerald
  "oklch(0.62 0.11 50)",  // G — bronze
  "oklch(0.68 0.17 12)",  // O — rose
];

interface Props {
  cells: (number | null)[][];
  variantId: string;
  /** Marked ball numbers (auto: called set · manual: player's daubs). */
  marked: Set<number>;
  freshBall: number | null;
  /** Manual mode: cells are tappable. */
  interactive?: boolean;
  onTapCell?: (n: number) => void;
  /** Invalid-tap feedback: { n, k } — k re-triggers the shake animation. */
  shake?: { n: number; k: number } | null;
  compact?: boolean;
}

export const BingoCard = memo(function BingoCard({
  cells,
  variantId,
  marked,
  freshBall,
  interactive = false,
  onTapCell,
  shake,
  compact,
}: Props) {
  const is75 = variantId === "BALL_75";
  const cols = is75 ? 5 : 9;
  const headers = is75 ? ["B", "I", "N", "G", "O"] : Array.from({ length: 9 }, (_, i) => (i + 1).toString());
  const shakeK = shake?.k ?? 0;

  return (
    <div className={`gold-frame rounded-xl bg-card/90 overflow-hidden ${compact ? "p-1.5" : "p-2.5"}`}>
      {/* Column headers — 75-ball gets the coloured BINGO letters */}
      <div className="grid gap-1 mb-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {headers.map((h, i) => (
          <div
            key={`h-${i}`}
            className={`text-center font-black rounded-md ${is75 ? "" : "text-muted-foreground/70 text-[9px]"}`}
            style={
              is75
                ? { color: LETTER_COLORS[i], background: `${LETTER_COLORS[i]}22`, textShadow: "0 1px 0 oklch(0 0 0 / 35%)" }
                : undefined
            }
          >
            {h}
          </div>
        ))}
      </div>
      {/* Grid */}
      {cells.map((row, r) => (
        <div key={r} className="grid gap-1 mb-1 last:mb-0" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {row.map((n, c) => {
            const isFree = n === null && is75 && r === 2 && c === 2;
            const cellMarked = isFree || (n !== null && marked.has(n));
            const fresh = n !== null && cellMarked && n === freshBall;
            const shaking = n !== null && shake?.n === n;
            const cell = (
              <div
                key={c}
                className={`relative flex items-center justify-center rounded-md select-none transition-shadow
                  ${compact ? "h-8 text-[13px]" : "h-10 text-[15px]"}
                  ${shaking ? "cell-shake" : ""}
                  ${fresh ? "cell-fresh" : ""}
                  ${n === null
                    ? isFree
                      ? "bg-primary/15 text-primary"
                      : "bg-background/30"
                    : cellMarked
                      ? "bg-background/25 text-transparent"
                      : "bg-secondary/70 text-foreground font-bold"}`}
                aria-label={n === null ? (isFree ? "free square" : "blank") : cellMarked ? `${n} marked` : String(n)}
              >
                {n === null ? (
                  isFree ? <Star className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} fill="currentColor" />
                  : <span className="text-muted-foreground/30 text-[10px]">·</span>
                ) : (
                  <>
                    <span className={cellMarked ? "opacity-30" : ""}>{n}</span>
                    {cellMarked && <span className={`daub ${fresh ? "" : "animate-none"}`} />}
                  </>
                )}
                {n !== null && cellMarked && (
                  <span className={`absolute inset-0 flex items-center justify-center font-black text-white/95 ${compact ? "text-[13px]" : "text-[15px]"}`}>
                    {n}
                  </span>
                )}
              </div>
            );
            if (!interactive || n === null) return cell;
            return (
              <button
                key={`${c}-${shaking ? shakeK : 0}`}
                type="button"
                className="text-left cursor-pointer active:scale-95 transition-transform"
                aria-label={cellMarked ? `${n} marked` : `Tap to daub ${n}`}
                onClick={() => n !== null && onTapCell?.(n)}
              >
                {cell}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
});
