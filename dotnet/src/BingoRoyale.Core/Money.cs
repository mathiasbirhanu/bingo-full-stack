namespace BingoRoyale.Core;

/// <summary>
/// Money — int64 santim arithmetic (SRS §1.4: "ETB with santim minor unit,
/// int64"). No floats, no doubles, floor-only division. Serializes to string
/// across the API.
/// </summary>
public static class Money
{
    /// <summary>Parse a decimal ETB string like "12.50" into 1250 santim.</summary>
    public static long EtbToSantim(string etb)
    {
        var s = etb.Trim();
        bool neg = s.StartsWith("-");
        string body = neg ? s[1..] : s;
        var parts = body.Split('.');
        string whole = parts[0], frac = parts.Length > 1 ? parts[1] : "";
        if (whole.Length == 0 || whole.Any(ch => !char.IsDigit(ch)))
            throw new FormatException($"INVALID_MONEY:{s}");
        if (frac.Length > 2 || frac.Any(ch => !char.IsDigit(ch)))
            throw new FormatException($"INVALID_MONEY:{s}");
        string padded = (frac + "00")[..2];
        long v = long.Parse(whole) * 100L + long.Parse(padded);
        return neg ? -v : v;
    }

    /// <summary>Format santim as an ETB display string "1,234.56".</summary>
    public static string SantimToEtb(long s)
    {
        bool neg = s < 0;
        ulong abs = (ulong)(neg ? -s : s);
        ulong whole = abs / 100, frac = abs % 100;
        string grouped = whole.ToString("N0", new System.Globalization.CultureInfo("en-US"));
        return $"{(neg ? "-" : "")}{grouped}.{frac:D2}";
    }

    /// <summary>floor(a × bps / 10000) in exact int64 arithmetic — commission core (UC-15).</summary>
    public static long FloorBps(long amount, int bps)
    {
        if (bps < 0) throw new ArgumentException("INVALID_BPS");
        return checked(amount * bps) / 10000L;
    }

    public static long Sum(IEnumerable<long> values) => values.Aggregate(0L, (a, b) => a + b);
}
