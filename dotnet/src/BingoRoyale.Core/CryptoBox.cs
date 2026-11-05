using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace BingoRoyale.Core;

/// <summary>
/// Crypto primitives — phone encryption + blind index (FR-SEC-01), AES sealing
/// for fairness seeds (UC-06), canonical JSON hashing for maker-checker payload
/// binding (UC-08). Wire-format compatible with src/lib/crypto.ts:
///   · AES envelope = base64(iv).base64(tag).base64(ciphertext), key = sha256(APP_SECRET::aes)
///   · blind index  = HMAC-SHA256(key = sha256(APP_SECRET::blindidx), e164)
/// </summary>
public static class CryptoBox
{
    public const string DefaultAppSecret = "bingo-build1-demo-secret-do-not-use-in-prod";

    public static string AppSecret { get; set; } = DefaultAppSecret;

    private static byte[] DerivedKey(string suffix) =>
        SHA256.HashData(Encoding.UTF8.GetBytes($"{AppSecret}::{suffix}"));

    private static byte[] AesKey => DerivedKey("aes");
    private static byte[] BlindIdxKey => DerivedKey("blindidx");

    public static string Sha256Hex(string input) => Sha256Hex(Encoding.UTF8.GetBytes(input));

    public static string Sha256Hex(byte[] input) => Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant();

    public static byte[] HmacSha256(byte[] key, byte[] message)
    {
        using var h = new HMACSHA256(key);
        return h.ComputeHash(message);
    }

    /// <summary>
    /// Canonical JSON: sorted keys, stable separators — the hash-able form.
    /// Matches JavaScript JSON.stringify escaping (non-ASCII stays literal).
    /// </summary>
    public static string CanonicalJson(JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Null: return "null";
            case JsonValueKind.True: return "true";
            case JsonValueKind.False: return "false";
            case JsonValueKind.Number:
                return el.GetRawText();
            case JsonValueKind.String:
                return JsonQuote(el.GetString()!);
            case JsonValueKind.Array:
                return "[" + string.Join(",", el.EnumerateArray().Select(CanonicalJson)) + "]";
            case JsonValueKind.Object:
                var keys = el.EnumerateObject().Select(p => p.Name).OrderBy(k => k, StringComparer.Ordinal);
                return "{" + string.Join(",", keys.Select(k =>
                {
                    var prop = el.GetProperty(k);
                    return $"{JsonQuote(k)}:{CanonicalJson(prop)}";
                })) + "}";
            default:
                throw new InvalidOperationException("UNKNOWN_JSON_KIND");
        }
    }

    /// <summary>JavaScript JSON.stringify string escaping.</summary>
    public static string JsonQuote(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                default:
                    if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    public static string HashPayload(JsonElement payload) => Sha256Hex(CanonicalJson(payload));

    // ── AES-256-GCM envelope (key from APP_SECRET derivation) ───────────────

    public static string AesEncrypt(string plaintext)
    {
        byte[] iv = RandomNumberGenerator.GetBytes(12);
        byte[] plain = Encoding.UTF8.GetBytes(plaintext);
        byte[] cipher = new byte[plain.Length];
        byte[] tag = new byte[16];
        using (var gcm = new AesGcm(AesKey, 16))
            gcm.Encrypt(iv, plain, cipher, tag);
        return $"{Convert.ToBase64String(iv)}.{Convert.ToBase64String(tag)}.{Convert.ToBase64String(cipher)}";
    }

    public static string AesDecrypt(string envelope)
    {
        var parts = envelope.Split('.');
        byte[] iv = Convert.FromBase64String(parts[0]);
        byte[] tag = Convert.FromBase64String(parts[1]);
        byte[] cipher = Convert.FromBase64String(parts[2]);
        byte[] plain = new byte[cipher.Length];
        using (var gcm = new AesGcm(AesKey, 16))
            gcm.Decrypt(iv, cipher, tag, plain);
        return Encoding.UTF8.GetString(plain);
    }

    // ── Phone handling (UC-01) ──────────────────────────────────────────────

    /// <summary>Normalize Ethiopian phone input to E.164 +251. Accepts +2519…, 09…, 9…, 2519….</summary>
    public static string? NormalizeEthiopianPhone(string raw)
    {
        string digits = new(raw.Where(ch => !char.IsWhiteSpace(ch) && ch != '-' && ch != '(' && ch != ')').ToArray());
        string n;
        if (digits.StartsWith("+251")) n = digits[4..];
        else if (digits.StartsWith("251")) n = digits[3..];
        else if (digits.StartsWith("0")) n = digits[1..];
        else n = digits;
        // Ethiopian mobile prefixes
        bool ok = (n.Length == 9 && (n[0] == '9' || n[0] == '7')) && n.All(char.IsDigit);
        return ok ? $"+251{n}" : null;
    }

    public static string PhoneBlindIndex(string e164) =>
        Convert.ToHexString(HmacSha256(BlindIdxKey, Encoding.UTF8.GetBytes(e164))).ToLowerInvariant();

    public static string EncryptPhone(string e164) => AesEncrypt(e164);
    public static string DecryptPhone(string envelope) => AesDecrypt(envelope);

    // ── CSPRNG helpers (FR-GAME-02) ─────────────────────────────────────────

    /// <summary>Cryptographically secure random integer in [0, maxExclusive).</summary>
    public static int SecureRandomInt(int maxExclusive) => RandomNumberGenerator.GetInt32(maxExclusive);

    /// <summary>Cryptographically secure lowercase hex string of nBytes*2 characters.</summary>
    public static string SecureHex(int nBytes) =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(nBytes)).ToLowerInvariant();
}
