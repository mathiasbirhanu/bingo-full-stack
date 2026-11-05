/**
 * Patterns & prize-shape evaluation (FR-GAME-08, FR-PRZ, UC-07 guardrails).
 *
 * A pattern is data published through the maker-checker pipeline. Three kinds
 * cover the MVP catalogue:
 *   CELLS      — fixed set of grid coordinates to complete (75-ball lines, corners, X…)
 *   ROWS_MIN   — n distinct completed rows (90-ball one line / two lines)
 *   FULL_HOUSE — every number on the card marked (90-ball full house / 75-ball blackout)
 */
import { GridCells, gridSpec } from "./variants";

export type PatternPayload =
  | { kind: "CELLS"; cells: Array<[number, number]> }
  | { kind: "ROWS_MIN"; rows: number }
  | { kind: "FULL_HOUSE" };

export interface PatternCheckResult {
  complete: boolean;
  detail?: string;
}

/** Validate a pattern payload against the variant grid (GR-01, FR-PRT-11). */
export function validatePattern(variantId: string, payload: PatternPayload): { valid: boolean; violation?: string } {
  const spec = gridSpec(variantId);
  switch (payload.kind) {
    case "FULL_HOUSE":
      return { valid: true };
    case "ROWS_MIN":
      if (payload.rows < 1 || payload.rows > spec.rows) return { valid: false, violation: "ROWS_OUT_OF_GRID" };
      return { valid: true };
    case "CELLS": {
      if (payload.cells.length === 0) return { valid: false, violation: "EMPTY_PATTERN" };
      for (const [r, c] of payload.cells) {
        if (r < 0 || r >= spec.rows || c < 0 || c >= spec.cols) return { valid: false, violation: "CELL_OUT_OF_GRID" };
        const isFree = spec.freeCells.some(([fr, fc]) => fr === r && fc === c);
        if (isFree) return { valid: false, violation: "CELL_IS_FREE_SQUARE" }; // free cells cannot be required
      }
      return { valid: true };
    }
    default:
      return { valid: false, violation: "UNKNOWN_PATTERN_KIND" };
  }
}

/** Is the pattern complete on the card given the called-ball set? */
export function isPatternComplete(
  variantId: string,
  cells: GridCells,
  called: Set<number>,
  payload: PatternPayload
): PatternCheckResult {
  const spec = gridSpec(variantId);
  // Blank cells (90-ball) are never blockers — completion is about the real
  // numbers; free squares (75-ball centre) are permanently marked.
  const isMarked = (r: number, c: number): boolean => {
    const n = cells[r][c];
    if (n === null) return spec.freeCells.some(([fr, fc]) => fr === r && fc === c);
    return called.has(n);
  };
  switch (payload.kind) {
    case "CELLS": {
      const all = payload.cells.every(([r, c]) => isMarked(r, c));
      return all ? { complete: true } : { complete: false };
    }
    case "ROWS_MIN": {
      let done = 0;
      for (let r = 0; r < spec.rows; r++) {
        let all = true;
        for (let c = 0; c < spec.cols; c++) {
          if (cells[r][c] !== null && !called.has(cells[r][c] as number)) {
            all = false;
            break;
          }
        }
        if (all) done++;
      }
      return done >= payload.rows ? { complete: true, detail: `${done} rows` } : { complete: false, detail: `${done} rows` };
    }
    case "FULL_HOUSE": {
      for (let r = 0; r < spec.rows; r++) {
        for (let c = 0; c < spec.cols; c++) {
          if (cells[r][c] !== null && !called.has(cells[r][c] as number)) return { complete: false };
        }
      }
      return { complete: true };
    }
  }
}

/** Convenience constructors for the seeded catalogue. */
export const PatternFactory = {
  row75(row: number): PatternPayload {
    return { kind: "CELLS", cells: [0, 1, 2, 3, 4].map((c) => [row, c] as [number, number]) };
  },
  anyColumn75(col: number): PatternPayload {
    return { kind: "CELLS", cells: [0, 1, 2, 3, 4].map((r) => [r, col] as [number, number]) };
  },
  fourCorners75(): PatternPayload {
    return {
      kind: "CELLS",
      cells: [
        [0, 0],
        [0, 4],
        [4, 0],
        [4, 4],
      ],
    };
  },
  x75(): PatternPayload {
    return {
      kind: "CELLS",
      cells: [
        [0, 0],
        [1, 1],
        [3, 3],
        [4, 4],
        [4, 0],
        [3, 1],
        [1, 3],
        [0, 4],
      ], // centre free square completes the X
    };
  },
  blackout75(): PatternPayload {
    return { kind: "FULL_HOUSE" };
  },
  line90(): PatternPayload {
    return { kind: "ROWS_MIN", rows: 1 };
  },
  twoLines90(): PatternPayload {
    return { kind: "ROWS_MIN", rows: 2 };
  },
  fullHouse90(): PatternPayload {
    return { kind: "FULL_HOUSE" };
  },
};
