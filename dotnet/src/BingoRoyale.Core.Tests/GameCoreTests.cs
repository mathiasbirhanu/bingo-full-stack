using System.Text.Json;
using BingoRoyale.Core;
using Xunit;

namespace BingoRoyale.Core.Tests;

/// <summary>
/// game-core unit tests — port of tests/game-core.test.ts.
/// SRS trace: FR-GAME-01..08, UC-01, UC-06, GR-01.
/// </summary>
public class GameCoreTests
{
    // ── phone normalization (UC-01) ─────────────────────────────────────────

    [Theory]
    [InlineData("0911234567", "+251911234567")]
    [InlineData("+251911234567", "+251911234567")]
    [InlineData("251-91-123-4567", "+251911234567")]
    [InlineData("0711234567", "+251711234567")]
    public void Normalizes_ethiopian_mobile_numbers_to_e164(string raw, string expected) =>
        Assert.Equal(expected, CryptoBox.NormalizeEthiopianPhone(raw));

    [Theory]
    [InlineData("12345")]
    [InlineData("0811234567")]
    [InlineData("")]
    public void Rejects_unknown_format_numbers_before_any_sms_is_sent(string raw) =>
        Assert.Null(CryptoBox.NormalizeEthiopianPhone(raw));

    // ── money (int64 santim) ────────────────────────────────────────────────

    [Fact]
    public void Etb_santim_round_trip()
    {
        Assert.Equal(1250L, Money.EtbToSantim("12.50"));
        Assert.Equal("12.50", Money.SantimToEtb(1250));
        Assert.Equal("1,234,567.89", Money.SantimToEtb(123456789));
    }

    [Fact]
    public void FloorBps_is_exact_int64_floor_commission_core()
    {
        Assert.Equal(150000L, Money.FloorBps(1_000_000, 1500)); // 10,000.00 ETB × 15% = 1,500.00
        Assert.Equal(149L, Money.FloorBps(999, 1500));           // floor(999×0.15)=149.85 → 149
        Assert.Equal(0L, Money.FloorBps(0, 3500));
    }

    // ── variants (FR-GAME-01) ───────────────────────────────────────────────

    [Fact]
    public void Mvp_variants_resolve_others_are_refused_while_od05_is_open()
    {
        Assert.Equal(75, GridSpecs.Get("BALL_75").BallsTotal);
        Assert.Equal(90, GridSpecs.Get("BALL_90").BallsTotal);
        var ex = Assert.Throws<InvalidOperationException>(() => GridSpecs.Get("BALL_80"));
        Assert.Contains("VARIANT_NOT_ENABLED", ex.Message);
    }

    // ── card issuance (FR-GAME-02/03) ───────────────────────────────────────

    [Fact]
    public void Ball75_card_has_24_numbers_column_ranges_and_centre_free()
    {
        var (cells, fingerprint) = Cards.GenerateCard("BALL_75");
        Assert.Equal(24, Cards.NumberCount(cells));
        Assert.Null(cells[2][2]); // free square
        for (int c = 0; c < 5; c++)
        {
            var range = GridSpecs.Ball75.ColumnRanges[c];
            for (int r = 0; r < 5; r++)
            {
                var n = cells[r][c];
                if (n is not null)
                    Assert.True(n >= range[0] && n <= range[1], $"cell[{r}][{c}]={n} outside [{range[0]},{range[1]}]");
            }
        }
        Assert.Equal(fingerprint, Cards.CardFingerprint(cells));
    }

    [Fact]
    public void Ball90_ticket_has_15_numbers_5_per_row_and_sorted_columns()
    {
        for (int i = 0; i < 50; i++)
        {
            var (cells, _) = Cards.GenerateCard("BALL_90");
            Assert.Equal(15, Cards.NumberCount(cells));
            for (int r = 0; r < 3; r++)
                Assert.Equal(5, cells[r].Count(n => n is not null));
            for (int c = 0; c < 9; c++)
            {
                var range = GridSpecs.Ball90.ColumnRanges[c];
                var colNums = cells.Select(row => row[c]).Where(n => n is not null).Select(n => n!.Value).ToList();
                Assert.All(colNums, n => Assert.True(n >= range[0] && n <= range[1]));
                // numbers within a column are top-down sorted
                Assert.Equal(colNums.OrderBy(x => x), colNums);
            }
        }
    }

    [Fact]
    public void Two_generated_cards_never_share_a_fingerprint_property_200_samples()
    {
        var seen = new HashSet<string>();
        for (int i = 0; i < 200; i++)
        {
            var (_, fingerprint) = Cards.GenerateCard(i % 2 == 0 ? "BALL_75" : "BALL_90");
            Assert.False(seen.Contains(fingerprint));
            seen.Add(fingerprint);
        }
    }

    // ── patterns (GR-01, UC-04) ─────────────────────────────────────────────

    [Fact]
    public void ValidatePattern_rejects_out_of_grid_cells_and_free_squares()
    {
        Assert.False(Patterns.ValidatePattern("BALL_75", PatternPayload.MakeCells(new[] { new int?[] { 5, 0 } })).Valid);
        Assert.Equal("CELL_IS_FREE_SQUARE",
            Patterns.ValidatePattern("BALL_75", PatternPayload.MakeCells(new[] { new int?[] { 2, 2 } })).Violation);
        Assert.True(Patterns.ValidatePattern("BALL_75", Patterns.Row75(0)).Valid);
        Assert.False(Patterns.ValidatePattern("BALL_90", PatternPayload.MakeRowsMin(4)).Valid);
    }

    [Fact]
    public void Row_completion_tracks_called_balls()
    {
        var (cells, _) = Cards.GenerateCard("BALL_75");
        var row0 = cells[0].Where(n => n is not null).Select(n => n!.Value).ToHashSet(); // top row has no free square
        Assert.True(Patterns.IsPatternComplete("BALL_75", cells, row0, Patterns.Row75(0)).Complete);
        Assert.False(Patterns.IsPatternComplete("BALL_75", cells, new HashSet<int>(), Patterns.Row75(0)).Complete);
    }

    [Fact]
    public void X_pattern_completes_via_the_free_centre()
    {
        var (cells, _) = Cards.GenerateCard("BALL_75");
        var x = Patterns.X75();
        var needed = new HashSet<int>();
        foreach (var cell in x.Cells!)
        {
            var n = cells[cell[0]!.Value][cell[1]!.Value];
            if (n is not null) needed.Add(n.Value);
        }
        Assert.True(Patterns.IsPatternComplete("BALL_75", cells, needed, x).Complete);
    }

    [Fact]
    public void Ball90_rows_min_logic()
    {
        var (cells, _) = Cards.GenerateCard("BALL_90");
        var row0 = cells[0].Where(n => n is not null).Select(n => n!.Value).ToHashSet();
        Assert.True(Patterns.IsPatternComplete("BALL_90", cells, row0, Patterns.Line90()).Complete);
        Assert.False(Patterns.IsPatternComplete("BALL_90", cells, row0, Patterns.TwoLines90()).Complete);
        var all = cells.SelectMany(r => r).Where(n => n is not null).Select(n => n!.Value).ToHashSet();
        Assert.True(Patterns.IsPatternComplete("BALL_90", cells, all, Patterns.FullHouse90()).Complete);
    }

    [Fact]
    public void Daub_mask_marks_called_numbers_and_free_squares()
    {
        var (cells, _) = Cards.GenerateCard("BALL_75");
        var mask = Cards.DaubMask(cells, new HashSet<int>(), GridSpecs.Ball75);
        Assert.True(mask[2][2]); // free centre pre-marked
        Assert.Equal(1, mask.SelectMany(r => r).Count(m => m));
    }

    // ── payload JSON interop with the TS-published config ───────────────────

    [Fact]
    public void Parses_pattern_payload_json_published_by_the_ts_maker_checker()
    {
        var cells = PatternPayload.FromJson(JsonDocument.Parse("{\"kind\":\"CELLS\",\"cells\":[[0,0],[0,4],[4,0],[4,4]]}").RootElement);
        Assert.Equal(PatternKind.Cells, cells.Kind);
        Assert.Equal(4, cells.Cells!.Length);

        var rows = PatternPayload.FromJson(JsonDocument.Parse("{\"kind\":\"ROWS_MIN\",\"rows\":2}").RootElement);
        Assert.Equal(2, rows.Rows);

        var fh = PatternPayload.FromJson(JsonDocument.Parse("{\"kind\":\"FULL_HOUSE\"}").RootElement);
        Assert.Equal(PatternKind.FullHouse, fh.Kind);
    }

    [Fact]
    public void Parses_ruleset_json_published_by_the_ts_maker_checker()
    {
        var ruleset = RulesetPayload.FromJson(JsonDocument.Parse(
            "{\"rules\":[" +
            "{\"patternRef\":\"p1\",\"awardType\":\"PERCENT_NET_POOL\",\"valueBps\":4000}," +
            "{\"patternRef\":\"p2\",\"awardType\":\"FIXED\",\"valueSantim\":\"150000\"}]}").RootElement);
        Assert.Equal(2, ruleset.Rules.Count);
        Assert.Equal(4000, ruleset.Rules[0].ValueBps);
        Assert.Equal(150000L, ruleset.Rules[1].ValueSantim);
        Assert.True(PrizeRules.ValidateRulesetShape(ruleset).Valid);
    }
}
