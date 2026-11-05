using BingoRoyale.Core;
using Xunit;

namespace BingoRoyale.Core.Tests;

/// <summary>
/// prize tests — port of tests/prize.test.ts.
/// FR-PRZ award math, GR-02/GR-PRT-02/GR-PRT-03 guardrails, Build 1 split semantics.
/// </summary>
public class PrizeTests
{
    private static PrizeRule Rule(int valueBps = 5000, string? awardType = null, string patternRef = "pat-1",
        int? capBps = null, long? valueSantim = null) =>
        new()
        {
            PatternRef = patternRef,
            AwardType = awardType ?? "PERCENT_NET_POOL",
            ValueBps = valueBps,
            CapBps = capBps,
            ValueSantim = valueSantim,
        };

    // ── ruleset validation (UC-07 authoring) ────────────────────────────────

    [Fact]
    public void Accepts_a_well_formed_ruleset() =>
        Assert.True(PrizeRules.ValidateRulesetShape(new RulesetPayload { Rules = { Rule() } }).Valid);

    [Fact]
    public void Rejects_empty_rulesets_duplicates_and_bad_values()
    {
        Assert.Equal("EMPTY_RULESET", PrizeRules.ValidateRulesetShape(new RulesetPayload()).Violation);
        Assert.Equal("DUPLICATE_PATTERN_RULE",
            PrizeRules.ValidateRulesetShape(new RulesetPayload { Rules = { Rule(), Rule() } }).Violation);
        Assert.Equal("BAD_VALUE_BPS",
            PrizeRules.ValidateRulesetShape(new RulesetPayload { Rules = { Rule(valueBps: 0) } }).Violation);
        Assert.Equal("CAP_BELOW_RATE",
            PrizeRules.ValidateRulesetShape(new RulesetPayload
            {
                Rules = { Rule(valueBps: 800, awardType: "PERCENT_GROSS_CAPPED", capBps: 500) },
            }).Violation);
    }

    // ── tier amounts (FR-PRZ) ───────────────────────────────────────────────

    [Fact]
    public void Percent_net_pool_floors_on_net_pool()
    {
        Assert.Equal(5_000L, PrizeRules.TierAmountFor(Rule(valueBps: 5000), 0, 10_000));
        Assert.Equal(333L, PrizeRules.TierAmountFor(Rule(valueBps: 3333), 0, 1_000)); // floor
    }

    [Fact]
    public void Percent_gross_capped_honours_the_cap()
    {
        var r = Rule(valueBps: 8000, awardType: "PERCENT_GROSS_CAPPED", capBps: 5000);
        Assert.Equal(5_000L, PrizeRules.TierAmountFor(r, 10_000, 0)); // capped
    }

    [Fact]
    public void Fixed_passes_through() =>
        Assert.Equal(1234L, PrizeRules.TierAmountFor(Rule(awardType: "FIXED", valueSantim: 1234), 0, 0));

    [Fact]
    public void Worst_case_sums_all_tiers()
    {
        var rules = new List<PrizeRule> { Rule(valueBps: 2000), Rule(valueBps: 3000, patternRef: "p2") };
        Assert.Equal(5_000L, PrizeRules.WorstCasePayout(rules, 0, 10_000));
    }

    // ── guardrails (GR-02, GR-PRT-02, GR-PRT-03) ────────────────────────────

    [Fact]
    public void Passes_when_worst_case_leaves_margin()
    {
        // 50% payout leaves 50% margin — ok
        var res = PrizeRules.CheckGuardrails(new[] { Rule() }, 10_000, 10_000, 1500, 8500);
        Assert.True(res.Ok);
    }

    [Fact]
    public void Margin_floor_breach_is_named()
    {
        var res = PrizeRules.CheckGuardrails(new[] { Rule(valueBps: 9000) }, 10_000, 10_000, 1500, 8500);
        Assert.False(res.Ok);
        Assert.Equal("MARGIN_FLOOR_BREACH", res.Violation);
    }

    [Fact]
    public void Payout_cap_breach_is_named_margin_floor_passes()
    {
        // 50% payout leaves margin ≥ floor, but a 30% cap still bites.
        var res = PrizeRules.CheckGuardrails(new[] { Rule() }, 10_000, 10_000, 1500, 3000);
        Assert.False(res.Ok);
        Assert.Equal("PAYOUT_CAP_BREACH", res.Violation);
    }

    [Fact]
    public void Zero_gross_preview_is_structurally_valid() =>
        Assert.True(PrizeRules.CheckGuardrails(new[] { Rule(valueBps: 9500) }, 0, 0, 1500, 8500).Ok);

    // ── tier splitting (Build 1 prize semantics) ────────────────────────────

    [Fact]
    public void Floor_per_winner_remainder_stays_in_the_round()
    {
        Assert.Equal(new long[] { 333, 333, 333 }, PrizeRules.SplitTier(1_000, 3)); // 1 santim residual
        Assert.Equal(new long[] { 250, 250, 250, 250 }, PrizeRules.SplitTier(1_000, 4));
        Assert.Equal(new long[] { 3, 3 }, PrizeRules.SplitTier(7, 2));
    }

    // ── ledger account codes (FR-FIN-01) ────────────────────────────────────

    [Fact]
    public void Ledger_natural_balance_follows_the_account_type()
    {
        Assert.Equal(700L, LedgerCodes.NaturalBalance("LIABILITY", 300, 1000)); // credits − debits
        Assert.Equal(-700L, LedgerCodes.NaturalBalance("ASSET", 300, 1000));    // debits − credits
        Assert.Equal("PLAYER_WALLET:u1", LedgerCodes.PlayerWallet("u1"));
        Assert.Equal("ROUND_ESCROW:r1", LedgerCodes.RoundEscrow("r1"));
        Assert.Equal("HOUSE_REVENUE", LedgerCodes.HouseRevenue());
    }
}
