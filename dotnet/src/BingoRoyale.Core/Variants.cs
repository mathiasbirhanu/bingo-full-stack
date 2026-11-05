namespace BingoRoyale.Core;

/// <summary>
/// Variant grids (FR-GAME-01) — 75-ball and 90-ball are the two MVP variants;
/// 80-ball and 30-ball are refused while OD-05 remains open.
/// Grid representation (normative across cards, patterns and UI):
/// cells[row][col], null = blank (90-ball) or FREE square (75-ball centre).
/// </summary>
public sealed record GridSpec(
    string VariantId,
    int Rows,
    int Cols,
    int[][] ColumnRanges,
    int[][] FreeCells,
    int BallsTotal,
    int NumbersPerCard);

public static class GridSpecs
{
    public static readonly GridSpec Ball75 = new(
        "BALL_75", 5, 5,
        new[]
        {
            new[] { 1, 15 }, new[] { 16, 30 }, new[] { 31, 45 }, new[] { 46, 60 }, new[] { 61, 75 },
        },
        new[] { new[] { 2, 2 } },
        75, 24);

    public static readonly GridSpec Ball90 = new(
        "BALL_90", 3, 9,
        new[]
        {
            new[] { 1, 9 }, new[] { 10, 19 }, new[] { 20, 29 }, new[] { 30, 39 }, new[] { 40, 49 },
            new[] { 50, 59 }, new[] { 60, 69 }, new[] { 70, 79 }, new[] { 80, 90 },
        },
        Array.Empty<int[]>(),
        90, 15);

    public static readonly IReadOnlyList<GridSpec> All = new[] { Ball75, Ball90 };

    /// <summary>FR-GAME-01: refuse to enable any variant without a versioned spec (OD-05).</summary>
    public static GridSpec Get(string variantId) => variantId switch
    {
        "BALL_75" => Ball75,
        "BALL_90" => Ball90,
        _ => throw new InvalidOperationException($"VARIANT_NOT_ENABLED:{variantId}"),
    };
}

/// <summary>Cell grid: cells[row][col]; null = blank or free square.</summary>
public static class Grid
{
    public static int?[][] Empty(GridSpec spec) =>
        Enumerable.Range(0, spec.Rows).Select(_ => new int?[spec.Cols]).ToArray();

    public static bool IsFree(GridSpec spec, int row, int col) =>
        spec.FreeCells.Any(f => f[0] == row && f[1] == col);
}
