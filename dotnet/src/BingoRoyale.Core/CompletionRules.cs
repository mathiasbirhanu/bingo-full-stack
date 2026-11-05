namespace BingoRoyale.Core;

/// <summary>
/// Manual-round completion decision (unit-tested): a round completes when
/// every tier is SETTLED (paid or rolled up), or every ball is drawn (auto
/// rooms instantly; manual rooms only after the claim grace window so a
/// last-second BINGO! can still land).
/// </summary>
public static class CompletionRules
{
    /// <summary>How long a manual room waits on the last ball for late BINGO! claims.</summary>
    public const long ClaimGraceMs = 20_000;

    public static bool ShouldCompleteRound(
        bool allBallsDrawn, bool allTiersSettled, bool autoClaim, long? lastBallCalledAt, long now)
    {
        if (allTiersSettled) return true;
        if (!allBallsDrawn) return false;
        if (autoClaim) return true;
        if (lastBallCalledAt is null) return true;
        return now - lastBallCalledAt.Value >= ClaimGraceMs;
    }
}
