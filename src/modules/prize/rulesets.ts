/**
 * Prize rulesets and award computation (FR-PRZ).
 *
 * Ruleset payload (versioned via the maker-checker pipeline):
 *   { rules: [{ patternRef: <ConfigEntity id>, awardType, valueBps?, valueSantim?, capBps? }] }
 *
 * Build 1 prize semantics (documented decision, deterministic and auditable):
 *   · On a ball tick, every card completing a tier AT THAT TICK shares the
 *     tier amount: each winner gets floor(tierAmount / k); the floor remainder
 *     stays in the round (residual).
 *   · The tier closes at first award — later claims on it are rejected
 *     PATTERN_ALREADY_CONFIRMED (UC-04 failure flow).
 */
import { floorBps, type Santim } from "../../lib/money";
import { ApiError } from "../../lib/errors";

export type AwardType = "PERCENT_NET_POOL" | "PERCENT_GROSS_CAPPED" | "FIXED";

export interface PrizeRule {
  /** Reference to the pattern ConfigEntity (resolved to a version at round pin). */
  patternRef: string;
  /** Display + tie-break order for equal-completion ticks. */
  label?: string;
  awardType: AwardType;
  /** bps of net pool / gross (PERCENT_* types). */
  valueBps?: number;
  /** Cap in bps of gross for PERCENT_GROSS_CAPPED. */
  capBps?: number;
  /** Fixed amount in santim (FIXED). */
  valueSantim?: string;
}

export interface RulesetPayload {
  rules: PrizeRule[];
}

/** Validate the shape of a ruleset payload at authoring time (UC-07). */
export function validateRulesetShape(payload: RulesetPayload): { valid: boolean; violation?: string } {
  if (!Array.isArray(payload.rules) || payload.rules.length === 0) {
    return { valid: false, violation: "EMPTY_RULESET" };
  }
  const seen = new Set<string>();
  for (const rule of payload.rules) {
    if (!rule.patternRef) return { valid: false, violation: "RULE_MISSING_PATTERN" };
    if (seen.has(rule.patternRef)) return { valid: false, violation: "DUPLICATE_PATTERN_RULE" };
    seen.add(rule.patternRef);
    switch (rule.awardType) {
      case "PERCENT_NET_POOL":
        if (!rule.valueBps || rule.valueBps <= 0 || rule.valueBps > 10000) return { valid: false, violation: "BAD_VALUE_BPS" };
        break;
      case "PERCENT_GROSS_CAPPED":
        if (!rule.valueBps || !rule.capBps || rule.valueBps <= 0 || rule.valueBps > 10000) return { valid: false, violation: "BAD_VALUE_BPS" };
        if (rule.capBps < rule.valueBps) return { valid: false, violation: "CAP_BELOW_RATE" };
        break;
      case "FIXED":
        if (!rule.valueSantim || BigInt(rule.valueSantim) <= 0n) return { valid: false, violation: "BAD_FIXED_VALUE" };
        break;
      default:
        return { valid: false, violation: "UNKNOWN_AWARD_TYPE" };
    }
  }
  return { valid: true };
}

/** Compute the tier amount for one rule given the round's financials. */
export function tierAmountFor(rule: PrizeRule, grossSantim: Santim, netPoolSantim: Santim): Santim {
  switch (rule.awardType) {
    case "PERCENT_NET_POOL":
      return floorBps(netPoolSantim, rule.valueBps!);
    case "PERCENT_GROSS_CAPPED":
      return floorBps(grossSantim, Math.min(rule.valueBps!, rule.capBps!));
    case "FIXED":
      return BigInt(rule.valueSantim!);
  }
}

/** Worst-case total payout for a ruleset (guardrail input, FR-PRZ-06). */
export function worstCasePayout(rules: PrizeRule[], grossSantim: Santim, netPoolSantim: Santim): Santim {
  return rules.reduce((acc, rule) => acc + tierAmountFor(rule, grossSantim, netPoolSantim), 0n);
}

/**
 * GR-02 / GR-PRT-02 margin floor and GR-PRT-03 payout cap.
 * Worst-case total awards must leave at least `marginFloorBps` of gross AND
 * must not exceed `payoutCapBps` of gross.
 */
export function checkGuardrails(
  rules: PrizeRule[],
  grossSantim: Santim,
  netPoolSantim: Santim,
  opts: { marginFloorBps: number; payoutCapBps: number }
): { ok: boolean; violation?: string; worstCase: Santim } {
  const worstCase = worstCasePayout(rules, grossSantim, netPoolSantim);
  if (grossSantim === 0n) return { ok: true, worstCase: 0n }; // preview with no sales yet — structural rules only
  const margin = grossSantim - worstCase;
  if (margin < floorBps(grossSantim, opts.marginFloorBps)) {
    return { ok: false, violation: "MARGIN_FLOOR_BREACH", worstCase };
  }
  if (worstCase > floorBps(grossSantim, opts.payoutCapBps)) {
    return { ok: false, violation: "PAYOUT_CAP_BREACH", worstCase };
  }
  return { ok: true, worstCase };
}

/** Split a tier amount across k simultaneous winners: floor each, remainder stays. */
export function splitTier(tierAmount: Santim, winners: number): Santim[] {
  if (winners <= 0) throw new ApiError("INTERNAL", "splitTier with no winners");
  const each = tierAmount / BigInt(winners);
  return Array.from({ length: winners }, () => each);
}
