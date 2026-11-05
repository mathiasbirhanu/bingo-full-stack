/**
 * Variant grids (FR-GAME-01) — 75-ball and 90-ball are the two MVP variants;
 * 80-ball and 30-ball are refused while OD-05 remains open.
 *
 * Grid representation (normative across cards, patterns and UI):
 *   cells: (number | null)[][]  — [row][col], null = blank (90-ball) or FREE square (75-ball centre).
 */

export type GridCells = (number | null)[][];

export interface GridSpec {
  variantId: "BALL_75" | "BALL_90";
  rows: number;
  cols: number;
  /** Column ranges [min,max] inclusive, 1-based ball numbers. */
  columnRanges: Array<[number, number]>;
  /** Cells that are permanently free (auto-marked). */
  freeCells: Array<[number, number]>;
  /** Total balls in the draw universe (75 / 90). */
  ballsTotal: number;
  /** Fixed numbers per card (75-ball: 24 + free; 90-ball: 15). */
  numbersPerCard: number;
}

export const BALL_75: GridSpec = {
  variantId: "BALL_75",
  rows: 5,
  cols: 5,
  columnRanges: [
    [1, 15],
    [16, 30],
    [31, 45],
    [46, 60],
    [61, 75],
  ],
  freeCells: [[2, 2]],
  ballsTotal: 75,
  numbersPerCard: 24,
};

export const BALL_90: GridSpec = {
  variantId: "BALL_90",
  rows: 3,
  cols: 9,
  columnRanges: [
    [1, 9],
    [10, 19],
    [20, 29],
    [30, 39],
    [40, 49],
    [50, 59],
    [60, 69],
    [70, 79],
    [80, 90],
  ],
  freeCells: [],
  ballsTotal: 90,
  numbersPerCard: 15,
};

export function gridSpec(variantId: string): GridSpec {
  switch (variantId) {
    case "BALL_75":
      return BALL_75;
    case "BALL_90":
      return BALL_90;
    default:
      // FR-GAME-01: refuse to enable any variant without a versioned spec (OD-05).
      throw new Error(`VARIANT_NOT_ENABLED:${variantId}`);
  }
}

export const VARIANTS = [BALL_75, BALL_90] as const;
