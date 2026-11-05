using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using BingoRoyale.Api.Data;
using BingoRoyale.Api.Domain;
using BingoRoyale.Api.Services;
using BingoRoyale.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

namespace BingoRoyale.Api.Infrastructure;

public record SessionClaimsDto(string Sub, string Role, string? TenantId, string PhoneIdx);
public record UserDto(string Id, string Role, string? TenantId, string MaskedPhone);

/// <summary>
/// Session &amp; tokens (UC-01) — port of lib/auth.ts + authn/session.ts.
/// Access token: JWT HS256, 10 minutes (key = APP_SECRET bytes, issuer
/// "bingo-platform", audience "bingo-app" — the exact TS claims). Refresh
/// token: opaque 64-hex secret, stored SHA-256-hashed, rotating, 14 days,
/// delivered as httpOnly cookies bg_at / bg_rt.
/// </summary>
public class AuthService(AppDbContext db, LedgerService ledger, IConfiguration config)
{
    public const string AccessCookie = "bg_at";
    public const string RefreshCookie = "bg_rt";
    public const string JwtIssuer = "bingo-platform";
    public const string JwtAudience = "bingo-app";
    public const int AccessTokenTtlSec = 10 * 60;
    public const int RefreshTokenTtlSec = 14 * 24 * 60 * 60;
    public const int OtpTtlSec = 5 * 60;

    private string AppSecret => config["APP_SECRET"] ?? CryptoBox.DefaultAppSecret;

    private readonly Dictionary<string, List<long>> _otpAttempts = new();
    private readonly object _otpLock = new();

    public string IssueAccessToken(SessionClaimsDto claims)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(AppSecret));
        var token = new JwtSecurityToken(
            issuer: JwtIssuer,
            audience: JwtAudience,
            claims: new List<System.Security.Claims.Claim>
            {
                new(System.Security.Claims.ClaimTypes.NameIdentifier, claims.Sub),
                new("role", claims.Role),
                new("tenantId", claims.TenantId ?? ""),
                new("phoneIdx", claims.PhoneIdx),
            },
            notBefore: DateTime.UtcNow,
            expires: DateTime.UtcNow.AddSeconds(AccessTokenTtlSec),
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    public SessionClaimsDto? VerifyAccessToken(string token)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(AppSecret));
        var handler = new JwtSecurityTokenHandler();
        try
        {
            var principal = handler.ValidateToken(token, new TokenValidationParameters
            {
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = key,
                ValidIssuer = JwtIssuer,
                ValidAudience = JwtAudience,
                ValidateIssuer = true,
                ValidateAudience = true,
                ClockSkew = TimeSpan.FromSeconds(5),
            }, out _);
            var sub = principal.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
                      ?? principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (sub is null) return null;
            string? tenantId = principal.FindFirst("tenantId")?.Value;
            return new SessionClaimsDto(sub,
                principal.FindFirst("role")?.Value ?? "PLAYER",
                string.IsNullOrEmpty(tenantId) ? null : tenantId,
                principal.FindFirst("phoneIdx")?.Value ?? "");
        }
        catch
        {
            return null;
        }
    }

    private static (string Raw, string Hash) CreateRefreshToken()
    {
        string raw = CryptoBox.SecureHex(32);
        return (raw, CryptoBox.Sha256Hex(raw));
    }

    /// <summary>Issue an OTP for a normalized phone number (UC-01 main flow).</summary>
    public async Task<(bool Sent, string? DemoCode, string Phone)> RequestOtpAsync(string rawPhone)
    {
        var phone = CryptoBox.NormalizeEthiopianPhone(rawPhone)
            ?? throw new ApiError("INVALID_PHONE", "unknown-format number rejected before any SMS is sent");
        var idx = CryptoBox.PhoneBlindIndex(phone);
        RateLimit(idx);

        string code = CryptoBox.SecureHex(3); // 6 hex chars, 5-minute validity
        db.OtpCodes.Add(new OtpCode
        {
            Id = Ids.New(),
            PhoneIdx = idx,
            CodeHash = CryptoBox.Sha256Hex($"{code}:{idx}"),
            ExpiresAt = DateTime.UtcNow.AddSeconds(OtpTtlSec),
        });
        await db.SaveChangesAsync();
        // SMS port adapter (demo): log + return the code in the DEMO envelope.
        return (true, code, phone);
    }

    private void RateLimit(string phoneIdx)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        lock (_otpLock)
        {
            if (!_otpAttempts.TryGetValue(phoneIdx, out var hits))
                _otpAttempts[phoneIdx] = hits = new List<long>();
            hits.RemoveAll(t => now - t < 60_000);
            if (hits.Count >= 5) throw new ApiError("RATE_LIMITED", "5 OTP requests per minute maximum");
            hits.Add(now);
        }
    }

    public async Task<UserDto> VerifyOtpAndLoginAsync(HttpContext http, string rawPhone, string code, string? userAgent)
    {
        var phone = CryptoBox.NormalizeEthiopianPhone(rawPhone);
        if (phone is null || string.IsNullOrEmpty(code)) throw new ApiError("INVALID_OR_EXPIRED_OTP");
        var idx = CryptoBox.PhoneBlindIndex(phone);
        string canonical = code.Trim().ToLowerInvariant();

        var otp = await db.OtpCodes
            .Where(o => o.PhoneIdx == idx && o.ConsumedAt == null && o.ExpiresAt > DateTime.UtcNow)
            .OrderByDescending(o => o.CreatedAt)
            .FirstOrDefaultAsync();
        if (otp is null || otp.CodeHash != CryptoBox.Sha256Hex($"{canonical}:{idx}"))
        {
            if (otp is not null) { otp.Attempts++; await db.SaveChangesAsync(); }
            throw new ApiError("INVALID_OR_EXPIRED_OTP");
        }
        otp.ConsumedAt = DateTime.UtcNow;

        var user = await db.Users.FirstOrDefaultAsync(u => u.PhoneBlindIdx == idx);
        if (user is not null && user.Status != "ACTIVE")
            throw new ApiError("BLOCKED", user.StatusReason ?? "account blocked");
        if (user is null)
        {
            user = new User
            {
                Id = Ids.New(),
                PhoneE164 = CryptoBox.EncryptPhone(phone),
                PhoneBlindIdx = idx,
                Role = "PLAYER",
            };
            db.Users.Add(user);
        }
        user.LastLoginAt = DateTime.UtcNow;

        var refresh = CreateRefreshToken();
        db.Sessions.Add(new Session
        {
            Id = Ids.New(),
            UserId = user.Id,
            RefreshHash = refresh.Hash,
            UserAgent = userAgent,
            ExpiresAt = DateTime.UtcNow.AddSeconds(RefreshTokenTtlSec),
        });
        await db.SaveChangesAsync();

        WriteSessionCookies(http, IssueAccessToken(new SessionClaimsDto(user.Id, user.Role, user.TenantId, idx)), refresh.Raw);
        await ledger.AuditAsync("OTP_LOGIN", "User", user.Id, actorId: user.Id, actorRole: user.Role);

        return new UserDto(user.Id, user.Role, user.TenantId, $"+251••••{phone[^3..]}");
    }

    public async Task<UserDto> RotateRefreshAsync(HttpContext http, string rawRefresh)
    {
        string hash = CryptoBox.Sha256Hex(rawRefresh);
        var session = await db.Sessions.FirstOrDefaultAsync(s => s.RefreshHash == hash);
        var user = session is null ? null : await db.Users.FirstOrDefaultAsync(u => u.Id == session.UserId);
        if (session is null || user is null || session.RevokedAt is not null || session.ExpiresAt < DateTime.UtcNow)
            throw new ApiError("UNAUTHENTICATED", "refresh token invalid or expired");
        session.RevokedAt = DateTime.UtcNow;
        var refresh = CreateRefreshToken();
        db.Sessions.Add(new Session
        {
            Id = Ids.New(),
            UserId = session.UserId,
            RefreshHash = refresh.Hash,
            UserAgent = session.UserAgent,
            ExpiresAt = DateTime.UtcNow.AddSeconds(RefreshTokenTtlSec),
        });
        await db.SaveChangesAsync();
        WriteSessionCookies(http, IssueAccessToken(new SessionClaimsDto(user.Id, user.Role, user.TenantId, user.PhoneBlindIdx)), refresh.Raw);
        return new UserDto(user.Id, user.Role, user.TenantId, "");
    }

    public async Task LogoutAsync(HttpContext http)
    {
        string? raw = http.Request.Cookies[RefreshCookie];
        if (raw is not null)
        {
            string hash = CryptoBox.Sha256Hex(raw);
            var sessions = await db.Sessions.Where(s => s.RefreshHash == hash && s.RevokedAt == null).ToListAsync();
            foreach (var s in sessions) s.RevokedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
        }
        http.Response.Cookies.Delete(AccessCookie);
        http.Response.Cookies.Delete(RefreshCookie);
    }

    private static void WriteSessionCookies(HttpContext http, string access, string refresh)
    {
        var opts = new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Lax, Path = "/", Secure = false, IsEssential = true };
        http.Response.Cookies.Append(AccessCookie, access, new CookieOptions(opts) { MaxAge = TimeSpan.FromSeconds(AccessTokenTtlSec) });
        http.Response.Cookies.Append(RefreshCookie, refresh, new CookieOptions(opts) { MaxAge = TimeSpan.FromSeconds(RefreshTokenTtlSec) });
    }

    /// <summary>Who am I — re-verified against the live user row each call.</summary>
    public async Task<UserDto?> MeAsync(ClaimsPrincipal? principal)
    {
        var claims = ResolveClaims(principal);
        if (claims is null) return null;
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == claims.Sub);
        if (user is null || user.Status != "ACTIVE") return null;
        string masked = "+251•••••••";
        try
        {
            var e164 = CryptoBox.DecryptPhone(user.PhoneE164);
            masked = $"{e164[..4]}••••{e164[^3..]}";
        }
        catch { /* keep the fully-masked fallback */ }
        return new UserDto(user.Id, user.Role, user.TenantId, masked);
    }

    public SessionClaimsDto? ResolveClaims(ClaimsPrincipal? principal)
    {
        if (principal?.Identity?.IsAuthenticated != true) return null;
        var sub = principal.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
                  ?? principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (sub is null) return null;
        string? tenantId = principal.FindFirst("tenantId")?.Value;
        return new SessionClaimsDto(sub,
            principal.FindFirst("role")?.Value ?? "PLAYER",
            string.IsNullOrEmpty(tenantId) ? null : tenantId,
            principal.FindFirst("phoneIdx")?.Value ?? "");
    }

    /// <summary>Fresh user row (role/status — never trust an old JWT alone).</summary>
    public async Task<User?> FreshUserAsync(ClaimsPrincipal? principal)
    {
        var claims = ResolveClaims(principal);
        if (claims is null) return null;
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == claims.Sub);
        if (user is null || user.Status != "ACTIVE") return null;
        return user;
    }
}

public static class Roles
{
    public const string Admin = "ADMIN";
    public const string Supervisor = "SUPERVISOR";
    public const string Auditor = "AUDITOR";
    public static readonly string[] Staff = { Admin, Supervisor, "SUPPORT", Auditor, "TENANT_OWNER", "TENANT_SUPERVISOR", "PLATFORM_COMPLIANCE", "PLATFORM_FINANCE" };
}
