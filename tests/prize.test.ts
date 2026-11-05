/**
 * prize tests — FR-PRZ award math, GR-02/GR-PRT-02/GR-PRT-03 guardrails.
 */
import { describe, expect, test } from "bun:test";
import { checkGuardrails, splitTier, tierAmountFor, validateRulesetShape, worstCasePayout } from "../src/modules/prize";

const rule = (over: Partial<Parameters<typeof tierAmountFor>[0]> = {}) => ({
  patternRef: "pat-1",
  awardType: "PERCENT_NET_POOL" as const,
  valueBps: 5000,
  ...over,
});

describe("ruleset validation (UC-07 authoring)", () => {
  test("accepts a well-formed ruleset", () => {
    expect(validateRulesetShape({ rules: [rule()] }).valid).toBe(true);
  });
  test("rejects empty rulesets, duplicates and bad values", () => {
    expect(validateRulesetShape({ rules: [] }).violation).toBe("EMPTY_RULESET");
    expect(validateRulesetShape({ rules: [rule(), rule()] }).violation).toBe("DUPLICATE_PATTERN_RULE");
    expect(validateRulesetShape({ rules: [rule({ valueBps: 0 })] }).violation).toBe("BAD_VALUE_BPS");
    expect(validateRulesetShape({ rules: [rule({ awardType: "PERCENT_GROSS_CAPPED", valueBps: 800, capBps: 500 })] }).violation).toBe("CAP_BELOW_RATE");
  });
});

describe("tier amounts (FR-PRZ)", () => {
  test("PERCENT_NET_POOL floors on net pool", () => {
    expect(tierAmountFor(rule({ valueBps: 5000 }), 0n, 10_000n)).toBe(5_000n);
    expect(tierAmountFor(rule({ valueBps: 3333 }), 0n, 1_000n)).toBe(333n); // floor
  });
  test("PERCENT_GROSS_CAPPED honours the cap", () => {
    const r = rule({ awardType: "PERCENT_GROSS_CAPPED", valueBps: 8000, capBps: 5000 });
    expect(tierAmountFor(r, 10_000n, 0n)).toBe(5_000n); // capped
  });
  test("FIXED passes through", () => {
    expect(tierAmountFor(rule({ awardType: "FIXED", valueSantim: "1234" }), 0n, 0n)).toBe(1234n);
  });
  test("worst case sums all tiers", () => {
    const rules = [rule({ valueBps: 2000 }), rule({ patternRef: "p2", valueBps: 3000 })];
    expect(worstCasePayout(rules, 0n, 10_000n)).toBe(5_000n);
  });
});

describe("guardrails (GR-02, GR-PRT-02, GR-PRT-03)", () => {
  const opts = { marginFloorBps: 1500, payoutCapBps: 8500 };
  test("passes when worst case leaves margin", () => {
    // 50% payout leaves 50% margin — ok
    const res = checkGuardrails([rule({ valueBps: 5000 })], 10_000n, 10_000n, opts);
    expect(res.ok).toBe(true);
  });
  test("margin floor breach is named", () => {
    const res = checkGuardrails([rule({ valueBps: 9000 })], 10_000n, 10_000n, opts);
    expect(res.ok).toBe(false);
    expect(res.violation).toBe("MARGIN_FLOOR_BREACH");
  });
  test("payout cap breach is named (margin floor passes)", () => {
    // 50% payout leaves margin ≥ floor, but a 30% cap still bites.
    const res = checkGuardrails([rule({ valueBps: 5000 })], 10_000n, 10_000n, {
      marginFloorBps: 1500,
      payoutCapBps: 3000,
    });
    expect(res.ok).toBe(false);
    expect(res.violation).toBe("PAYOUT_CAP_BREACH");
  });
  test("zero gross preview is structurally valid", () => {
    expect(checkGuardrails([rule({ valueBps: 9500 })], 0n, 0n, opts).ok).toBe(true);
  });
});

describe("tier splitting (Build 1 prize semantics)", () => {
  test("floor per winner, remainder stays in the round", () => {
    expect(splitTier(1_000n, 3)).toEqual([333n, 333n, 333n]); // 1 santim residual
    expect(splitTier(1_000n, 4)).toEqual([250n, 250n, 250n, 250n]);
    expect(splitTier(7n, 2)).toEqual([3n, 3n]);
  });
});
