"use client";

/**
 * PatternGuide — the "how to win" popup (UC-07 surface, player-facing).
 * Renders every pattern the round resolves against as a mini dot-diagram —
 * the same pinned payloads the engine evaluates — so what the player taps
 * BINGO! for is exactly what the server pays. Warm colours, zero assets.
 */
import { useMemo } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { gridSpec } from "@/modules/game-core/variants";
import type { PatternPayload } from "@/lib/client/types";
import type { PatternDef } from "@/lib/client/types";

const CHIP_COLORS = [
  "oklch(0.66 0.2 25)",   // crimson
  "oklch(0.64 0.13 155)", // emerald
  "oklch(0.8 0.15 88)",   // gold
  "oklch(0.68 0.17 12)",  // rose
  "oklch(0.62 0.11 50)",  // bronze
];

/** Which grid cells light up for this pattern payload. */
function patternCells(variantId: string, payload: PatternPayload): Set<string> {
  const spec = gridSpec(variantId);
  const out = new Set<string>();
  const add = (r: number, c: number) => out.add(`${r}:${c}`);
  switch (payload.kind) {
    case "CELLS":
      for (const [r, c] of payload.cells) add(r, c);
      break;
    case "ROWS_MIN":
      for (let r = 0; r < Math.min(payload.rows, spec.rows); r++) for (let c = 0; c < spec.cols; c++) add(r, c);
      break;
    case "FULL_HOUSE":
      for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) add(r, c);
      break;
  }
  return out;
}

function Diagram({ variantId, payload, color }: { variantId: string; payload: PatternPayload; color: string }) {
  const spec = useMemo(() => gridSpec(variantId), [variantId]);
  const lit = useMemo(() => patternCells(variantId, payload), [variantId, payload]);
  return (
    <div
      className="grid gap-[3px] rounded-lg bg-background/50 p-1.5 flex-none"
      style={{ gridTemplateColumns: `repeat(${spec.cols}, minmax(0, 1fr))`, width: spec.cols * 13 + 14 }}
      aria-hidden
    >
      {Array.from({ length: spec.rows * spec.cols }, (_, i) => {
        const r = Math.floor(i / spec.cols);
        const c = i % spec.cols;
        const on = lit.has(`${r}:${c}`);
        return (
          <span
            key={i}
            className="w-2.5 h-2.5 rounded-[3px]"
            style={on ? { background: color, boxShadow: `0 0 5px ${color}88` } : { background: "oklch(1 0 0 / 8%)" }}
          />
        );
      })}
    </div>
  );
}

export function PatternGuide({
  open,
  onOpenChange,
  patterns,
  variantId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patterns: PatternDef[];
  variantId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gold-frame bg-card/95 max-w-sm rounded-2xl border-0">
        <DialogHeader>
          <DialogTitle className="gold-text font-black text-xl">How to win</DialogTitle>
          <DialogDescription className="text-sm">
            If you mark any of these combinations on your card, tap <span className="font-black text-accent-foreground">BINGO!</span> — the
            first claims share the prize.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[50vh] overflow-y-auto luxe-scroll pr-1">
          {patterns.map((p, i) => (
            <div key={p.patternId} className="flex items-center gap-3 rounded-xl bg-background/40 px-3 py-2">
              <Diagram variantId={variantId} payload={p.payload} color={CHIP_COLORS[i % CHIP_COLORS.length]} />
              <div className="min-w-0">
                <p className="font-bold text-sm truncate">{p.label}</p>
                <p className="text-[11px] text-muted-foreground">
                  {p.payload.kind === "ROWS_MIN"
                    ? `${p.payload.rows} completed line${p.payload.rows > 1 ? "s" : ""}`
                    : p.payload.kind === "FULL_HOUSE"
                      ? "Every number on the card"
                      : `${p.payload.cells.length} marked squares`}
                </p>
              </div>
            </div>
          ))}
          {patterns.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-3">Patterns for this round load with the room.</p>
          )}
        </div>
        <Button className="w-full font-black min-h-11 text-base btn-gold btn-shine" onClick={() => onOpenChange(false)}>
          OK
        </Button>
      </DialogContent>
    </Dialog>
  );
}
