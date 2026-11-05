using BingoRoyale.Core;
using Xunit;

namespace BingoRoyale.Core.Tests;

/// <summary>
/// Manual BINGO! claim tests — port of tests/claim.test.ts (the pure decision
/// core of the engine): per-card daubs enforced, uncalled marks worthless,
/// rolled-up tiers never pay, tie split across all completers, window ladder,
/// manual-round grace window.
/// </summary>
public class ClaimTests
{
    private const string Caller = "player-A";
    private const string Other = "player-B";

    /// <summary>5×5 with 1..25 laid row-wise, centre (2,2) free.</summary>
    private static int?[][] Cells75()
    {
        var grid = new int?[5][];
        int n = 1;
        for (int r = 0; r < 5; r++)
        {
            var row = new int?[5];
            for (int c = 0; c < 5; c++) row[c] = n++;
            grid[r] = row;
        }
        grid[2][2] = null;
        return grid;
    }

    /// <summary>Daub every card number that is in called — the honest client behaviour.</summary>
    private static HashSet<int> DaubCalled(int?[][] cells, IReadOnlySet<int> called)
    {
        var outSet = new HashSet<int>();
        foreach (var row in cells)
            foreach (var n in row)
                if (n is not null && called.Contains(n.Value)) outSet.Add(n.Value);
        return outSet;
    }

    private static ClaimPatternDef Def(string id, PatternPayload payload, string? label = null) =>
        new() { EntityId = id, VersionId = $"v-{id}", Label = label ?? id, Payload = payload };

    private static PickInput BaseInput(
        IReadOnlySet<int>? called = null,
        IReadOnlyList<RuleLite>? rules = null,
        IReadOnlyList<ClaimPatternDef>? patterns = null,
        IReadOnlySet<string>? closedRules = null,
        IReadOnlySet<string>? rolledRules = null,
        IReadOnlyList<CallerTicket>? myTickets = null,
        IReadOnlyList<RoomTicket>? allTickets = null)
    {
        var c = called ?? new HashSet<int> { 1, 2, 3, 4, 5 };
        return new PickInput
        {
            VariantId = "BALL_75",
            Rules = rules ?? new List<RuleLite> { new() { PatternRef = "topline" } },
            Patterns = patterns ?? new List<ClaimPatternDef> { Def("topline", Patterns.Row75(0), "Top Line") },
            ClosedRules = closedRules ?? new HashSet<string>(),
            RolledRules = rolledRules,
            MyTickets = myTickets ?? new List<CallerTicket>
            {
                new() { TicketId = "t-A", Cells = Cells75(), Daubed = DaubCalled(Cells75(), c) },
            },
            AllTickets = allTickets ?? new List<RoomTicket>
            {
                new() { TicketId = "t-A", PlayerId = Caller, Cells = Cells75() },
            },
            Called = c,
        };
    }

    [Fact]
    public void Complete_tier_caller_wins_and_splits_with_every_completing_ticket()
    {
        var res = ClaimCore.PickClaim(BaseInput(
            allTickets: new List<RoomTicket>
            {
                new() { TicketId = "t-A", PlayerId = Caller, Cells = Cells75() },
                new() { TicketId = "t-B", PlayerId = Other, Cells = Cells75() },
            }));
        Assert.NotNull(res.Pattern);
        Assert.Equal("topline", res.Pattern!.EntityId);
        Assert.Equal(2, res.Winners.Count);
        Assert.Equal(new[] { Caller, Other }.OrderBy(x => x), res.Winners.Select(w => w.PlayerId).OrderBy(x => x));
    }

    [Fact]
    public void One_number_short_not_yet_with_honest_remaining_hint()
    {
        var res = ClaimCore.PickClaim(BaseInput(called: new HashSet<int> { 1, 2, 3, 4 }));
        Assert.Null(res.Pattern);
        Assert.Equal(new BestHint("Top Line", 1), res.Best);
    }

    [Fact]
    public void Caller_did_not_complete_others_completions_are_not_claimed_by_them()
    {
        // Caller holds a card with a different top row; another player completed the line.
        var mine = Cells75();
        mine[0] = new int?[] { 51, 52, 53, 54, 55 };
        var res = ClaimCore.PickClaim(BaseInput(
            myTickets: new List<CallerTicket>
            {
                new() { TicketId = "t-A", Cells = mine, Daubed = DaubCalled(mine, new HashSet<int> { 1, 2, 3, 4, 5 }) },
            }));
        Assert.Null(res.Pattern);
    }

    [Fact]
    public void Closed_tier_is_skipped_next_open_pattern_pays()
    {
        var res = ClaimCore.PickClaim(BaseInput(
            rules: new List<RuleLite> { new() { PatternRef = "topline" }, new() { PatternRef = "corners" } },
            patterns: new List<ClaimPatternDef>
            {
                Def("topline", Patterns.Row75(0), "Top Line"),
                Def("corners", Patterns.FourCorners75(), "Four Corners"),
            },
            closedRules: new HashSet<string> { "topline" },
            called: new HashSet<int> { 1, 5, 21, 25 })); // corners complete; topline complete but closed
        Assert.NotNull(res.Pattern);
        Assert.Equal("corners", res.Pattern!.EntityId);
    }

    [Fact]
    public void Rolled_up_tier_never_pays_window_expired_unclaimed()
    {
        var res = ClaimCore.PickClaim(BaseInput(
            rolledRules: new HashSet<string> { "topline" },
            called: new HashSet<int> { 1, 2, 3, 4, 5 }));
        Assert.Null(res.Pattern);
    }

    [Fact]
    public void Per_card_daubs_tier_does_not_pay_unless_caller_daubed_every_pattern_cell()
    {
        // Called covers the top line, but the caller only tapped 1,2,3 on THIS card.
        var res = ClaimCore.PickClaim(BaseInput(
            myTickets: new List<CallerTicket>
            {
                new() { TicketId = "t-A", Cells = Cells75(), Daubed = new HashSet<int> { 1, 2, 3 } },
            }));
        Assert.Null(res.Pattern);
        Assert.Equal(new BestHint("Top Line", 2), res.Best);
    }

    [Fact]
    public void Uncalled_daubs_count_for_nothing_server_truth_no_fake_marks()
    {
        var daubed = new HashSet<int> { 1, 2, 3, 4, 5, 99 }; // 99 was never called
        var res = ClaimCore.PickClaim(BaseInput(
            myTickets: new List<CallerTicket> { new() { TicketId = "t-A", Cells = Cells75(), Daubed = daubed } }));
        // Top line still pays — the valid daubs cover it; the fake mark is ignored.
        Assert.NotNull(res.Pattern);
        Assert.Equal("topline", res.Pattern!.EntityId);
    }

    [Fact]
    public void Daubs_are_per_card_card_B_daubs_cannot_win_card_A_tier()
    {
        // Caller holds two cards; only card B is fully daubed — card A misses the line.
        var res = ClaimCore.PickClaim(BaseInput(
            myTickets: new List<CallerTicket>
            {
                new() { TicketId = "t-A", Cells = Cells75(), Daubed = new HashSet<int> { 1, 2, 3 } }, // short
                new() { TicketId = "t-B", Cells = Cells75(), Daubed = DaubCalled(Cells75(), new HashSet<int> { 1, 2, 3, 4, 5 }) },
            }));
        // Card B completed it honestly → the tier pays (best card wins).
        Assert.NotNull(res.Pattern);
        Assert.Equal("topline", res.Pattern!.EntityId);

        // …but a caller with ONLY the short card cannot claim on card B's marks:
        var solo = ClaimCore.PickClaim(BaseInput(
            myTickets: new List<CallerTicket>
            {
                new() { TicketId = "t-A", Cells = Cells75(), Daubed = new HashSet<int> { 1, 2, 3 } },
            }));
        Assert.Null(solo.Pattern);
    }

    [Fact]
    public void PatternRemaining_cells_rowsmin_fullhouse()
    {
        var cells = Cells75();
        Assert.Equal(1, ClaimCore.PatternRemaining("BALL_75", cells, new HashSet<int> { 1, 2, 3, 4 }, Patterns.Row75(0)));
        Assert.Equal(0, ClaimCore.PatternRemaining("BALL_75", cells, new HashSet<int> { 1, 2, 3, 4, 5 }, Patterns.Row75(0)));

        // Free centre completes the X — need the 8 outer X cells.
        var x = Patterns.X75();
        var xNumbers = x.Cells!.Select(cell => cells[cell[0]!.Value][cell[1]!.Value]!.Value).ToList();
        var four = xNumbers.Take(4).ToHashSet();
        Assert.Equal(xNumbers.Count - 4, ClaimCore.PatternRemaining("BALL_75", cells, four, x));
        Assert.Equal(23, ClaimCore.PatternRemaining("BALL_75", cells, new HashSet<int> { 1 }, Patterns.Blackout75()));
    }

    [Fact]
    public void PatternRemaining_with_daub_marks_free_square_completes_the_X_even_undaubed()
    {
        var cells = Cells75(); // centre (2,2) free
        var x = Patterns.X75();
        var xNumbers = x.Cells!.Select(cell => cells[cell[0]!.Value][cell[1]!.Value]!.Value).ToList();

        // All 8 outer X numbers daubed (and called) → remaining 0 via the free square.
        var all = xNumbers.ToHashSet();
        Assert.Equal(0, ClaimCore.PatternRemaining("BALL_75", cells, all, x, all));

        // Marked set missing one outer cell → 1 remaining even though called covers all.
        var seven = xNumbers.Skip(1).ToHashSet();
        Assert.Equal(1, ClaimCore.PatternRemaining("BALL_75", cells, all, x, seven));
    }

    // ── patternWindowSeq (roll-up ladder) ───────────────────────────────────

    [Fact]
    public void Window_ladder_75_ball_4_tiers_is_19_38_56_75_and_last_never_expires()
    {
        Assert.Equal(19, Patterns.PatternWindowSeq(75, 0, 4));
        Assert.Equal(38, Patterns.PatternWindowSeq(75, 1, 4));
        Assert.Equal(56, Patterns.PatternWindowSeq(75, 2, 4));
        Assert.Equal(75, Patterns.PatternWindowSeq(75, 3, 4));
    }

    [Fact]
    public void Window_ladder_90_ball_3_tiers_is_30_60_90()
    {
        Assert.Equal(30, Patterns.PatternWindowSeq(90, 0, 3));
        Assert.Equal(60, Patterns.PatternWindowSeq(90, 1, 3));
        Assert.Equal(90, Patterns.PatternWindowSeq(90, 2, 3));
    }

    [Fact]
    public void Degenerate_window_inputs_never_expire()
    {
        Assert.Equal(75, Patterns.PatternWindowSeq(75, 0, 1));
        Assert.Equal(75, Patterns.PatternWindowSeq(75, 0, 0));
    }

    // ── shouldCompleteRound (manual grace) ──────────────────────────────────

    [Fact]
    public void All_tiers_settled_completes_immediately_even_mid_deck()
    {
        long last = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 5_000;
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Assert.True(CompletionRules.ShouldCompleteRound(false, true, true, last, now));
        Assert.True(CompletionRules.ShouldCompleteRound(false, true, false, last, now));
    }

    [Fact]
    public void Auto_room_last_ball_completes_now()
    {
        long last = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 5_000;
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Assert.True(CompletionRules.ShouldCompleteRound(true, false, true, last, now));
    }

    [Fact]
    public void Manual_room_last_ball_waits_the_grace_window_for_late_bingo_claims()
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long last = now - 5_000;
        Assert.False(CompletionRules.ShouldCompleteRound(true, false, false, last, now));
        Assert.True(CompletionRules.ShouldCompleteRound(true, false, false, now - 21_000, now));
    }

    [Fact]
    public void Balls_still_in_the_drum_keeps_drawing()
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long last = now - 5_000;
        Assert.False(CompletionRules.ShouldCompleteRound(false, false, false, last, now));
    }
}
