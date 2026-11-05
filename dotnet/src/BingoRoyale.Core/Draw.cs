using System.Text.Json;

namespace BingoRoyale.Core;

/// <summary>
/// Provably-fair draw pipeline (FR-GAME-04, FR-GAME-07, UC-06).
/// Lifecycle:
///   1. LOCK   — server generates serverSeed + salt, publishes commitment =
///               sha256(serverSeed + ":" + salt); clientSeedContribution =
///               sha256(sorted ticket ids) so players provably influence the
///               shuffle; seed sealed (AES-GCM) until completion.
///   2. DRAW   — balls produced by SeedRng shuffle (engine, 1 per tick).
///   3. REVEAL — on completion the seed and salt are published; anyone can
///               regenerate the exact sequence and the award table.
/// </summary>
public sealed record DrawCommitment(
    string Commitment,
    string ClientSeedContribution,
    string Salt,
    string ServerSeedSealed,
    int Nonce);

public sealed record RevealPayload(
    string Commitment,
    string ServerSeed,
    string Salt,
    string ClientSeedContribution,
    int Nonce,
    int[] DrawSequence);

public static class Draw
{
    public static DrawCommitment MakeCommitment(IReadOnlyList<string> sortedTicketIds)
    {
        string serverSeed = CryptoBox.SecureHex(32);
        string salt = CryptoBox.SecureHex(16);
        return new DrawCommitment(
            Commitment: CryptoBox.Sha256Hex($"{serverSeed}:{salt}"),
            ClientSeedContribution: CryptoBox.Sha256Hex(string.Join(",", sortedTicketIds)),
            Salt: salt,
            ServerSeedSealed: CryptoBox.AesEncrypt(serverSeed),
            Nonce: 0);
    }

    /// <summary>Full deterministic draw sequence (used by engine and verifier alike).</summary>
    public static int[] GenerateDrawSequence(
        string serverSeedHex, string salt, string clientSeedContribution, int nonce, string variantId)
    {
        var spec = GridSpecs.Get(variantId);
        var rng = new SeedRng(serverSeedHex, salt, clientSeedContribution, nonce);
        var universe = Enumerable.Range(1, spec.BallsTotal).ToArray();
        return rng.Shuffle(universe);
    }

    public static string OpenSealedSeed(string sealedSeed) => CryptoBox.AesDecrypt(sealedSeed);

    public static RevealPayload BuildReveal(
        string commitment, string clientSeedContribution, string salt, string serverSeedSealed, int nonce,
        string variantId)
    {
        string serverSeed = OpenSealedSeed(serverSeedSealed);
        int[] seq = GenerateDrawSequence(serverSeed, salt, clientSeedContribution, nonce, variantId);
        return new RevealPayload(commitment, serverSeed, salt, clientSeedContribution, nonce, seq);
    }

    /// <summary>Independent check: does the commitment bind (seed, salt)?</summary>
    public static bool CommitmentHolds(string commitment, string serverSeed, string salt) =>
        CryptoBox.Sha256Hex($"{serverSeed}:{salt}") == commitment;

    /// <summary>Input hash bound into the seal at resolution (FR-ADM-08 reveal).</summary>
    public static string BuildInputHash(string roomId, long grossSantim, long netPoolSantim, int ticketCount)
    {
        var payload = JsonDocument.Parse(
            $"{{\"grossSantim\":\"{grossSantim}\",\"netPoolSantim\":\"{netPoolSantim}\",\"roomId\":\"{JsonSerializerX.Escape(roomId)}\",\"tickets\":{ticketCount}}}").RootElement;
        return CryptoBox.HashPayload(payload.Clone());
    }
}
