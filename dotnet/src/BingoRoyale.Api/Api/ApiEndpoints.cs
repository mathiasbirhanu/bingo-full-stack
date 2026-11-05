using System.Text.Json;
using BingoRoyale.Api.Data;
using BingoRoyale.Api.Domain;
using BingoRoyale.Api.Infrastructure;
using BingoRoyale.Api.Services;
using BingoRoyale.Core;
using Microsoft.EntityFrameworkCore;

namespace BingoRoyale.Api.Api;

/// <summary>
/// All /api/v1 endpoints — wire-compatible with the Next.js route handlers:
///   · envelope { ok: true, data } / { ok: false, error: { code, message } }
///   · santim serializes to string everywhere (money convention)
///   · auth via bg_at cookie or Authorization: Bearer
/// </summary>
public static class ApiEndpoints
{
    private static IResult Ok(object? data) => Results.Json(new { ok = true, data });
    private static IResult Err(ApiError e) => Results.Json(
        new { ok = false, error = new { code = e.Code, message = e.Message } }, statusCode: e.Status);

    private static async Task<IResult> GuardAsync(Func<Task<IResult>> fn)
    {
        try { return await fn(); }
        catch (ApiError e) { return Err(e); }
        catch (Exception e)
        {
            return Results.Json(new { ok = false, error = new { code = "INTERNAL", message = e.Message } }, statusCode: 500);
        }
    }

    private sealed record Body(JsonElement? Json)
    {
        public static async Task<Body> From(HttpContext http)
        {
            using var reader = new StreamReader(http.Request.Body);
            string raw = await reader.ReadToEndAsync();
            if (string.IsNullOrWhiteSpace(raw)) return new Body((JsonElement?)null);
            try
            {
                using var doc = JsonDocument.Parse(raw);
                return new Body(doc.RootElement.Clone());
            }
            catch
            {
                throw new ApiError("VALIDATION_FAILED", "request body is not valid JSON");
            }
        }

        public string? Str(string name) =>
            Json is { } j && j.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        public int? Int(string name) =>
            Json is { } j && j.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;
        public long? Long(string name) =>
            Json is { } j && j.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : null;
        public bool? Bool(string name) =>
            Json is { } j && j.TryGetProperty(name, out var v)
                ? v.ValueKind switch
                {
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    _ => (bool?)null,
                }
                : null;
        public JsonElement? Arr(string name) =>
            Json is { } j && j.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? v : null;
    }

    public static void MapApiV1(this WebApplication app)
    {
        var v1 = app.MapGroup("/api/v1");

        MapAuth(v1);
        MapRooms(v1);
        MapWallet(v1);
        MapFairness(v1);
        MapAdmin(v1);
    }

    // ── auth (UC-01) ────────────────────────────────────────────────────────

    private static void MapAuth(RouteGroupBuilder v1)
    {
        v1.MapPost("/auth", async (HttpContext http, AuthService auth) => await GuardAsync(async () =>
        {
            var body = await Body.From(http);
            var action = body.Str("action") ?? "";
            switch (action)
            {
                case "request-otp":
                {
                    var res = await auth.RequestOtpAsync(body.Str("phone") ?? "");
                    return Ok(new { sent = true, demoCode = res.DemoCode, phone = res.Phone });
                }
                case "login":
                {
                    var user = await auth.VerifyOtpAndLoginAsync(http, body.Str("phone") ?? "", body.Str("code") ?? "", http.Request.Headers.UserAgent.ToString());
                    return Ok(new { user });
                }
                case "refresh":
                {
                    string? raw = http.Request.Cookies[AuthService.RefreshCookie];
                    var user = await auth.RotateRefreshAsync(http, raw ?? "");
                    return Ok(new { user });
                }
                case "logout":
                    await auth.LogoutAsync(http);
                    return Ok(new { ok = true });
                default:
                    throw new ApiError("VALIDATION_FAILED", "unknown auth action");
            }
        })).AllowAnonymous();

        v1.MapGet("/auth", async (HttpContext http, AuthService auth) => await GuardAsync(async () =>
            Ok(new { user = await auth.MeAsync(http.User) }))).AllowAnonymous();
    }

    // ── rooms (UC-03/04) ────────────────────────────────────────────────────

    private static void MapRooms(RouteGroupBuilder v1)
    {
        v1.MapGet("/rooms", async (RoomQueriesService rooms) => await GuardAsync(async () =>
            Ok(await rooms.ListRoomsAsync()))).AllowAnonymous();

        v1.MapGet("/rooms/{roomId}", async (string roomId, RoomQueriesService rooms, AuthService auth, HttpContext http) =>
            await GuardAsync(async () =>
            {
                var user = await auth.FreshUserAsync(http.User);
                return Ok(await rooms.RoomDetailAsync(roomId, user?.Id));
            })).AllowAnonymous();

        // ADR-19 sequence-addressed catch-up — the low-connectivity lifeline.
        v1.MapGet("/rooms/{roomId}/events", async (string roomId, HttpContext http, AppDbContext db) =>
            await GuardAsync(async () =>
        {
            int after = 0;
            _ = int.TryParse(http.Request.Query["afterSeq"].ToString(), out after);
            after = Math.Max(0, after);

            var room = await db.Rooms.AsNoTracking().FirstOrDefaultAsync(r => r.Id == roomId)
                ?? throw new ApiError("ROOM_NOT_FOUND");

            var balls = await db.BallDraws.AsNoTracking()
                .Where(b => b.RoomId == room.Id && b.Seq > after)
                .OrderBy(b => b.Seq)
                .Select(b => new { b.Seq, b.Ball })
                .ToListAsync();
            int lastSeq = after == 0
                ? await db.BallDraws.Where(b => b.RoomId == room.Id).MaxAsync(b => (int?)b.Seq) ?? 0
                : balls.Count > 0 ? balls[^1].Seq : after;

            // Confirmed awards after the requested sequence, grouped per ball tick.
            var claims = await db.Claims.AsNoTracking()
                .Where(c => c.RoomId == room.Id && c.Status == "CONFIRMED" && c.BallSeq > after)
                .OrderBy(c => c.BallSeq)
                .ToListAsync();
            var versionIds = claims.Select(c => c.PatternVersionId).Distinct().ToList();
            var versions = versionIds.Count > 0
                ? await db.ConfigVersions.AsNoTracking().Where(v => versionIds.Contains(v.Id)).ToListAsync()
                : new List<ConfigVersion>();
            var entityIds = versions.Select(v => v.EntityId).Distinct().ToList();
            var entities = entityIds.Count > 0
                ? await db.ConfigEntities.AsNoTracking().Where(e => entityIds.Contains(e.Id)).ToListAsync()
                : new List<ConfigEntity>();
            var playerIds = claims.Select(c => c.PlayerId).Distinct().ToList();
            var players = playerIds.Count > 0
                ? await db.Users.AsNoTracking().Where(u => playerIds.Contains(u.Id)).ToListAsync()
                : new List<User>();

            var byBall = new Dictionary<int, BallAwards>();
            foreach (var c in claims)
            {
                string label = versions.FirstOrDefault(v => v.Id == c.PatternVersionId) is { } v
                    ? entities.FirstOrDefault(e => e.Id == v.EntityId)?.Name ?? v.EntityId
                    : "Prize";
                if (!byBall.TryGetValue(c.BallSeq, out var row))
                    row = byBall[c.BallSeq] = new BallAwards(c.BallSeq, label);
                string alias = players.FirstOrDefault(p => p.Id == c.PlayerId)?.DisplayName
                               ?? $"Player {c.PlayerId[^4..].ToUpperInvariant()}";
                row.Winners.Add(new[] { alias, Money.SantimToEtb(c.AwardSantim ?? 0), c.PlayerId });
            }

            var lastBallAt = await db.BallDraws.AsNoTracking()
                .Where(b => b.RoomId == room.Id)
                .OrderByDescending(b => b.Seq)
                .Select(b => (DateTime?)b.CalledAt)
                .FirstOrDefaultAsync();
            long? nextBallInMs = room.Status == "DRAWING" && lastBallAt is not null
                ? Math.Max(0, (long)(lastBallAt.Value - DateTime.UtcNow).TotalMilliseconds + room.BallIntervalMs)
                : null;

            return Results.Json(new
            {
                ok = true,
                data = new
                {
                    roomId = room.Id,
                    status = room.Status,
                    variantId = room.VariantId,
                    ballsTotal = GridSpecs.Get(room.VariantId).BallsTotal,
                    ballIntervalMs = room.BallIntervalMs,
                    autoClaim = room.AutoClaim,
                    lastSeq,
                    balls = balls.Select(b => new[] { b.Seq, b.Ball }),
                    awards = byBall.Values.Select(a => new { seq = a.Seq, label = a.Label, winners = a.Winners }),
                    nextBallInMs,
                    grossEtb = Money.SantimToEtb(room.GrossSantim),
                    serverTime = DateTime.UtcNow.ToString("o"),
                },
            });
        })).AllowAnonymous();

        v1.MapPost("/rooms/{roomId}/purchase", async (string roomId, PurchaseService purchase,
            AuthService auth, HttpContext http) => await GuardAsync(async () =>
        {
            var body = await Body.From(http);
            var user = await auth.FreshUserAsync(http.User) ?? throw new ApiError("UNAUTHENTICATED");
            await DbGate.Write.WaitAsync();
            try
            {
                var res = await purchase.PurchaseCardsAsync(
                    roomId, user.Id, body.Int("quantity") ?? 0, body.Str("idempotencyKey") ?? "");
                return Ok(res);
            }
            finally { DbGate.Write.Release(); }
        }));

        v1.MapPost("/rooms/{roomId}/claim", async (string roomId, ClaimService claims,
            AuthService auth, HttpContext http) => await GuardAsync(async () =>
        {
            var body = await Body.From(http);
            var user = await auth.FreshUserAsync(http.User) ?? throw new ApiError("UNAUTHENTICATED");
            var daubs = new List<ClaimService.ClaimDaub>();
            if (body.Arr("daubs") is { } arr)
                foreach (var d in arr.EnumerateArray())
                {
                    var numbers = new List<int>();
                    if (d.TryGetProperty("numbers", out var nums) && nums.ValueKind == JsonValueKind.Array)
                        foreach (var n in nums.EnumerateArray())
                            if (n.ValueKind == JsonValueKind.Number && n.TryGetInt32(out int nv)) numbers.Add(nv);
                    daubs.Add(new ClaimService.ClaimDaub(
                        d.TryGetProperty("ticketId", out var tid) ? tid.GetString() ?? "" : "", numbers));
                }
            var res = await claims.ClaimPrizeAsync(roomId, user.Id, daubs);
            return Ok(res);
        }));
    }

    private sealed class BallAwards(int seq, string label)
    {
        public int Seq { get; } = seq;
        public string Label { get; } = label;
        public List<string[]> Winners { get; } = new();
    }

    // ── wallet (UC-02, FR-FIN) ──────────────────────────────────────────────

    private static void MapWallet(RouteGroupBuilder v1)
    {
        v1.MapGet("/wallet", async (AppDbContext db, LedgerService ledger, AuthService auth, HttpContext http) =>
            await GuardAsync(async () =>
        {
            var user = await auth.FreshUserAsync(http.User) ?? throw new ApiError("UNAUTHENTICATED");
            long balance = await ledger.WalletBalanceOfAsync(user.Id);
            var wallet = await db.LedgerAccounts.AsNoTracking()
                .FirstOrDefaultAsync(a => a.Code == LedgerCodes.PlayerWallet(user.Id));
            var history = new List<object>();
            if (wallet is not null)
            {
                var entries = await db.JournalEntries.AsNoTracking()
                    .Where(e => e.AccountId == wallet.Id)
                    .OrderByDescending(e => e.Id)
                    .Take(60)
                    .ToListAsync();
                var txIds = entries.Select(e => e.TransactionId).Distinct().ToList();
                var txs = await db.JournalTransactions.AsNoTracking()
                    .Where(t => txIds.Contains(t.Id))
                    .ToDictionaryAsync(t => t.Id);
                history = entries
                    .Select(e => new { E = e, T = txs.GetValueOrDefault(e.TransactionId) })
                    .Where(x => x.T is not null)
                    .OrderByDescending(x => x.T!.CreatedAt)
                    .Take(30)
                    .Select(x => (object)new
                    {
                        kind = x.T!.Kind,
                        memo = x.T.Memo,
                        direction = x.E.Direction,
                        amountSantim = x.E.AmountSantim.ToString(),
                        amountDisplay = Money.SantimToEtb(x.E.AmountSantim),
                        demo = x.T.Demo,
                        createdAt = x.T.CreatedAt.ToString("o"),
                    })
                    .ToList();
            }
            return Ok(new
            {
                balanceSantim = balance.ToString(),
                balanceDisplay = Money.SantimToEtb(balance),
                currency = "ETB",
                mode = "DEMO",
                phase = "DEMO",
                history,
            });
        }));

        v1.MapPost("/wallet", async (AppDbContext db, LedgerService ledger, AuthService auth,
            HttpContext http) => await GuardAsync(async () =>
        {
            var body = await Body.From(http);
            var user = await auth.FreshUserAsync(http.User) ?? throw new ApiError("UNAUTHENTICATED");
            string amountEtb = body.Str("amountEtb") ?? "";
            string idempotencyKey = body.Str("idempotencyKey") ?? "";
            long amount = Money.EtbToSantim(amountEtb);
            if (amount <= 0) throw new ApiError("VALIDATION_FAILED", "amount must be positive");
            if (idempotencyKey.Length < 8 || idempotencyKey.Length > 128)
                throw new ApiError("VALIDATION_FAILED", "idempotency key required");

            await DbGate.Write.WaitAsync();
            try
            {
                // Demo rail: the simulated checkout confirms instantly through the
                // same journal path a verified telebirr callback takes — one money path.
                var existing = await db.DepositIntents.AsNoTracking().FirstOrDefaultAsync(d => d.IdempotencyKey == idempotencyKey);
                bool replayed = existing is not null;
                string intentId;
                if (!replayed)
                {
                    var intent = new DepositIntent
                    {
                        Id = Ids.New(),
                        IdempotencyKey = idempotencyKey,
                        UserId = user.Id,
                        AmountSantim = amount,
                        PayloadHash = CryptoBox.Sha256Hex($"{user.Id}:{amount}"),
                    };
                    db.DepositIntents.Add(intent);
                    await db.SaveChangesAsync();
                    intentId = intent.Id;

                    var posted = await ledger.PostTransactionAsync(new PostTxInput(
                        "DEPOSIT", $"deposit:{idempotencyKey}",
                        $"Wallet deposit {Money.SantimToEtb(amount)} ETB (simulated checkout)",
                        null, null,
                        new List<EntryInput>
                        {
                            new(LedgerCodes.PaymentClearing(), "ASSET", "Demo payment clearing", "DEBIT", amount),
                            new(LedgerCodes.PlayerWallet(user.Id), "LIABILITY", "Player wallet", "CREDIT", amount, null, user.Id),
                        }));
                    intent.JournalTxId = posted.Id;
                    intent.Status = "CONFIRMED";
                    intent.ConfirmedAt = DateTime.UtcNow;
                    await db.SaveChangesAsync();
                }
                else
                {
                    intentId = existing.Id;
                }

                long balance = await ledger.WalletBalanceOfAsync(user.Id);
                return Ok(new
                {
                    intentId,
                    replayed,
                    balanceSantim = balance.ToString(),
                    balanceDisplay = Money.SantimToEtb(balance),
                    pending = false,
                    phase = "DEMO",
                    demo = true,
                });
            }
            finally { DbGate.Write.Release(); }
        }));
    }

    // ── fairness (UC-06) ────────────────────────────────────────────────────

    private static void MapFairness(RouteGroupBuilder v1)
    {
        v1.MapGet("/fairness/{roomId}", async (string roomId, AppDbContext db) => await GuardAsync(async () =>
        {
            var room = await db.Rooms.AsNoTracking().FirstOrDefaultAsync(r => r.Id == roomId)
                ?? throw new ApiError("ROOM_NOT_FOUND");
            var seal = await db.FairnessSeals.AsNoTracking().FirstOrDefaultAsync(s => s.RoomId == roomId);
            if (seal is null)
                return Ok(new { roomId, status = room.Status, commitment = (string?)null, message = "sales still open — envelope publishes at LOCK" });

            bool revealed = seal.RevealedAt is not null;
            object? verification = null;
            if (revealed && seal.RevealedSeed is not null)
            {
                var seq = Draw.GenerateDrawSequence(seal.RevealedSeed, seal.Salt, seal.ClientSeedContribution, seal.Nonce, room.VariantId);
                verification = new
                {
                    serverSeed = seal.RevealedSeed,
                    salt = seal.Salt,
                    commitmentHolds = Draw.CommitmentHolds(seal.Commitment, seal.RevealedSeed, seal.Salt),
                    drawSequence = seq,
                };
            }
            return Ok(new
            {
                roomId,
                variantId = room.VariantId,
                status = room.Status,
                commitment = seal.Commitment,
                clientSeedContribution = seal.ClientSeedContribution,
                nonce = seal.Nonce,
                inputHash = seal.InputHash,
                revealed,
                revealedAt = seal.RevealedAt?.ToString("o"),
                verification,
            });
        })).AllowAnonymous();
    }

    // ── admin (FR-ADM) ──────────────────────────────────────────────────────

    private static void MapAdmin(RouteGroupBuilder v1)
    {
        v1.MapGet("/admin/rounds", async (AppDbContext db, EngineHost host, AuthService auth, HttpContext http) =>
            await GuardAsync(async () =>
        {
            var user = await auth.FreshUserAsync(http.User) ?? throw new ApiError("UNAUTHENTICATED");
            if (user.Role is not (Roles.Admin or Roles.Supervisor or Roles.Auditor))
                throw new ApiError("FORBIDDEN", "requires ADMIN|SUPERVISOR|AUDITOR");
            var statuses = EngineService.LiveStatuses.ToArray();
            var rooms = await db.Rooms.AsNoTracking()
                .Where(r => statuses.Contains(r.Status))
                .OrderBy(r => r.ScheduledAt)
                .ToListAsync();
            var ticketRows = await db.Tickets.AsNoTracking().Select(t => new { t.RoomId, t.PlayerId }).ToListAsync();
            var rows = new List<object>();
            foreach (var r in rooms)
            {
                int ballCount = await db.BallDraws.CountAsync(b => b.RoomId == r.Id);
                rows.Add(new
                {
                    id = r.Id,
                    title = r.Title,
                    variantId = r.VariantId,
                    status = r.Status,
                    priceSantim = r.PriceSantim.ToString(),
                    ballIntervalMs = r.BallIntervalMs,
                    autoClaim = r.AutoClaim,
                    scheduledAt = r.ScheduledAt.ToString("o"),
                    salesOpenAt = r.SalesOpenAt.ToString("o"),
                    salesCloseAt = r.SalesCloseAt.ToString("o"),
                    grossSantim = r.GrossSantim.ToString(),
                    netPoolSantim = r.NetPoolSantim.ToString(),
                    tickets = ticketRows.Count(t => t.RoomId == r.Id),
                    players = ticketRows.Where(t => t.RoomId == r.Id).Select(t => t.PlayerId).Distinct().Count(),
                    ballsDrawn = ballCount,
                });
            }
            return Ok(new { rooms = rows, engine = host.Status() });
        }));

        // Draw monitor — the owner's live view of the sealed draw.
        v1.MapGet("/admin/rounds/{roomId}", async (string roomId, AppDbContext db, AuthService auth, HttpContext http) =>
            await GuardAsync(async () =>
        {
            var user = await auth.FreshUserAsync(http.User) ?? throw new ApiError("UNAUTHENTICATED");
            if (user.Role is not (Roles.Admin or Roles.Supervisor or Roles.Auditor))
                throw new ApiError("FORBIDDEN", "requires ADMIN|SUPERVISOR|AUDITOR");
            var room = await db.Rooms.AsNoTracking().FirstOrDefaultAsync(r => r.Id == roomId)
                ?? throw new ApiError("ROOM_NOT_FOUND");
            var balls = await db.BallDraws.AsNoTracking().Where(b => b.RoomId == roomId).OrderBy(b => b.Seq).ToListAsync();
            var claims = await db.Claims.AsNoTracking().Where(c => c.RoomId == roomId).OrderByDescending(c => c.BallSeq).Take(50).ToListAsync();
            var seal = await db.FairnessSeals.AsNoTracking().FirstOrDefaultAsync(s => s.RoomId == roomId);
            var ticketRows = await db.Tickets.AsNoTracking().Where(t => t.RoomId == roomId).ToListAsync();
            return Ok(new
            {
                room = new
                {
                    id = room.Id,
                    title = room.Title,
                    variantId = room.VariantId,
                    status = room.Status,
                    priceSantim = room.PriceSantim.ToString(),
                    ballIntervalMs = room.BallIntervalMs,
                    autoClaim = room.AutoClaim,
                    scheduledAt = room.ScheduledAt.ToString("o"),
                    grossSantim = room.GrossSantim.ToString(),
                    netPoolSantim = room.NetPoolSantim.ToString(),
                },
                balls = balls.Select(b => new { seq = b.Seq, ball = b.Ball, calledAt = b.CalledAt.ToString("o") }),
                claims = claims.Select(c => new
                {
                    playerId = c.PlayerId,
                    ticketId = c.TicketId,
                    patternVersionId = c.PatternVersionId,
                    ballSeq = c.BallSeq,
                    status = c.Status,
                    awardSantim = c.AwardSantim?.ToString(),
                }),
                players = ticketRows.Select(t => t.PlayerId).Distinct().Count(),
                tickets = ticketRows.Count,
                seal = seal is null ? null : new
                {
                    commitment = seal.Commitment,
                    inputHash = seal.InputHash,
                    nonce = seal.Nonce,
                    revealed = seal.RevealedAt is not null,
                    revealedSeed = seal.RevealedSeed,
                },
            });
        }));

        // Engine health — the ops console heartbeat (ticks, cache, last error).
        v1.MapGet("/admin/engine", async (EngineHost host, AuthService auth, HttpContext http) =>
            await GuardAsync(async () =>
        {
            var user = await auth.FreshUserAsync(http.User) ?? throw new ApiError("UNAUTHENTICATED");
            if (user.Role is not (Roles.Admin or Roles.Supervisor or Roles.Auditor))
                throw new ApiError("FORBIDDEN", "requires ADMIN|SUPERVISOR|AUDITOR");
            return Ok(host.Status());
        }));

        // Admin actions: live speed + sales-price controls.
        v1.MapPost("/admin/rounds/{roomId}", async (string roomId, AppDbContext db, LedgerService ledger,
            IRoomBroadcaster broadcaster, AuthService auth, HttpContext http) => await GuardAsync(async () =>
        {
            var body = await Body.From(http);
            var user = await auth.FreshUserAsync(http.User) ?? throw new ApiError("UNAUTHENTICATED");
            if (user.Role != Roles.Admin)
                throw new ApiError("FORBIDDEN", "requires ADMIN");
            var action = body.Str("action") ?? "";
            await DbGate.Write.WaitAsync();
            try
            {
                switch (action)
                {
                    case "set-speed":
                    {
                        int speedMs = body.Int("speedMs") ?? 0;
                        if (speedMs < 500 || speedMs > 20_000)
                            throw new ApiError("SPEED_OUT_OF_RANGE", "ball interval must be 500..20000 ms");
                        var room = await db.Rooms.FirstOrDefaultAsync(r => r.Id == roomId)
                            ?? throw new ApiError("ROOM_NOT_FOUND");
                        room.BallIntervalMs = speedMs;
                        room.UpdatedAt = DateTime.UtcNow;
                        await db.SaveChangesAsync();
                        await broadcaster.PublishAsync(roomId, "ROOM_PHASE", new { roomId, status = room.Status, ballIntervalMs = speedMs });
                        await ledger.AuditAsync("ROUND_SPEED_SET", "Room", roomId,
                            actorId: user.Id, actorRole: user.Role, tenantId: room.TenantId,
                            meta: new { speedMs });
                        return Ok(new { ok = true, speedMs });
                    }
                    case "set-price":
                    {
                        long priceSantim = body.Long("priceSantim") ?? -1;
                        if (priceSantim < 50 || priceSantim > 500_000)
                            throw new ApiError("BAD_PRICE", "price must be 50..500000 santim (0.50..5000.00 ETB)");
                        var room = await db.Rooms.FirstOrDefaultAsync(r => r.Id == roomId)
                            ?? throw new ApiError("ROOM_NOT_FOUND");
                        if (room.Status is not ("SCHEDULED" or "SALES_OPEN"))
                            throw new ApiError("PRICE_LOCKED", $"cannot reprice a {room.Status} round");
                        long old = room.PriceSantim;
                        room.PriceSantim = priceSantim;
                        room.UpdatedAt = DateTime.UtcNow;
                        await db.SaveChangesAsync();
                        await ledger.AuditAsync("ROUND_PRICE_SET", "Room", roomId,
                            actorId: user.Id, actorRole: user.Role, tenantId: room.TenantId,
                            meta: new { from = old.ToString(), to = priceSantim.ToString() });
                        return Ok(new { ok = true, priceSantim = priceSantim.ToString() });
                    }
                    case "set-claim-mode":
                    {
                        bool? autoClaim = body.Bool("autoClaim");
                        if (autoClaim is null)
                            throw new ApiError("VALIDATION_FAILED", "autoClaim boolean required");
                        var room = await db.Rooms.FirstOrDefaultAsync(r => r.Id == roomId)
                            ?? throw new ApiError("ROOM_NOT_FOUND");
                        room.AutoClaim = autoClaim.Value;
                        room.UpdatedAt = DateTime.UtcNow;
                        await db.SaveChangesAsync();
                        await broadcaster.PublishAsync(roomId, "ROOM_PHASE", new { roomId, status = room.Status, autoClaim = autoClaim.Value });
                        await ledger.AuditAsync("ROUND_CLAIM_MODE_SET", "Room", roomId,
                            actorId: user.Id, actorRole: user.Role, tenantId: room.TenantId,
                            meta: new { autoClaim = autoClaim.Value });
                        return Ok(new { ok = true, autoClaim = autoClaim.Value, status = room.Status });
                    }
                    case "void":
                    {
                        // UC-09 / FR-ROOM-04 / FR-ADM-05 — port of modules/rooms/void.ts:
                        // one reversing REFUND journal per confirmed purchase, idempotent
                        // by key refund:{purchaseId}; postcondition escrow zero.
                        string reasonCode = body.Str("reasonCode") ?? "";
                        if (reasonCode.Length < 3)
                            throw new ApiError("VALIDATION_FAILED", "reason code required");
                        var room = await db.Rooms.FirstOrDefaultAsync(r => r.Id == roomId)
                            ?? throw new ApiError("ROOM_NOT_FOUND");
                        if (room.Status == "VOIDED")
                            return Ok(new { ok = true, refundedSantim = room.GrossSantim.ToString(), refundCount = 0, alreadyVoided = true });
                        if (room.Status is not ("SALES_OPEN" or "LOCKED" or "DRAWING" or "RESOLVING"))
                            throw new ApiError("VALIDATION_FAILED", $"cannot void a {room.Status} round");
                        if (room.Status == "DRAWING" && reasonCode != "CRITICAL_FAULT")
                            throw new ApiError("VALIDATION_FAILED", "void during DRAWING requires the critical-fault reason");

                        var purchases = await db.Purchases
                            .Where(p => p.RoomId == roomId && p.Status == "CONFIRMED")
                            .ToListAsync();
                        long refunded = 0;
                        int refundCount = 0;
                        foreach (var p in purchases)
                        {
                            if (p.Status == "REFUNDED") continue;
                            var posted = await ledger.PostTransactionAsync(new PostTxInput(
                                "REFUND", $"refund:{p.Id}",
                                $"Void refund — room {room.Title}, reason {reasonCode}",
                                roomId, room.TenantId,
                                new List<EntryInput>
                                {
                                    new(LedgerCodes.RoundEscrow(roomId), "LIABILITY", $"Round escrow — {room.Title}", "DEBIT", p.TotalSantim, room.TenantId),
                                    new(LedgerCodes.PlayerWallet(p.PlayerId), "LIABILITY", "Player wallet", "CREDIT", p.TotalSantim, null, p.PlayerId),
                                }));
                            _ = posted; // replay would simply re-return the original tx
                            p.Status = "REFUNDED";
                            refunded += p.TotalSantim;
                            refundCount++;
                        }

                        room.Status = "VOIDED";
                        room.VoidedAt = DateTime.UtcNow;
                        room.VoidReason = reasonCode;
                        room.UpdatedAt = DateTime.UtcNow;
                        await db.SaveChangesAsync();

                        await ledger.EmitOutboxAsync("ROUND_VOIDED", roomId,
                            new { roomId, reasonCode, refunded = refunded.ToString() });
                        await broadcaster.PublishAsync(roomId, "ROUND_VOIDED",
                            new { roomId, reasonCode, refunded = refunded.ToString(), status = "VOIDED" });
                        await ledger.AuditAsync("ROUND_VOID", "Room", roomId,
                            actorId: user.Id, actorRole: user.Role, tenantId: room.TenantId,
                            meta: new { reasonCode, refunded = refunded.ToString(), refundCount });
                        EngineService.DropRoomState(roomId); // stop the tick loop's in-memory state
                        return Ok(new { ok = true, refundedSantim = refunded.ToString(), refundCount, alreadyVoided = false });
                    }
                    default:
                        throw new ApiError("VALIDATION_FAILED", "unknown admin action");
                }
            }
            finally { DbGate.Write.Release(); }
        }));
    }
}
