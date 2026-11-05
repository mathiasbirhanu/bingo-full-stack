/**
 * Card issuance (FR-GAME-02/03): CSPRNG with column-wise sampling without
 * replacement, honouring the variant grid. Cards are pure data — the same
 * functions render and validate on the client.
 */
import { secureRandomInt, sha256Hex } from "../../lib/crypto";
import { GridCells, gridSpec, GridSpec } from "./variants";

function sampleDistinct(min: number, max: number, count: number): number[] {
  // Rejection sample into a set — ranges here are small (≤ 15) so collisions
  // are cheap to retry; the source of randomness is the CSPRNG.
  const picked = new Set<number>();
  while (picked.size < count) picked.add(min + secureRandomInt(max - min + 1));
  return [...picked].sort((a, b) => a - b);
}

/** Generate one card for the variant as a grid of cells. */
export function generateCard(variantId: string): { cells: GridCells; fingerprint: string } {
  const spec: GridSpec = gridSpec(variantId);
  const cells: GridCells = Array.from({ length: spec.rows }, () => Array.from({ length: spec.cols }, () => null));

  if (spec.variantId === "BALL_75") {
    // One column block at a time: 5 distinct numbers per column, centre free.
    for (let c = 0; c < spec.cols; c++) {
      const [min, max] = spec.columnRanges[c];
      const nums = sampleDistinct(min, max, 5);
      let r = 0;
      for (let row = 0; row < spec.rows; row++) {
        if (spec.freeCells.some(([fr, fc]) => fr === row && fc === c)) continue;
        cells[row][c] = nums[r++];
      }
    }
  } else {
    // Column counts: col 0 and col 8 hold exactly 1; six of the middle seven
    // hold 2 → 1 + 6×2 + 1 + 1 = 15 numbers total.
    const counts: number[] = new Array(9).fill(1);
    const middle = [1, 2, 3, 4, 5, 6, 7];
    for (let i = middle.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      [middle[i], middle[j]] = [middle[j], middle[i]];
    }
    for (const c of middle.slice(0, 6)) counts[c] = 2;

    // Row assignment — greedy least-filled with distinct rows per column.
    // Provable: counts ≤ 2 and 3 rows make a distinct pair always available;
    // filling the least-filled rows first ends at exactly 5/5/5.
    const rowFill = [0, 0, 0];
    const rowsOf: number[][] = new Array(9).fill(null).map(() => []);
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    for (let i = order.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const c of order) {
      const candidates = [0, 1, 2]
        .filter((r) => !rowsOf[c].includes(r))
        .sort((a, b) => rowFill[a] - rowFill[b] || secureRandomInt(3) - 1);
      for (let k = 0; k < counts[c]; k++) {
        const r = candidates[k];
        rowsOf[c].push(r);
        rowFill[r]++;
      }
    }

    // Sample numbers per column and lay them top-down into their rows.
    for (let c = 0; c < 9; c++) {
      const [min, max] = spec.columnRanges[c];
      const nums = sampleDistinct(min, max, counts[c]);
      const rows = [...rowsOf[c]].sort((a, b) => a - b);
      rows.forEach((r, i) => (cells[r][c] = nums[i]));
    }
  }

  return { cells, fingerprint: cardFingerprint(cells) };
}

/** Canonical fingerprint (FR-GAME-02 generation trace): sha256 over the sorted number list. */
export function cardFingerprint(cells: GridCells): string {
  const nums: number[] = [];
  for (const row of cells) for (const n of row) if (n !== null) nums.push(n);
  nums.sort((a, b) => a - b);
  return sha256Hex(nums.join(","));
}

/** Count of real numbers on a card (24 for 75-ball, 15 for 90-ball). */
export function numberCount(cells: GridCells): number {
  let n = 0;
  for (const row of cells) for (const c of row) if (c !== null) n++;
  return n;
}

/** Marked-state mask for a card given the called set (client render + claim checks). */
export function daubMask(cells: GridCells, called: Set<number>, spec: GridSpec): boolean[][] {
  return cells.map((row, r) =>
    row.map((n, c) => {
      if (n === null) return spec.freeCells.some(([fr, fc]) => fr === r && fc === c);
      return called.has(n);
    })
  );
}
