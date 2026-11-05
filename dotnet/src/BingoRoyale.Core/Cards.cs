using System.Security.Cryptography;

namespace BingoRoyale.Core;

/// <summary>
/// Card issuance (FR-GAME-02/03): CSPRNG with column-wise sampling without
/// replacement, honouring the variant grid. Cards are pure data — the same
/// functions render and validate on the client. The TS comparator jitter for
/// row assignment is replaced with an explicit least-filled-then-random pick
/// (the TS random comparator is non-deterministic by nature; the invariants —
/// 15 numbers, 5 per row, column ranges, top-down sorted — are identical and
/// are what the unit tests assert).
/// </summary>
public static class Cards
{
    private static int[] SampleDistinct(int min, int max, int count)
    {
        // Rejection sample into a set — ranges here are small (≤ 15) so
        // collisions are cheap to retry; the source of randomness is the CSPRNG.
        var picked = new HashSet<int>();
        while (picked.Count < count) picked.Add(min + RandomNumberGenerator.GetInt32(max - min + 1));
        return picked.OrderBy(x => x).ToArray();
    }

    private static void ShuffleList<T>(IList<T> list)
    {
        for (int i = list.Count - 1; i > 0; i--)
        {
            int j = RandomNumberGenerator.GetInt32(i + 1);
            (list[i], list[j]) = (list[j], list[i]);
        }
    }

    /// <summary>Generate one card for the variant as a grid of cells.</summary>
    public static (int?[][] Cells, string Fingerprint) GenerateCard(string variantId)
    {
        var spec = GridSpecs.Get(variantId);
        var cells = Grid.Empty(spec);

        if (spec.VariantId == "BALL_75")
        {
            // One column block at a time: 5 distinct numbers per column, centre free.
            for (int c = 0; c < spec.Cols; c++)
            {
                var range = spec.ColumnRanges[c];
                var nums = SampleDistinct(range[0], range[1], 5);
                int r = 0;
                for (int row = 0; row < spec.Rows; row++)
                {
                    if (Grid.IsFree(spec, row, c)) continue;
                    cells[row][c] = nums[r++];
                }
            }
        }
        else
        {
            // Column counts: col 0 and col 8 hold exactly 1; six of the middle seven
            // hold 2 → 1 + 6×2 + 1 + 1 = 15 numbers total.
            var counts = new int[9];
            Array.Fill(counts, 1);
            var middle = new List<int> { 1, 2, 3, 4, 5, 6, 7 };
            ShuffleList(middle);
            foreach (int c in middle.Take(6)) counts[c] = 2;

            // Row assignment — greedy least-filled with distinct rows per column.
            var rowFill = new int[3];
            var rowsOf = new List<int>[9];
            for (int i = 0; i < 9; i++) rowsOf[i] = new List<int>();
            var order = new List<int> { 0, 1, 2, 3, 4, 5, 6, 7, 8 };
            ShuffleList(order);
            foreach (int c in order)
            {
                var candidates = Enumerable.Range(0, 3)
                    .Where(r => !rowsOf[c].Contains(r))
                    .OrderBy(r => rowFill[r])
                    .ThenBy(_ => RandomNumberGenerator.GetInt32(int.MaxValue))
                    .ToArray();
                for (int k = 0; k < counts[c]; k++)
                {
                    int r = candidates[k];
                    rowsOf[c].Add(r);
                    rowFill[r]++;
                }
            }

            // Sample numbers per column and lay them top-down into their rows.
            for (int c = 0; c < 9; c++)
            {
                var range = spec.ColumnRanges[c];
                var nums = SampleDistinct(range[0], range[1], counts[c]);
                foreach (var (r, i) in rowsOf[c].OrderBy(x => x).Select((r, i) => (r, i)))
                    cells[r][c] = nums[i];
            }
        }

        return (cells, CardFingerprint(cells));
    }

    /// <summary>Canonical fingerprint (FR-GAME-02 generation trace): sha256 over the sorted number list.</summary>
    public static string CardFingerprint(int?[][] cells)
    {
        var nums = new List<int>();
        foreach (var row in cells)
            foreach (var n in row)
                if (n is not null) nums.Add(n.Value);
        nums.Sort();
        return CryptoBox.Sha256Hex(string.Join(",", nums));
    }

    /// <summary>Count of real numbers on a card (24 for 75-ball, 15 for 90-ball).</summary>
    public static int NumberCount(int?[][] cells) =>
        cells.Sum(row => row.Count(n => n is not null));

    /// <summary>Marked-state mask for a card given the called set (client render + claim checks).</summary>
    public static bool[][] DaubMask(int?[][] cells, IReadOnlySet<int> called, GridSpec spec) =>
        cells.Select((row, r) => row.Select((n, c) => n is null
            ? Grid.IsFree(spec, r, c)
            : called.Contains(n.Value)).ToArray()).ToArray();
}
