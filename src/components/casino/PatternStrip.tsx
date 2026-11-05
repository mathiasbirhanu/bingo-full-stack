"use client";

/**
 * PatternStrip — the always-visible "what you win" showcase (FR-PLY-02, the
 * player's ask: "winning pattern in an attractive way ABOVE the number").
 *
 * One vivid chip per pattern the round pays: a mini dot-diagram of the exact
 * pinned shape, its name and its live tier amount. State machine per chip:
 *   pending  — bright gradient border, saturated diagram;
 *   armed    — the NEXT tier the room is playing for glows (halo pulse);
 *   won      — gold flash → "WON" stamp → the chip fades to a ghost and the
 *              glow hands over to the next tier (driven by the live awards
 *              feed, so every player sees the fade at the same moment).
 */
import { useMemo, type CSSProperties } from "react";
import { Crown } from "lucide-react";
import { gridSpec } from "@/modules/game-core/variants";
import type { PatternPayload } from "@/lib/client/types";
import type { PatternDef, PrizePreviewRow } from "@/lib/client/types";
import type { AwardRow } from "@/lib/client/useRoomLive";
import { etb } from "@/lib/client/api";

/** Vivid per-chip hues (index-stable) — no blue, matches the Royale palette. */
const HUES = [
  { main: "oklch(0.72 0.19 35)", soft: "oklch(0.72 0.19 35 / 16%)", glow: "oklch(0.72 0.19 35 / 65%)" },  // vivid coral
  { main: "oklch(0.84 0.17 88)", soft: "oklch(0.84 0.17 88 / 16%)", glow: "oklch(0.84 0.17 88 / 65%)" },  // bright gold
  { main: "oklch(0.78 0.17 155)", soft: "oklch(0.78 0.17 155 / 16%)", glow: "oklch(0.78 0.17 155 / 65%)" }, // spring green
  { main: "oklch(0.72 0.19 320)", soft: "oklch(0.72 0.19 320 / 16%)", glow: "oklch(0.72 0.19 320 / 65%)" }, // magenta
  { main: "oklch(0.78 0.15 200)", soft: "oklch(0.78 0.15 200 / 16%)", glow: "oklch(0.78 0.15 200 / 65%)" }, // aqua
];

/** Grid cells lit by this pattern payload (mirrors the engine's shapes). */
function litCells(variantId: string, payload: PatternPayload): Set<string> {
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

function MiniDiagram({ variantId, payload, hue, dim }: { variantId: string; payload: PatternPayload; hue: string; dim: boolean }) {
  const spec = useMemo(() => gridSpec(variantId), [variantId]);
  const lit = useMemo(() => litCells(variantId, payload), [variantId, payload]);
  const dot = spec.cols > 5 ? 4 : 6; // 90-ball strips are wider — smaller dots
  return (
    <div
      className="grid gap-[2px] rounded-md p-1 flex-none pattern-diagram"
      style={{ gridTemplateColumns: `repeat(${spec.cols}, minmax(0, 1fr))` }}
      aria-hidden
    >
      {Array.from({ length: spec.rows * spec.cols }, (_, i) => {
        const r = Math.floor(i / spec.cols);
        const c = i % spec.cols;
        const on = lit.has(`${r}:${c}`);
        return (
          <span
            key={i}
            className="rounded-[2px]"
            style={{
              width: dot,
              height: dot,
              background: on ? hue : "oklch(1 0 0 / 12%)",
              boxShadow: on && !dim ? `0 0 4px ${hue}` : undefined,
              opacity: dim ? 0.45 : 1,
            }}
          />
        );
      })}
    </div>
  );
}

export function PatternStrip({
  variantId,
  patterns,
  prizeTable,
  awards,
  status,
}: {
  variantId: string;
  patterns: PatternDef[];
  prizeTable: PrizePreviewRow[];
  awards: AwardRow[];
  status: string;
}) {
  // Tier amounts by pattern entity id (live pool recomputed server-side).
  const tierOf = useMemo(() => new Map(prizeTable.map((r) => [r.patternId, r.tierSantim])), [prizeTable]);
  const wonLabels = useMemo(() => new Set(awards.map((a) => a.label)), [awards]);
  if (patterns.length === 0) return null;

  // The "armed" chip = first tier not yet paid — the room is playing for it.
  const armedIndex = patterns.findIndex((p) => !wonLabels.has(p.label));
  const live = status === "DRAWING";

  return (
    <section className="pattern-strip gold-frame rounded-2xl p-2.5" aria-label="Winning patterns for this round">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <h3 className="text-[11px] font-black uppercase tracking-[0.14em] gold-text inline-flex items-center gap-1">
          <Crown className="w-3.5 h-3.5 text-primary" /> Win patterns
        </h3>
        <span className="text-[10px] text-muted-foreground">
          {wonLabels.size > 0 ? `${wonLabels.size}/${patterns.length} won this round` : "first claim takes the tier"}
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto luxe-scroll pb-0.5">
        {patterns.map((p, i) => {
          const hue = HUES[i % HUES.length];
          const won = wonLabels.has(p.label);
          const armed = live && i === armedIndex;
          return (
            <div
              key={p.patternId}
              className={`pattern-chip relative flex items-center gap-2 rounded-xl px-2 py-1.5 flex-none
                ${won ? "pattern-won" : ""} ${armed ? "pattern-armed" : ""}`}
              style={{
                "--ph": hue.main,
                "--ph-soft": hue.soft,
                "--ph-glow": hue.glow,
              } as CSSProperties}
              role="status"
              aria-label={won ? `${p.label} — won` : armed ? `${p.label} — playing for it now` : p.label}
            >
              <MiniDiagram variantId={variantId} payload={p.payload} hue={hue.main} dim={won} />
              <div className="min-w-0 pr-1">
                <p className={`text-[12px] font-black leading-tight truncate ${won ? "line-through decoration-2" : ""}`} style={{ color: won ? undefined : hue.main }}>
                  {p.label}
                </p>
                <p className="text-[11px] font-bold tabular-nums text-foreground/85">
                  {tierOf.get(p.patternId) ? etb(tierOf.get(p.patternId)!) : "—"}
                  <span className="text-[9px] font-normal text-muted-foreground"> ETB</span>
                </p>
              </div>
              {won && <span className="pattern-stamp">WON</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
