using System.Text.Json;

namespace BingoRoyale.Core;

/// <summary>
/// Prize rulesets and award computation (FR-PRZ).
/// Ruleset payload (versioned via the maker-checker pipeline):
///   { rules: [{ patternRef, awardType, valueBps?, valueSantim?, capBps? }] }
/// Build 1 prize semantics (deterministic and auditable):
///   · On a ball tick, every card completing a tier AT THAT TICK shares the
///     tier amount: each winner gets floor(tierAmount / k); the floor remainder
///     stays in the round (residual).
///   · The tier closes at first award — later claims are rejected.
/// </summary>
public sealed class PrizeRule
{
    /// <summary>Reference to the pattern ConfigEntity (resolved to a version at round pin).</summary>
    public string PatternRef { get; init; } = "";
    /// <summary>Display + tie-break order for equal-completion ticks.</summary>
    public string? Label { get; init; }
    /// <summary>PERCENT_NET_POOL | PERCENT_GROSS_CAPPED | FIXED.</summary>
    public string AwardType { get; init; } = "";
    /// <summary>bps of net pool / gross (PERCENT_* types).</summary>
    public int? ValueBps { get; init; }
    /// <summary>Cap in bps of gross for PERCENT_GROSS_CAPPED.</summary>
    public int? CapBps { get; init; }
    /// <summary>Fixed amount in santim (FIXED).</summary>
    public long? ValueSantim { get; init; }

    public static PrizeRule FromJson(JsonElement el)
    {
        long? valueSantim = null;
        if (el.TryGetProperty("valueSantim", out var vs) && vs.ValueKind is JsonValueKind.String or JsonValueKind.Number)
            valueSantim = vs.ValueKind == JsonValueKind.String ? long.Parse(vs.GetString()!) : vs.GetInt64();
        int? ValueBpsOf(string name) => el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number ? p.GetInt32() : null;
        string? LabelOf() => el.TryGetProperty("label", out var l) && l.ValueKind == JsonValueKind.String ? l.GetString() : null;
        return new PrizeRule
        {
            PatternRef = el.GetProperty("patternRef").GetString()!,
            Label = LabelOf(),
            AwardType = el.GetProperty("awardType").GetString()!,
            ValueBps = ValueBpsOf("valueBps"),
            CapBps = ValueBpsOf("capBps"),
            ValueSantim = valueSantim,
        };
    }
}

public sealed class RulesetPayload
{
    public List<PrizeRule> Rules { get; init; } = new();

    public static RulesetPayload FromJson(JsonElement el)
    {
        var rules = new List<PrizeRule>();
        if (el.TryGetProperty("rules", out var arr) && arr.ValueKind == JsonValueKind.Array)
            foreach (var r in arr.EnumerateArray()) rules.Add(PrizeRule.FromJson(r));
        return new RulesetPayload { Rules = rules };
    }
}

public record struct GuardrailResult(bool Ok, string? Violation, long WorstCase);

public static class PrizeRules
{
    /// <summary>Validate the shape of a ruleset payload at authoring time (UC-07).</summary>
    public static Validation ValidateRulesetShape(RulesetPayload payload)
    {
        if (payload.Rules.Count == 0) return new Validation(false, "EMPTY_RULESET");
        var seen = new HashSet<string>();
        foreach (var rule in payload.Rules)
        {
            if (string.IsNullOrEmpty(rule.PatternRef)) return new Validation(false, "RULE_MISSING_PATTERN");
            if (!seen.Add(rule.PatternRef)) return new Validation(false, "DUPLICATE_PATTERN_RULE");
            switch (rule.AwardType)
            {
                case "PERCENT_NET_POOL":
                    if (rule.ValueBps is not (> 0 and <= 10000)) return new Validation(false, "BAD_VALUE_BPS");
                    break;
                case "PERCENT_GROSS_CAPPED":
                    if (rule.ValueBps is not (> 0 and <= 10000) || rule.CapBps is null)
                        return new Validation(false, "BAD_VALUE_BPS");
                    if (rule.CapBps < rule.ValueBps) return new Validation(false, "CAP_BELOW_RATE");
                    break;
                case "FIXED":
                    if (rule.ValueSantim is not (> 0)) return new Validation(false, "BAD_FIXED_VALUE");
                    break;
                default:
                    return new Validation(false, "UNKNOWN_AWARD_TYPE");
            }
        }
        return new Validation(true);
    }

    /// <summary>Compute the tier amount for one rule given the round's financials.</summary>
    public static long TierAmountFor(PrizeRule rule, long grossSantim, long netPoolSantim) =>
        rule.AwardType switch
        {
            "PERCENT_NET_POOL" => Money.FloorBps(netPoolSantim, rule.ValueBps ?? 0),
            "PERCENT_GROSS_CAPPED" => Money.FloorBps(grossSantim, Math.Min(rule.ValueBps ?? 0, rule.CapBps ?? 0)),
            "FIXED" => rule.ValueSantim ?? 0,
            _ => throw new InvalidOperationException("UNKNOWN_AWARD_TYPE"),
        };

    /// <summary>Worst-case total payout for a ruleset (guardrail input, FR-PRZ-06).</summary>
    public static long WorstCasePayout(IReadOnlyList<PrizeRule> rules, long grossSantim, long netPoolSantim) =>
        rules.Aggregate(0L, (acc, rule) => acc + checked(TierAmountFor(rule, grossSantim, netPoolSantim)));

    /// <summary>
    /// GR-02 / GR-PRT-02 margin floor and GR-PRT-03 payout cap: worst-case
    /// total awards must leave at least marginFloorBps of gross AND must not
    /// exceed payoutCapBps of gross.
    /// </summary>
    public static GuardrailResult CheckGuardrails(
        IReadOnlyList<PrizeRule> rules, long grossSantim, long netPoolSantim,
        int marginFloorBps, int payoutCapBps)
    {
        long worstCase = WorstCasePayout(rules, grossSantim, netPoolSantim);
        if (grossSantim == 0) return new GuardrailResult(true, null, 0); // preview with no sales yet
        long margin = grossSantim - worstCase;
        if (margin < Money.FloorBps(grossSantim, marginFloorBps))
            return new GuardrailResult(false, "MARGIN_FLOOR_BREACH", worstCase);
        if (worstCase > Money.FloorBps(grossSantim, payoutCapBps))
            return new GuardrailResult(false, "PAYOUT_CAP_BREACH", worstCase);
        return new GuardrailResult(true, null, worstCase);
    }

    /// <summary>Split a tier amount across k simultaneous winners: floor each, remainder stays.</summary>
    public static long[] SplitTier(long tierAmount, int winners)
    {
        if (winners <= 0) throw new InvalidOperationException("splitTier with no winners");
        long each = tierAmount / winners;
        return Enumerable.Repeat(each, winners).ToArray();
    }
}
