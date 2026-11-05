using System.Text;

namespace BingoRoyale.Core;

/// <summary>
/// Seeded deterministic stream RNG for provably-fair draws (FR-GAME-04, UC-06).
///
/// The draw sequence is fully determined by (serverSeed, salt, clientSeed,
/// nonce): HMAC-SHA256 keyed by the server seed over a counter message
/// produces an endless byte stream; NextInt uses rejection sampling so the
/// distribution is uniform (no modulo bias).
///
/// This port is BYTE-IDENTICAL to src/modules/game-core/rng.ts — proven by
/// RngParityTests with vectors generated from the TypeScript engine.
/// </summary>
public sealed class SeedRng
{
    private int _counter;
    private byte[] _buffer = Array.Empty<byte>();
    private int _offset;
    private readonly byte[] _key;

    public string ServerSeedHex { get; }
    public string Salt { get; }
    public string ClientSeedContribution { get; }
    public int Nonce { get; }

    public SeedRng(string serverSeedHex, string salt, string clientSeedContribution, int nonce)
    {
        ServerSeedHex = serverSeedHex;
        Salt = salt;
        ClientSeedContribution = clientSeedContribution;
        Nonce = nonce;
        // Key = raw bytes of (serverSeedHex + nonce as 8-char lowercase hex) —
        // exactly how the TypeScript engine derives it (padStart(8, "0")).
        _key = HexDecode(serverSeedHex + nonce.ToString("x8").PadLeft(8, '0'));
    }

    private void Refill()
    {
        string msg = $"{Salt}:{ClientSeedContribution}:{_counter}";
        _counter++;
        _buffer = CryptoBox.HmacSha256(_key, Encoding.UTF8.GetBytes(msg));
        _offset = 0;
    }

    private byte NextByte()
    {
        if (_offset >= _buffer.Length) Refill();
        return _buffer[_offset++];
    }

    /// <summary>Uniform integer in [0, maxExclusive) via rejection sampling.</summary>
    public int NextInt(int maxExclusive)
    {
        if (maxExclusive <= 0) throw new ArgumentOutOfRangeException(nameof(maxExclusive), "RNG_MAX_MUST_BE_POSITIVE");
        // Largest power-of-two-aligned multiple of max below 2^32, then reject above the fair ceiling.
        ulong limit = 0x1_0000_0000UL / (ulong)maxExclusive * (ulong)maxExclusive;
        for (;;)
        {
            uint value = ((uint)NextByte() << 24) | ((uint)NextByte() << 16) | ((uint)NextByte() << 8) | NextByte();
            if (value < limit) return (int)(value % (uint)maxExclusive);
        }
    }

    /// <summary>Fisher–Yates shuffle driven by the stream → the ball order itself.</summary>
    public T[] Shuffle<T>(IReadOnlyList<T> items)
    {
        var outArr = items.ToArray();
        for (int i = outArr.Length - 1; i > 0; i--)
        {
            int j = NextInt(i + 1);
            (outArr[i], outArr[j]) = (outArr[j], outArr[i]);
        }
        return outArr;
    }

    private static byte[] HexDecode(string hex)
    {
        if (hex.Length % 2 != 0) throw new FormatException("ODD_HEX_LENGTH");
        var bytes = new byte[hex.Length / 2];
        for (int i = 0; i < bytes.Length; i++)
            bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
        return bytes;
    }
}
