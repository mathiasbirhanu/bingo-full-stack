using System.Text;
using BingoRoyale.Api.Api;
using BingoRoyale.Api.Data;
using BingoRoyale.Api.Hubs;
using BingoRoyale.Api.Infrastructure;
using BingoRoyale.Api.Services;
using BingoRoyale.Core;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

// ── Configuration ───────────────────────────────────────────────────────────
var appSecret = builder.Configuration["APP_SECRET"] ?? CryptoBox.DefaultAppSecret;
CryptoBox.AppSecret = appSecret; // AES + blind-index derivation, identical to the TS env.ts scheme

// ── Database provider ────────────────────────────────────────────────────────
// Architecture v5.0 ch.3 / ADR-03: "PostgreSQL 16 is the sole system of record
// for money, rounds, and audit" — EF Core + Npgsql is the ONLY provider.

// DATABASE_URL in prisma/CI form (postgresql://user:pass@host:port/db) is
// converted to an Npgsql connection string so the compose env works unchanged.
static string? FromDatabaseUrl(string? url)
{
    if (string.IsNullOrEmpty(url) || !(url.StartsWith("postgres://") || url.StartsWith("postgresql://")))
        return null;
    var uri = new Uri(url);
    var userInfo = uri.UserInfo.Split(':', 2);
    return $"Host={uri.Host};Port={(uri.Port > 0 ? uri.Port : 5432)};Database={uri.AbsolutePath.Trim('/')};"
         + $"Username={Uri.UnescapeDataString(userInfo[0])};Password={Uri.UnescapeDataString(userInfo.Length > 1 ? userInfo[1] : "")}";
}
// `dotnet <dll>` boots with the CWD as content root, so appsettings.json that
// sits next to the DLL is not auto-loaded — fall back to it explicitly while
// keeping env vars (DATABASE_URL, ConnectionStrings__Default) as the primary
// override channel.
static string? FromAppBaseConfig(IConfiguration cfg, string key)
{
    var v = cfg[key];
    if (!string.IsNullOrEmpty(v)) return v;
    var file = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
    if (!File.Exists(file)) return null;
    return new ConfigurationBuilder().AddJsonFile(file, optional: false).Build()[key];
}

var pgConnStr = FromDatabaseUrl(builder.Configuration["DATABASE_URL"])
             ?? FromAppBaseConfig(builder.Configuration, "ConnectionStrings:Default")
             ?? throw new InvalidOperationException(
                 "PostgreSQL is the system of record (Architecture v5.0) but no connection string found. " +
                 "Set DATABASE_URL (postgresql://user:pass@host:port/db) or ConnectionStrings__Default — " +
                 "or run the compose stack: docker compose -f infra/compose/docker-compose.yml up -d postgres.");
builder.Services.AddDbContext<AppDbContext>(opts => opts.UseNpgsql(pgConnStr));

// Demo verbosity: keep engine + app logs, drop EF's per-command chatter.
builder.Logging.AddFilter("Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Warning);

// Bind the demo port at host level (beats launchSettings).
builder.WebHost.UseUrls(builder.Configuration["URLS"] ?? "http://0.0.0.0:5080");

// ── Application services ────────────────────────────────────────────────────
builder.Services.AddScoped<LedgerService>();
builder.Services.AddScoped<PayService>();
builder.Services.AddScoped<ClaimService>();
builder.Services.AddScoped<PurchaseService>();
builder.Services.AddScoped<CommissionService>();
builder.Services.AddScoped<EngineService>();
builder.Services.AddScoped<RoomQueriesService>();
builder.Services.AddScoped<SeedService>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddSingleton<EngineHost>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<EngineHost>());

// ── Realtime gateway (Architecture v5.0): SignalR hub mirrors every room
// outbox event to its group; the Next.js /hubs proxy keeps it first-party. ──
builder.Services.AddSignalR();
builder.Services.AddSingleton<RoomBroadcaster>();
builder.Services.AddSingleton<IRoomBroadcaster>(sp => sp.GetRequiredService<RoomBroadcaster>());

// ── Auth (UC-01): JWT HS256 — same key/issuer/audience as the TS build; the
// access token also rides the httpOnly bg_at cookie for browser clients. ────
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(appSecret)),
            ValidIssuer = AuthService.JwtIssuer,
            ValidAudience = AuthService.JwtAudience,
            ValidateIssuer = true,
            ValidateAudience = true,
            ClockSkew = TimeSpan.FromSeconds(5),
        };
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = ctx =>
            {
                // Cookie-first (browser), header-second (API clients).
                if (string.IsNullOrEmpty(ctx.Token))
                    ctx.Token = ctx.Request.Cookies[AuthService.AccessCookie];
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization();

// ── CORS (the React client may live on its own origin in dev) ───────────────
builder.Services.AddCors(opts => opts.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

// Boot the demo world BEFORE the listener opens (deterministic readiness):
// schema (EnsureCreated) + idempotent seed. Architecture v5.0: PostgreSQL is
// the sole system of record — if it is unreachable we fail fast with the fix.
try
{
    using (var bootScope = app.Services.CreateScope())
    {
        var db = bootScope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.Database.EnsureCreatedAsync();
        await bootScope.ServiceProvider.GetRequiredService<SeedService>().SeedAsync();
    }
}
catch (Exception bootErr)
{
    Console.Error.WriteLine("[boot] PostgreSQL seed failed: " + bootErr.Message);
    Console.Error.WriteLine(
        "PostgreSQL is the sole system of record (Architecture v5.0). Start it with: " +
        "docker compose -f infra/compose/docker-compose.yml up -d postgres.");
    throw;
}

app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

if (app.Environment.IsDevelopment())
{
    // Demo build: no HTTPS redirect — the demo gateway terminates TLS.
}

// Health root (the gateway's readiness probe).
app.MapGet("/", () => Results.Json(new
{
    ok = true,
    service = "bingo-royale-api",
    stack = ".NET 9 / ASP.NET Core",
    database = "PostgreSQL 16 (system of record, Architecture v5.0)",
    endpoints = new[]
    {
        "POST /api/v1/auth {action: request-otp|login|refresh|logout}",
        "GET  /api/v1/auth",
        "GET  /api/v1/rooms",
        "GET  /api/v1/rooms/{id}",
        "GET  /api/v1/rooms/{id}/events?afterSeq=N",
        "POST /api/v1/rooms/{id}/purchase",
        "POST /api/v1/rooms/{id}/claim",
        "GET  /api/v1/wallet   POST /api/v1/wallet",
        "GET  /api/v1/fairness/{id}",
        "GET  /api/v1/admin/rounds   GET|POST /api/v1/admin/rounds/{id}",
        "HUB  /hubs/room (SignalR — ball calls, phases, awards; bg_at cookie auth)",
    },
}));

app.MapApiV1();
app.MapHub<RoomHub>("/hubs/room");

app.Run();
