using System.Text.Json;

namespace BingoRoyale.Core;

public enum PatternKind { Cells, RowsMin, FullHouse }

/// <summary>
/// A pattern is data published through the maker-checker pipeline. Three kinds
/// cover the MVP catalogue: CELLS (75-ball lines, corners, X…), ROWS_MIN
/// (90-ball one line / two lines), FULL_HOUSE (blackout / full house).
/// </summary>
public sealed class PatternPayload
{
    public PatternKind Kind { get; init; }
    /// <summary>CELLS: fixed set of grid coordinates [row, col].</summary>
    public int?[][]? Cells { get; init; }
    /// <summary>ROWS_MIN: n distinct completed rows.</summary>
    public int? Rows { get; init; }

    public static PatternPayload MakeCells(int?[][] cells) => new() { Kind = PatternKind.Cells, Cells = cells };
    public static PatternPayload MakeRowsMin(int rows) => new() { Kind = PatternKind.RowsMin, Rows = rows };
    public static PatternPayload MakeFullHouse() => new() { Kind = PatternKind.FullHouse };

    /// <summary>Parse the TS-published JSON: {"kind":"CELLS","cells":[[r,c],…]} etc.</summary>
    public static PatternPayload FromJson(JsonElement el)
    {
        var kind = el.GetProperty("kind").GetString();
        return kind switch
        {
            "CELLS" => new PatternPayload
            {
                Kind = PatternKind.Cells,
                Cells = el.GetProperty("cells").EnumerateArray()
                    .Select(c => new int?[] { c[0].GetInt32(), c[1].GetInt32() })
                    .ToArray(),
            },
            "ROWS_MIN" => new PatternPayload { Kind = PatternKind.RowsMin, Rows = el.GetProperty("rows").GetInt32() },
            "FULL_HOUSE" => new PatternPayload { Kind = PatternKind.FullHouse },
            _ => throw new InvalidOperationException($"UNKNOWN_PATTERN_KIND:{kind}"),
        };
    }

    public JsonElement ToJsonElement() =>
        JsonDocument.Parse(ToJsonString()).RootElement.Clone();

    public string ToJsonString() => Kind switch
    {
        PatternKind.Cells => $"{{\"kind\":\"CELLS\",\"cells\":{JsonSerializerX.Serialize(Cells!)}}}",
        PatternKind.RowsMin => $"{{\"kind\":\"ROWS_MIN\",\"rows\":{Rows}}}",
        _ => "{\"kind\":\"FULL_HOUSE\"}",
    };
}

/// <summary>JSON helpers that match JavaScript JSON.stringify formatting for the payloads we use.</summary>
public static class JsonSerializerX
{
    public static string Serialize(int?[][] cells) =>
        "[" + string.Join(",", cells.Select(r =>
            "[" + string.Join(",", r.Select(n => n?.ToString() ?? "null")) + "]")) + "]";

    public static string Escape(string s)
    {
        var sb = new System.Text.StringBuilder();
        foreach (char ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        return sb.ToString();
    }
}

public record struct PatternCheck(bool Complete, string? Detail = null);
public record struct Validation(bool Valid, string? Violation = null);

/// <summary>
/// Patterns &amp; prize-shape evaluation (FR-GAME-08, FR-PRZ, UC-07 guardrails).
/// Port of src/modules/game-core/patterns.ts — behaviour-identical.
/// </summary>
public static class Patterns
{
    /// <summary>Validate a pattern payload against the variant grid (GR-01, FR-PRT-11).</summary>
    public static Validation ValidatePattern(string variantId, PatternPayload payload)
    {
        var spec = GridSpecs.Get(variantId);
        switch (payload.Kind)
        {
            case PatternKind.FullHouse:
                return new Validation(true);
            case PatternKind.RowsMin:
                if (payload.Rows is null || payload.Rows < 1 || payload.Rows > spec.Rows)
                    return new Validation(false, "ROWS_OUT_OF_GRID");
                return new Validation(true);
            case PatternKind.Cells:
                var cells = payload.Cells!;
                if (cells.Length == 0) return new Validation(false, "EMPTY_PATTERN");
                foreach (var cell in cells)
                {
                    int r = cell[0]!.Value, c = cell[1]!.Value;
                    if (r < 0 || r >= spec.Rows || c < 0 || c >= spec.Cols)
                        return new Validation(false, "CELL_OUT_OF_GRID");
                    if (Grid.IsFree(spec, r, c))
                        return new Validation(false, "CELL_IS_FREE_SQUARE"); // free cells cannot be required
                }
                return new Validation(true);
            default:
                return new Validation(false, "UNKNOWN_PATTERN_KIND");
        }
    }

    private static bool IsMarkedByCalled(GridSpec spec, int?[][] cells, IReadOnlySet<int> called, int r, int c)
    {
        int? n = cells[r][c];
        if (n is null) return spec.FreeCells.Any(f => f[0] == r && f[1] == c);
        return called.Contains(n.Value);
    }

    /// <summary>Is the pattern complete on the card given the called-ball set?</summary>
    public static PatternCheck IsPatternComplete(
        string variantId, int?[][] cells, IReadOnlySet<int> called, PatternPayload payload)
    {
        var spec = GridSpecs.Get(variantId);
        switch (payload.Kind)
        {
            case PatternKind.Cells:
                var all = payload.Cells!.All(cell => IsMarkedByCalled(spec, cells, called, cell[0]!.Value, cell[1]!.Value));
                return new PatternCheck(all);
            case PatternKind.RowsMin:
            {
                int done = 0;
                for (int r = 0; r < spec.Rows; r++)
                {
                    bool rowAll = true;
                    for (int c = 0; c < spec.Cols; c++)
                    {
                        int? n = cells[r][c];
                        if (n is not null && !called.Contains(n.Value)) { rowAll = false; break; }
                    }
                    if (rowAll) done++;
                }
                return new PatternCheck(done >= payload.Rows, $"{done} rows");
            }
            case PatternKind.FullHouse:
            {
                for (int r = 0; r < spec.Rows; r++)
                    for (int c = 0; c < spec.Cols; c++)
                    {
                        int? n = cells[r][c];
                        if (n is not null && !called.Contains(n.Value)) return new PatternCheck(false);
                    }
                return new PatternCheck(true);
            }
            default:
                return new PatternCheck(false);
        }
    }

    /// <summary>
    /// Claim window for pattern index (0-based) of count patterns on a deck of
    /// ballsTotal balls — the roll-up rule: a pattern nobody claims before its
    /// window closes folds its prize back into the pool, so every LATER
    /// pattern's tier amount grows. The final pattern never expires.
    /// Pure and unit-tested; the client mirrors it to render "closes at ball N".
    /// </summary>
    public static int PatternWindowSeq(int ballsTotal, int index, int count)
    {
        if (count <= 0) return ballsTotal;
        if (index >= count - 1) return ballsTotal; // the last pattern never rolls up
        long num = (long)ballsTotal * (index + 1);
        return (int)((num + count / 2) / count);   // exact Math.round for positive values
    }

    // ── Convenience constructors for the seeded catalogue ──────────────────

    public static PatternPayload Row75(int row) =>
        PatternPayload.MakeCells(Enumerable.Range(0, 5).Select(c => new int?[] { row, c }).ToArray());

    public static PatternPayload AnyColumn75(int col) =>
        PatternPayload.MakeCells(Enumerable.Range(0, 5).Select(r => new int?[] { r, col }).ToArray());

    public static PatternPayload FourCorners75() =>
        PatternPayload.MakeCells(new[] { new int?[] { 0, 0 }, new int?[] { 0, 4 }, new int?[] { 4, 0 }, new int?[] { 4, 4 } });

    /// <summary>8 outer X cells — the centre free square completes the X.</summary>
    public static PatternPayload X75() =>
        PatternPayload.MakeCells(new[]
        {
            new int?[] { 0, 0 }, new int?[] { 1, 1 }, new int?[] { 3, 3 }, new int?[] { 4, 4 },
            new int?[] { 4, 0 }, new int?[] { 3, 1 }, new int?[] { 1, 3 }, new int?[] { 0, 4 },
        });

    public static PatternPayload Blackout75() => PatternPayload.MakeFullHouse();
    public static PatternPayload Line90() => PatternPayload.MakeRowsMin(1);
    public static PatternPayload TwoLines90() => PatternPayload.MakeRowsMin(2);
    public static PatternPayload FullHouse90() => PatternPayload.MakeFullHouse();
}
