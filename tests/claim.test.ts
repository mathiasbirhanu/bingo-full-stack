/**
 * Manual BINGO! claim tests — the pure decision core of engine/claim.ts:
 *   · pickClaim pays the first OPEN pattern the caller completed (ruleset order);
 *   · the tier then splits across EVERY ticket in the room completing it;
 *   · closed tiers never pay twice;
 *   · "n more for X" best-hint when nothing completes;
 *   · the manual-round completion grace window (shouldCompleteRound).
 */
import { describe, expect, test } from "bun:test";
import { pickClaim, patternRemaining } from "../src/modules/engine/claim";
import { shouldCompleteRound } from "../src/modules/engine/tick";
import { PatternFactory, type PatternPayload } from "../src/modules/game-core/patterns";

const CALLER = "player-A";
const OTHER = "player-B";

function cells75(): (number | null)[][] {
  // 5×5 with 1..25 laid row-wise, centre (2,2) free.
  const grid: (number | null)[][] = [];
  let n = 1;
  for (let r = 0; r < 5; r++) {
    const row: (number | null)[] = [];
    for (let c = 0; c < 5; c++) row.push(n++);
    grid.push(row);
  }
  grid[2][2] = null;
  return grid;
}

interface Def { entityId: string; versionId: string; label: string; payload: PatternPayload; }
const def = (id: string, payload: PatternPayload, label = id): Def => ({ entityId: id, versionId: `v-${id}`, label, payload });

function baseInput(overrides: Partial<Parameters<typeof pickClaim>[0]> = {}): Parameters<typeof pickClaim>[0] {
  return {
    variantId: "BALL_75",
    rules: [{ patternRef: "topline" }],
    patterns: [def("topline", PatternFactory.row75(0), "Top Line")],
    closedRules: new Set<string>(),
    myTickets: [cells75()],
    allTickets: [{ ticketId: "t-A", playerId: CALLER, cells: cells75() }],
    called: new Set([1, 2, 3, 4, 5]),
    ...overrides,
  };
}

describe("pickClaim", () => {
  test("complete tier → caller wins, splits with every completing ticket", () => {
    const otherTicket = cells75();
    const res = pickClaim(baseInput({ allTickets: [{ ticketId: "t-A", playerId: CALLER, cells: cells75() }, { ticketId: "t-B", playerId: OTHER, cells: otherTicket }] }));
    if (!res.pattern) throw new Error("expected claimable");
    expect(res.pattern.entityId).toBe("topline");
    expect(res.winners.length).toBe(2);
    expect(res.winners.map((w) => w.playerId).sort()).toEqual([CALLER, OTHER].sort());
  });

  test("one number short → NOT_YET with honest remaining hint", () => {
    const res = pickClaim(baseInput({ called: new Set([1, 2, 3, 4]) }));
    expect(res.pattern).toBeNull();
    expect(res.pattern === null && res.best).toEqual({ label: "Top Line", remaining: 1 });
  });

  test("caller did not complete → other players' completions are NOT claimed by them", () => {
    // Caller holds a card with a different row; another player completed the line.
    const mine = cells75().map((row, r) => (r === 0 ? [51, 52, 53, 54, 55] : row));
    const res = pickClaim(baseInput({ myTickets: [mine] }));
    expect(res.pattern).toBeNull();
  });

  test("closed tier is skipped; next open pattern pays", () => {
    const res = pickClaim(
      baseInput({
        rules: [{ patternRef: "topline" }, { patternRef: "corners" }],
        patterns: [def("topline", PatternFactory.row75(0), "Top Line"), def("corners", PatternFactory.fourCorners75(), "Four Corners")],
        closedRules: new Set(["topline"]),
        called: new Set([1, 5, 21, 25]), // corners complete (1,5,21,25), topline also complete but closed
      })
    );
    if (!res.pattern) throw new Error("expected corners claimable");
    expect(res.pattern.entityId).toBe("corners");
  });

  test("patternRemaining: CELLS / ROWS_MIN / FULL_HOUSE", () => {
    const cells = cells75();
    expect(patternRemaining("BALL_75", cells, new Set([1, 2, 3, 4]), PatternFactory.row75(0))).toBe(1);
    expect(patternRemaining("BALL_75", cells, new Set([1, 2, 3, 4, 5]), PatternFactory.row75(0))).toBe(0);
    // Free centre completes the X — need the 8 outer X cells.
    const x = PatternFactory.x75();
    if (x.kind !== "CELLS") throw new Error("X pattern must be CELLS");
    const xNumbers = x.cells.map(([r, c]) => cells[r][c] as number);
    const four = new Set<number>(xNumbers.slice(0, 4));
    expect(patternRemaining("BALL_75", cells, four, x)).toBe(xNumbers.length - 4);
    expect(patternRemaining("BALL_75", cells, new Set([1]), PatternFactory.blackout75())).toBe(23);
  });
});

describe("shouldCompleteRound (manual grace)", () => {
  const last = Date.now() - 5_000;
  test("all tiers paid → complete immediately, even mid-deck", () => {
    expect(shouldCompleteRound({ allBallsDrawn: false, allTiersPaid: true, autoClaim: true, lastBallCalledAt: last, now: Date.now() })).toBe(true);
    expect(shouldCompleteRound({ allBallsDrawn: false, allTiersPaid: true, autoClaim: false, lastBallCalledAt: last, now: Date.now() })).toBe(true);
  });
  test("auto room: last ball → complete now", () => {
    expect(shouldCompleteRound({ allBallsDrawn: true, allTiersPaid: false, autoClaim: true, lastBallCalledAt: last, now: Date.now() })).toBe(true);
  });
  test("manual room: last ball waits the grace window for late BINGO! claims", () => {
    expect(shouldCompleteRound({ allBallsDrawn: true, allTiersPaid: false, autoClaim: false, lastBallCalledAt: last, now: Date.now() })).toBe(false);
    expect(
      shouldCompleteRound({ allBallsDrawn: true, allTiersPaid: false, autoClaim: false, lastBallCalledAt: Date.now() - 21_000, now: Date.now() })
    ).toBe(true);
  });
  test("balls still in the drum → keep drawing", () => {
    expect(shouldCompleteRound({ allBallsDrawn: false, allTiersPaid: false, autoClaim: false, lastBallCalledAt: last, now: Date.now() })).toBe(false);
  });
});
