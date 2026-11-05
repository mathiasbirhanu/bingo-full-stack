using BingoRoyale.Core;
using Xunit;

namespace BingoRoyale.Core.Tests;

/// <summary>
/// TS↔C# engine parity — the heart of the port. Vectors below were generated
/// FROM the TypeScript engine (scripts/dotnet-vectors.ts) using the real
/// modules. The C# SeedRng must reproduce the exact same ball sequences,
/// byte-for-byte, so a .NET engine runs the same provably-fair pipeline.
/// </summary>
public class RngParityTests
{
    private const string Seed = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Salt = "deadbeef";
    private const string Client = "cafe";

    private static readonly int[] Seq90First12 = { 27, 34, 73, 85, 58, 63, 42, 78, 90, 49, 32, 82 };
    private const string Seq90Sha256 = "31ce4fbb37bf23220b69f8dbbc921a829febe5ca8a8074bf6ff55297e0d294fc";
    private static readonly int[] Seq75First12 = { 15, 54, 47, 12, 66, 14, 21, 61, 39, 26, 10, 36 };
    private const string Seq75Sha256 = "c24a8458f07c7797fafeba80c08bc7c255bfd140ef36beaba5dd3b11adc1ec4b";
    private static readonly int[] Seq75Nonce1First6 = { 75, 39, 42, 47, 7, 25 };
    private static readonly int[] Seq75ClientXFirst6 = { 4, 32, 46, 37, 34, 30 };
    private const string TsEnvelope = "eeW4bYt52pbamCFB.Ih++9DKHIRj9bgI3UBYTtg==.zp9zq2mmQ01UxNUkB9pIKLYq9tY7HYsC+9yK";

    [Fact]
    public void Ball90_sequence_matches_the_TypeScript_engine_exactly()
    {
        int[] seq = Draw.GenerateDrawSequence(Seed, Salt, Client, 0, "BALL_90");
        Assert.Equal(Seq90First12, seq[..12]);
        Assert.Equal(Seq90Sha256, CryptoBox.Sha256Hex("[" + string.Join(",", seq) + "]"));
    }

    [Fact]
    public void Ball75_sequence_matches_the_TypeScript_engine_exactly()
    {
        int[] seq = Draw.GenerateDrawSequence(Seed, Salt, Client, 0, "BALL_75");
        Assert.Equal(Seq75First12, seq[..12]);
        Assert.Equal(Seq75Sha256, CryptoBox.Sha256Hex("[" + string.Join(",", seq) + "]"));
    }

    [Fact]
    public void Nonce_changes_the_sequence_exactly_like_the_TS_engine()
    {
        int[] a = Draw.GenerateDrawSequence(Seed, Salt, Client, 0, "BALL_75");
        int[] b = Draw.GenerateDrawSequence(Seed, Salt, Client, 1, "BALL_75");
        Assert.Equal(Seq75Nonce1First6, b[..6]);
        Assert.NotEqual(a[..6], b[..6]);
    }

    [Fact]
    public void Client_contribution_changes_the_sequence_exactly_like_the_TS_engine()
    {
        int[] a = Draw.GenerateDrawSequence(Seed, Salt, Client, 0, "BALL_75");
        int[] c = Draw.GenerateDrawSequence(Seed, Salt, Client + "x", 0, "BALL_75");
        Assert.Equal(Seq75ClientXFirst6, c[..6]);
        Assert.NotEqual(a[..6], c[..6]);
    }

    [Fact]
    public void Is_a_full_permutation_with_no_repeats()
    {
        int[] seq = Draw.GenerateDrawSequence(Seed, Salt, Client, 0, "BALL_90");
        Assert.Equal(90, seq.Length);
        Assert.Equal(90, seq.Distinct().Count());
        Assert.Equal(1, seq.Min());
        Assert.Equal(90, seq.Max());
    }

    [Fact]
    public void Deterministic_same_inputs_regenerate_the_exact_sequence()
    {
        int[] a = Draw.GenerateDrawSequence(Seed, Salt, Client, 0, "BALL_90");
        int[] b = Draw.GenerateDrawSequence(Seed, Salt, Client, 0, "BALL_90");
        Assert.Equal(a, b);
    }

    [Fact]
    public void Decrypts_an_envelope_sealed_by_the_TypeScript_engine()
    {
        Assert.Equal("parity-vector-plaintext-123", CryptoBox.AesDecrypt(TsEnvelope));
    }

    [Fact]
    public void Csharp_sealed_envelope_round_trips()
    {
        string envelope = CryptoBox.AesEncrypt("roundtrip-✓-42");
        Assert.Equal("roundtrip-✓-42", CryptoBox.AesDecrypt(envelope));
    }

    [Fact]
    public void Commitment_binds_seed_and_salt()
    {
        string serverSeed = "11".Repeat(32), salt = "22".Repeat(16);
        string commitment = "4d54e49507b7dd06ddad2026de5dcc8a2cd46219a118be4e41c3dde6fd29355b";
        Assert.True(Draw.CommitmentHolds(commitment, serverSeed, salt));
        Assert.False(Draw.CommitmentHolds(commitment, serverSeed, "ff".Repeat(16)));
        Assert.False(Draw.CommitmentHolds("", "", ""));
    }
}

public static class TestExtensions
{
    public static string Repeat(this string s, int n) => string.Concat(Enumerable.Repeat(s, n));
}
