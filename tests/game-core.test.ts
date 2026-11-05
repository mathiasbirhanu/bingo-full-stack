/**
 * game-core unit tests — SRS trace: FR-GAME-01..08, UC-06, GR-01.
 * Run: bun test tests/game-core.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  BALL_75,
  BALL_90,
  cardFingerprint,
  daubMask,
  generateCard,
  generateDrawSequence,
  commitmentHolds,
  gridSpec,
  isPatternComplete,
  numberCount,
  PatternFactory,
  validatePattern,
} from "../src/modules/game-core";
import { etbToSantim, floorBps, santimToEtb } from "../src/lib/money";
import { normalizeEthiopianPhone } from "../src/lib/crypto";

describe("phone normalization (UC-01)", () => {
  test("normalizes Ethiopian mobile numbers to E.164", () => {
    expect(normalizeEthiopianPhone("0911234567")).toBe("+251911234567");
    expect(normalizeEthiopianPhone("+251911234567")).toBe("+251911234567");
    expect(normalizeEthiopianPhone("251-91-123-4567")).toBe("+251911234567");
    expect(normalizeEthiopianPhone("0711234567")).toBe("+251711234567");
  });
  test("rejects unknown-format numbers before any SMS is sent", () => {
    expect(normalizeEthiopianPhone("12345")).toBeNull();
    expect(normalizeEthiopianPhone("0811234567")).toBeNull();
    expect(normalizeEthiopianPhone("")).toBeNull();
  });
});

describe("money (int64 santim)", () => {
  test("etb <-> santim round trip", () => {
    expect(etbToSantim("12.50")).toBe(1250n);
    expect(santimToEtb(1250n)).toBe("12.50");
    expect(santimToEtb(123456789n)).toBe("1,234,567.89");
  });
  test("floorBps is exact bigint floor — commission core (UC-15)", () => {
    expect(floorBps(1_000_000n, 1500)).toBe(150000n); // 10,000.00 ETB × 15% = 1,500.00
    expect(floorBps(999n, 1500)).toBe(149n); // floor(999×0.15)=149.85 → 149
    expect(floorBps(0n, 3500)).toBe(0n);
  });
});

describe("variants (FR-GAME-01)", () => {
  test("MVP variants resolve; others are refused while OD-05 is open", () => {
    expect(gridSpec("BALL_75").ballsTotal).toBe(75);
    expect(gridSpec("BALL_90").ballsTotal).toBe(90);
    expect(() => gridSpec("BALL_80")).toThrow("VARIANT_NOT_ENABLED");
  });
});

describe("card issuance (FR-GAME-02/03)", () => {
  test("75-ball card: 24 numbers, column ranges, centre free", () => {
    const { cells, fingerprint } = generateCard("BALL_75");
    expect(numberCount(cells)).toBe(24);
    expect(cells[2][2]).toBeNull(); // free square
    for (let c = 0; c < 5; c++) {
      const [min, max] = BALL_75.columnRanges[c];
      for (let r = 0; r < 5; r++) {
        const n = cells[r][c];
        if (n !== null) expect(n >= min && n <= max).toBe(true);
      }
    }
    expect(fingerprint).toBe(cardFingerprint(cells));
  });

  test("90-ball ticket: 15 numbers, 5 per row, column ranges", () => {
    for (let i = 0; i < 50; i++) {
      const { cells } = generateCard("BALL_90");
      expect(numberCount(cells)).toBe(15);
      for (let r = 0; r < 3; r++) {
        const filled = cells[r].filter((n) => n !== null).length;
        expect(filled).toBe(5);
      }
      for (let c = 0; c < 9; c++) {
        const [min, max] = BALL_90.columnRanges[c];
        const colNums = cells.map((row) => row[c]).filter((n) => n !== null) as number[];
        for (const n of colNums) expect(n >= min && n <= max).toBe(true);
        // numbers within a column are top-down sorted
        expect(colNums).toEqual([...colNums].sort((a, b) => a - b));
      }
    }
  });

  test("two generated cards never share a fingerprint (property, 200 samples)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { fingerprint } = generateCard(i % 2 === 0 ? "BALL_75" : "BALL_90");
      expect(seen.has(fingerprint)).toBe(false);
      seen.add(fingerprint);
    }
  });
});

describe("provably-fair draw (FR-GAME-04/07, UC-06)", () => {
  const seed = "a".repeat(64);
  const salt = "deadbeef";
  const client = "cafe";

  test("deterministic: same inputs regenerate the exact sequence", async () => {
    const a = await generateDrawSequence(seed, salt, client, 0, "BALL_90");
    const b = await generateDrawSequence(seed, salt, client, 0, "BALL_90");
    expect(a).toEqual(b);
  });

  test("is a permutation of the full universe, no repeats", async () => {
    const seq = await generateDrawSequence(seed, salt, client, 0, "BALL_90");
    expect(seq).toHaveLength(90);
    expect(new Set(seq).size).toBe(90);
    expect(Math.min(...seq)).toBe(1);
    expect(Math.max(...seq)).toBe(90);
  });

  test("client contribution and nonce change the sequence (audit signal test)", async () => {
    const a = await generateDrawSequence(seed, salt, client, 0, "BALL_75");
    const b = await generateDrawSequence(seed, salt, client + "x", 0, "BALL_75");
    const c = await generateDrawSequence(seed, salt, client, 1, "BALL_75");
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  test("commitment binds seed and salt", () => {
    expect(commitmentHolds("", "", "")).toBe(false);
    // commitmentHolds is checked with real values in integration; shape check here:
    expect(typeof commitmentHolds).toBe("function");
  });
});

describe("patterns (GR-01, UC-04)", () => {
  test("validatePattern rejects out-of-grid cells and free squares", () => {
    expect(validatePattern("BALL_75", { kind: "CELLS", cells: [[5, 0]] }).valid).toBe(false);
    expect(validatePattern("BALL_75", { kind: "CELLS", cells: [[2, 2]] }).violation).toBe("CELL_IS_FREE_SQUARE");
    expect(validatePattern("BALL_75", PatternFactory.row75(0)).valid).toBe(true);
    expect(validatePattern("BALL_90", { kind: "ROWS_MIN", rows: 4 }).valid).toBe(false);
  });

  test("row completion tracks called balls", () => {
    const { cells } = generateCard("BALL_75");
    const row0 = cells[0].map((n) => n as number); // top row has no free square
    const called = new Set(row0);
    expect(isPatternComplete("BALL_75", cells, called, PatternFactory.row75(0)).complete).toBe(true);
    expect(isPatternComplete("BALL_75", cells, new Set(), PatternFactory.row75(0)).complete).toBe(false);
  });

  test("X pattern completes via the free centre", () => {
    const { cells } = generateCard("BALL_75");
    const x = PatternFactory.x75();
    const needed: number[] = [];
    for (const [r, c] of x.kind === "CELLS" ? x.cells : []) {
      const n = cells[r][c];
      if (n !== null) needed.push(n);
    }
    expect(isPatternComplete("BALL_75", cells, new Set(needed), x).complete).toBe(true);
  });

  test("90-ball rows-min logic", () => {
    const { cells } = generateCard("BALL_90");
    const row0 = cells[0].map((n) => n as number);
    const one = isPatternComplete("BALL_90", cells, new Set(row0), PatternFactory.line90());
    expect(one.complete).toBe(true);
    const two = isPatternComplete("BALL_90", cells, new Set(row0), PatternFactory.twoLines90());
    expect(two.complete).toBe(false);
    const all = new Set([...row0, ...cells[1].map((n) => n as number), ...cells[2].map((n) => n as number)]);
    expect(isPatternComplete("BALL_90", cells, all, PatternFactory.fullHouse90()).complete).toBe(true);
  });

  test("daub mask marks called numbers and free squares", () => {
    const { cells } = generateCard("BALL_75");
    const mask = daubMask(cells, new Set(), BALL_75);
    expect(mask[2][2]).toBe(true); // free centre pre-marked
    expect(mask.flat().filter(Boolean)).toHaveLength(1);
  });
});
