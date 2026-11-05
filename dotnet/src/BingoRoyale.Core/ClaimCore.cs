namespace BingoRoyale.Core;

/// <summary>
/// Player BINGO! claims — the manual-play path (UC-04, room.autoClaim = false).
/// Pure decision core, ported 1:1 from src/modules/engine/claim.ts:
///   · pickClaim pays the first OPEN pattern the caller completed (ruleset order);
///   · the caller must have DAUBED every pattern cell on the card they claim
///     with — per-card daubs; uncalled marks count for nothing (server truth);
///   · the tier then splits across EVERY ticket in the room completing it;
///   · closed tiers never pay twice; ROLLED-UP tiers never pay at all.
/// </summary>
public sealed class ClaimPatternDef
{
    public string EntityId { get; init; } = "";
    public string VersionId { get; init; } = "";
    public string Label { get; init; } = "";
    public PatternPayload Payload { get; init; } = PatternPayload.MakeFullHouse();
}

public sealed class RuleLite
{
    public string PatternRef { get; init; } = "";
    public string? Label { get; init; }
}

public sealed class CallerTicket
{
    public string TicketId { get; init; } = "";
    public int?[][] Cells { get; init; } = Array.Empty<int?[]>();
    /// <summary>The daubs the player actually tapped on THIS card.</summary>
    public IReadOnlySet<int> Daubed { get; init; } = new HashSet<int>();
}

public sealed class RoomTicket
{
    public string TicketId { get; init; } = "";
    public string PlayerId { get; init; } = "";
    public int?[][] Cells { get; init; } = Array.Empty<int?[]>();
}

public sealed class PickInput
{
    public string VariantId { get; init; } = "";
    /// <summary>Ruleset rules in payout order.</summary>
    public IReadOnlyList<RuleLite> Rules { get; init; } = Array.Empty<RuleLite>();
    public IReadOnlyList<ClaimPatternDef> Patterns { get; init; } = Array.Empty<ClaimPatternDef>();
    /// <summary>Pattern entityIds already paid this round.</summary>
    public IReadOnlySet<string> ClosedRules { get; init; } = new HashSet<string>();
    /// <summary>Pattern entityIds rolled up unclaimed (window expired) — never pay.</summary>
    public IReadOnlySet<string>? RolledRules { get; init; }
    public IReadOnlyList<CallerTicket> MyTickets { get; init; } = Array.Empty<CallerTicket>();
    /// <summary>Every ticket in the room (fair split across all completers).</summary>
    public IReadOnlyList<RoomTicket> AllTickets { get; init; } = Array.Empty<RoomTicket>();
    public IReadOnlySet<int> Called { get; init; } = new HashSet<int>();
}

public sealed record TierWinner(string TicketId, string PlayerId);
public sealed record BestHint(string Label, int Remaining);

public sealed class PickResult
{
    public ClaimPatternDef? Pattern { get; init; }
    public int RuleIndex { get; init; } = -1;
    public List<TierWinner> Winners { get; init; } = new();
    public BestHint? Best { get; init; }
}

public static class ClaimCore
{
    /// <summary>
    /// How many more marks a card needs to complete this pattern (0 = complete).
    /// marked overrides the called set — the caller's daubs (filtered to called)
    /// decide whether THEY completed the tier; other winners are checked against
    /// the called set (classic split fairness).
    /// </summary>
    public static int PatternRemaining(
        string variantId, int?[][] cells, IReadOnlySet<int> called, PatternPayload payload,
        IReadOnlySet<int>? marked = null)
    {
        var spec = GridSpecs.Get(variantId);
        IReadOnlySet<int> markedSet = marked ?? called;
        bool IsMarked(int r, int c)
        {
            int? n = (r < cells.Length && c < cells[r].Length) ? cells[r][c] : null;
            if (n is null) return spec.FreeCells.Any(f => f[0] == r && f[1] == c);
            return markedSet.Contains(n.Value);
        }
        switch (payload.Kind)
        {
            case PatternKind.Cells:
                return payload.Cells!.Count(cell => !IsMarked(cell[0]!.Value, cell[1]!.Value));
            case PatternKind.RowsMin:
            {
                int done = 0;
                for (int r = 0; r < spec.Rows; r++)
                {
                    bool rowAll = true;
                    for (int c = 0; c < spec.Cols; c++)
                    {
                        int? n = cells[r][c];
                        if (n is not null && !markedSet.Contains(n.Value)) { rowAll = false; break; }
                    }
                    if (rowAll) done++;
                }
                return Math.Max(0, (payload.Rows ?? 0) - done);
            }
            case PatternKind.FullHouse:
            {
                int missing = 0;
                foreach (var row in cells)
                    foreach (var n in row)
                        if (n is not null && !markedSet.Contains(n.Value)) missing++;
                return missing;
            }
            default:
                return int.MaxValue;
        }
    }

    /// <summary>
    /// First payable tier for the caller, in ruleset order, across the caller's
    /// own tickets. When nothing completes, returns the closest open pattern
    /// for a friendly "2 more for Top Line!" message.
    /// </summary>
    public static PickResult PickClaim(PickInput input)
    {
        var byEntity = input.Patterns.ToDictionary(p => p.EntityId);
        BestHint? best = null;

        for (int i = 0; i < input.Rules.Count; i++)
        {
            var rule = input.Rules[i];
            if (!byEntity.TryGetValue(rule.PatternRef, out var pattern)) continue;
            if (input.ClosedRules.Contains(pattern.EntityId)) continue;
            if (input.RolledRules is not null && input.RolledRules.Contains(pattern.EntityId)) continue;

            int myRemaining = int.MaxValue;
            foreach (var t in input.MyTickets)
            {
                // The caller's own marks: daubs ∩ called (server truth — an
                // uncalled daub counts for nothing), never another card's daubs.
                var marked = t.Daubed.Where(input.Called.Contains).ToHashSet();
                int rem = PatternRemaining(input.VariantId, t.Cells, input.Called, pattern.Payload, marked);
                if (rem < myRemaining) myRemaining = rem;
            }
            if (myRemaining == int.MaxValue) continue;
            if (myRemaining > 0)
            {
                if (best is null || myRemaining < best.Remaining)
                    best = new BestHint(pattern.Label, myRemaining);
                continue;
            }

            // The caller completed this tier → pay across every ticket in the
            // room that completes it at this same ball (split fairness, FR-PRZ).
            var winners = new List<TierWinner>();
            foreach (var t in input.AllTickets)
            {
                if (t.Cells.Length == 0) continue;
                if (Patterns.IsPatternComplete(input.VariantId, t.Cells, input.Called, pattern.Payload).Complete)
                    winners.Add(new TierWinner(t.TicketId, t.PlayerId));
            }
            if (winners.Count == 0) continue;
            return new PickResult { Pattern = pattern, RuleIndex = i, Winners = winners };
        }
        return new PickResult { Best = best };
    }
}
