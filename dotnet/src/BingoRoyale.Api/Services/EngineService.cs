using System.Text.Json;
using BingoRoyale.Api.Data;
using BingoRoyale.Api.Domain;
using BingoRoyale.Core;
using Microsoft.EntityFrameworkCore;

namespace BingoRoyale.Api.Services;

/// <summary>
/// Engine per-room state — the in-process equivalent of one room grain
/// activation (ADR-01). Rebuilt lazily from the system of record at any time
/// (crash-safe): the draw sequence derives deterministically from the seal.
/// </summary>
public class EngineRoomState
{
    public required string RoomId { get; init; }
    public required string VariantId { get; init; }
    public required List<ClaimPatternDef> Patterns { get; init; }
    public required List<PrizeRule> Rules { get; init; }
    /// <summary>Lazily generated from the seal on first draw — never persisted.</summary>
    public int[]? Sequence { get; set; }
    public int DrawnCount { get; set; }
    /// <summary>Pattern entityIds whose tier has already paid (tier closes at first award).</summary>
    public HashSet<string> ClosedRules { get; } = new();
    /// <summary>Pattern entityIds whose claim window expired UNCLAIMED — the roll-up rule.</summary>
    public HashSet<string> RolledRules { get; } = new();
    /// <summary>Lazily loaded ticket index at first draw: ticketId → (playerId, cells).</summary>
    public Dictionary<string, (string PlayerId, int?[][] Cells)>? Tickets { get; set; }
}

/// <summary>
/// Round lifecycle driver + draw tick + completion — the port of
/// engine/lifecycle.ts, engine/tick.ts and engine/finish.ts (UC-03/04/05).
/// </summary>
public class EngineService(AppDbContext db, LedgerService ledger, PayService pay, CommissionService commission,
    IRoomBroadcaster broadcaster, ILogger<EngineService> logger)
{
    private static readonly Dictionary<string, EngineRoomState> Registry = new();

    public static EngineRoomState? RoomState(string roomId) =>
        Registry.TryGetValue(roomId, out var s) ? s : null;

    public static int RegistrySize => Registry.Count;

    public static void DropRoomState(string roomId) => Registry.Remove(roomId);

    public static IEnumerable<string> LiveStatuses => new[] { "SCHEDULED", "SALES_OPEN", "LOCKED", "DRAWING", "RESOLVING" };

    // ── Lifecycle: build state purely from the database ─────────────────────

    public async Task<EngineRoomState> BuildRoomStateAsync(Room room)
    {
        var versionIds = JsonSerializer.Deserialize<List<string>>(room.PatternVersionIds) ?? new();
        var patternVersions = versionIds.Count > 0
            ? await db.ConfigVersions.AsNoTracking().Where(v => versionIds.Contains(v.Id)).ToListAsync()
            : new List<ConfigVersion>();
        var entityIds = patternVersions.Select(v => v.EntityId).Distinct().ToList();
        var patternEntities = entityIds.Count > 0
            ? await db.ConfigEntities.AsNoTracking().Where(e => entityIds.Contains(e.Id)).ToListAsync()
            : new List<ConfigEntity>();

        var patterns = new List<ClaimPatternDef>();
        foreach (var pv in patternVersions)
        {
            try
            {
                var payload = PatternPayload.FromJson(JsonDocument.Parse(pv.PayloadJson).RootElement);
                patterns.Add(new ClaimPatternDef
                {
                    EntityId = pv.EntityId,
                    VersionId = pv.Id,
                    Label = patternEntities.FirstOrDefault(e => e.Id == pv.EntityId)?.Name ?? pv.EntityId,
                    Payload = payload,
                });
            }
            catch
            {
                // a failed parse drops the diagram, never the round
            }
        }

        var rulesetVersion = await db.ConfigVersions.AsNoTracking()
            .FirstOrDefaultAsync(v => v.Id == room.RulesetVersionId);
        var ruleset = RulesetPayload.FromJson(JsonDocument.Parse(rulesetVersion?.PayloadJson ?? "{\"rules\":[]}").RootElement);

        int drawnCount = await db.BallDraws.CountAsync(b => b.RoomId == room.Id);
        var confirmedVersionIds = await db.Claims.AsNoTracking()
            .Where(c => c.RoomId == room.Id && c.Status == "CONFIRMED")
            .Select(c => c.PatternVersionId)
            .Distinct()
            .ToListAsync();
        var closedRules = new HashSet<string>();
        foreach (var p in patterns)
            if (confirmedVersionIds.Contains(p.VersionId)) closedRules.Add(p.EntityId);

        // Roll-up derivation (pure from committed state): an UNCLAIMED pattern
        // whose claim window has passed is rolled into the pool — deterministic
        // across restarts, so the roll-up can never double-fire.
        int ballsTotal = GridSpecs.Get(room.VariantId).BallsTotal;
        var rolledRules = new HashSet<string>();
        for (int i = 0; i < patterns.Count; i++)
        {
            if (closedRules.Contains(patterns[i].EntityId)) continue;
            if (drawnCount > Patterns.PatternWindowSeq(ballsTotal, i, patterns.Count))
                rolledRules.Add(patterns[i].EntityId);
        }

        var state = new EngineRoomState
        {
            RoomId = room.Id,
            VariantId = room.VariantId,
            Patterns = patterns,
            Rules = ruleset.Rules,
            DrawnCount = drawnCount,
        };
        foreach (var c in closedRules) state.ClosedRules.Add(c);
        foreach (var r in rolledRules) state.RolledRules.Add(r);
        Registry[state.RoomId] = state;
        return state;
    }

    // ── Transitions ─────────────────────────────────────────────────────────

    public async Task TransitionSalesOpenAsync(Room room)
    {
        room.Status = "SALES_OPEN";
        room.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        await ledger.EmitOutboxAsync("ROOM_PHASE", room.Id, new { roomId = room.Id, status = "SALES_OPEN", title = room.Title });
        await broadcaster.PublishAsync(room.Id, "ROOM_PHASE", new { roomId = room.Id, status = "SALES_OPEN", title = room.Title });
        logger.LogInformation("[engine] {Title} → SALES_OPEN", room.Title);
    }

    /// <summary>
    /// LOCK: sales close, the fairness envelope is published (commitment visible
    /// to every player from this moment), and all pinned config entities are
    /// locked while the round resolves against them (FR-ROOM-02, ADR-18).
    /// </summary>
    public async Task TransitionLockAsync(Room room)
    {
        var ticketIds = await db.Tickets.AsNoTracking()
            .Where(t => t.RoomId == room.Id)
            .OrderBy(t => t.Id)
            .Select(t => t.Id)
            .ToListAsync();
        var commitment = Draw.MakeCommitment(ticketIds);

        room.Status = "LOCKED";
        room.CommittedAt = DateTime.UtcNow;
        room.UpdatedAt = DateTime.UtcNow;
        db.FairnessSeals.Add(new FairnessSeal
        {
            Id = Ids.New(),
            RoomId = room.Id,
            Commitment = commitment.Commitment,
            ClientSeedContribution = commitment.ClientSeedContribution,
            Salt = commitment.Salt,
            ServerSeedEnc = commitment.ServerSeedSealed,
            Nonce = commitment.Nonce,
            InputHash = "PENDING_RESOLUTION",
        });

        var pinnedIds = new List<string> { room.TemplateVersionId, room.RulesetVersionId };
        pinnedIds.AddRange(JsonSerializer.Deserialize<List<string>>(room.PatternVersionIds) ?? new());
        var entityIds = await db.ConfigVersions.AsNoTracking()
            .Where(v => pinnedIds.Contains(v.Id))
            .Select(v => v.EntityId)
            .Distinct()
            .ToListAsync();
        foreach (var entityId in entityIds)
        {
            var ent = await db.ConfigEntities.FirstAsync(e => e.Id == entityId);
            ent.Locked = true;
            ent.UpdatedAt = DateTime.UtcNow;
        }
        await db.SaveChangesAsync();
        await ledger.EmitOutboxAsync("ROOM_PHASE", room.Id, new { roomId = room.Id, status = "LOCKED", commitment = commitment.Commitment });
        await broadcaster.PublishAsync(room.Id, "ROOM_PHASE", new { roomId = room.Id, status = "LOCKED", commitment = commitment.Commitment });
        logger.LogInformation("[engine] {Title} → LOCKED (commitment {Commitment}…)", room.Title, commitment.Commitment[..12]);
    }

    public async Task TransitionDrawingAsync(Room room)
    {
        room.Status = "DRAWING";
        room.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        await ledger.EmitOutboxAsync("ROOM_PHASE", room.Id, new { roomId = room.Id, status = "DRAWING", ballIntervalMs = room.BallIntervalMs });
        await broadcaster.PublishAsync(room.Id, "ROOM_PHASE", new { roomId = room.Id, status = "DRAWING", ballIntervalMs = room.BallIntervalMs });
        logger.LogInformation("[engine] {Title} → DRAWING", room.Title);
    }

    // ── Draw tick (the hot path of a live round, UC-04) ─────────────────────

    public async Task TickDrawingAsync(Room room)
    {
        var state = Registry.TryGetValue(room.Id, out var s) ? s : await BuildRoomStateAsync(room);

        if (state.Sequence is null)
        {
            var seal = await db.FairnessSeals.AsNoTracking().FirstOrDefaultAsync(x => x.RoomId == room.Id);
            if (seal is null)
            {
                // Defensive: a DRAWING room without a seal is a protocol violation.
                logger.LogError("[engine] {Title} DRAWING without seal — voiding", room.Title);
                room.Status = "RESOLVING";
                await db.SaveChangesAsync();
                return;
            }
            string serverSeed = Draw.OpenSealedSeed(seal.ServerSeedEnc);
            state.Sequence = Draw.GenerateDrawSequence(serverSeed, seal.Salt, seal.ClientSeedContribution, seal.Nonce, room.VariantId);
            await LoadTicketsAsync(state);
        }

        var spec = GridSpecs.Get(room.VariantId);
        // A tier is SETTLED when it paid (closed) or rolled up unclaimed.
        bool allSettled = state.Rules.Count > 0 &&
            state.Rules.All(r => state.ClosedRules.Contains(r.PatternRef) || state.RolledRules.Contains(r.PatternRef));

        var lastAny = await db.BallDraws.AsNoTracking()
            .Where(b => b.RoomId == room.Id)
            .OrderByDescending(b => b.Seq)
            .FirstOrDefaultAsync();
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Completion check on entry (covers restart-after-last-ball and the
        // manual grace window without drawing anything).
        if (CompletionRules.ShouldCompleteRound(
                state.DrawnCount >= spec.BallsTotal, allSettled, room.AutoClaim,
                lastAny is null ? null : new DateTimeOffset(lastAny.CalledAt, TimeSpan.Zero).ToUnixTimeMilliseconds(), nowMs))
        {
            await CompleteRoundAsync(room);
            return;
        }

        // Manual claim grace: the deck is out but the window is still open.
        if (state.DrawnCount >= spec.BallsTotal) return;

        long lastAt = lastAny is null
            ? new DateTimeOffset(room.ScheduledAt, TimeSpan.Zero).ToUnixTimeMilliseconds()
            : new DateTimeOffset(lastAny.CalledAt, TimeSpan.Zero).ToUnixTimeMilliseconds();
        if (nowMs - lastAt < room.BallIntervalMs) return;

        int seq = state.DrawnCount + 1;
        if (seq > spec.BallsTotal) return; // defensive: never draw past the deck
        int ball = state.Sequence[seq - 1];

        db.BallDraws.Add(new BallDraw { Id = Ids.New(), RoomId = room.Id, Seq = seq, Ball = ball, CalledAt = DateTime.UtcNow });
        await db.SaveChangesAsync();
        await ledger.EmitOutboxAsync("BALL_CALLED", room.Id, new { roomId = room.Id, seq, ball });
        await broadcaster.PublishAsync(room.Id, "BALL_CALLED", new { roomId = room.Id, seq, ball });
        state.DrawnCount = seq;

        // ── Roll-up enforcement (the owner's rule) ──────────────────────────
        // A pattern whose claim window just expired UNCLAIMED folds back into
        // the pool: later patterns' tiers recompute from the untouched escrow.
        for (int i = 0; i < state.Patterns.Count; i++)
        {
            var p = state.Patterns[i];
            if (state.ClosedRules.Contains(p.EntityId) || state.RolledRules.Contains(p.EntityId)) continue;
            if (seq > Patterns.PatternWindowSeq(spec.BallsTotal, i, state.Patterns.Count))
            {
                state.RolledRules.Add(p.EntityId);
                logger.LogInformation("[engine] {Title} → \"{Label}\" window closed UNCLAIMED @ball#{Seq} — prize rolls up into the pool",
                    room.Title, p.Label, seq);
            }
        }

        var called = state.Sequence.Take(seq).ToHashSet();
        if (room.AutoClaim)
            await ResolveAwardsAsync(state, room, seq, ball, called);

        bool settledNow = state.Rules.Count > 0 &&
            state.Rules.All(r => state.ClosedRules.Contains(r.PatternRef) || state.RolledRules.Contains(r.PatternRef));
        if (CompletionRules.ShouldCompleteRound(
                seq >= spec.BallsTotal, settledNow, room.AutoClaim, nowMs, nowMs))
        {
            await CompleteRoundAsync(room);
        }
    }

    private async Task LoadTicketsAsync(EngineRoomState state)
    {
        var rows = await db.Tickets.AsNoTracking()
            .Where(t => t.RoomId == state.RoomId)
            .Select(t => new { t.Id, t.PlayerId, t.NumbersJson })
            .ToListAsync();
        var tickets = new Dictionary<string, (string, int?[][])>();
        foreach (var t in rows)
        {
            int?[][] cells;
            try { cells = JsonSerializer.Deserialize<int?[][]>(t.NumbersJson) ?? Array.Empty<int?[]>(); }
            catch { cells = Array.Empty<int?[]>(); }
            tickets[t.Id] = (t.PlayerId, cells);
        }
        state.Tickets = tickets;
    }

    /// <summary>Auto-daub award resolution for one ball tick (ADR-20).</summary>
    private async Task ResolveAwardsAsync(EngineRoomState state, Room room, int seq, int ball, IReadOnlySet<int> called)
    {
        if (state.Tickets is null) return; // no sales — nothing to award

        foreach (var pattern in state.Patterns)
        {
            if (state.ClosedRules.Contains(pattern.EntityId) || state.RolledRules.Contains(pattern.EntityId)) continue;
            var rule = state.Rules.FirstOrDefault(r => r.PatternRef == pattern.EntityId);
            if (rule is null) continue;

            var winners = new List<PayService.TierWinnerRef>();
            foreach (var (ticketId, t) in state.Tickets)
            {
                if (t.Cells.Length == 0) continue;
                if (Patterns.IsPatternComplete(room.VariantId, t.Cells, called, pattern.Payload).Complete)
                    winners.Add(new PayService.TierWinnerRef(ticketId, t.PlayerId));
            }
            if (winners.Count == 0) continue;

            var res = await pay.PayTierAsync(new PayService.PayTierInput(
                room.Id, room.Title, room.TenantId,
                pattern.EntityId, pattern.VersionId, pattern.Label,
                rule, seq, ball, winners, "auto"));
            state.ClosedRules.Add(pattern.EntityId);
            logger.LogInformation("[engine] {Title} → \"{Label}\" paid ball #{Ball} @{Seq} ({Count} winner(s), {Each} each)",
                room.Title, pattern.Label, ball, seq, winners.Count, res.Each);
        }
    }

    public async Task CompleteRoundAsync(Room room)
    {
        var current = await db.Rooms.FirstAsync(r => r.Id == room.Id);
        if (current.Status == "DRAWING")
        {
            current.Status = "RESOLVING";
            current.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            await ledger.EmitOutboxAsync("ROOM_PHASE", room.Id, new { roomId = room.Id, status = "RESOLVING" });
            await broadcaster.PublishAsync(room.Id, "ROOM_PHASE", new { roomId = room.Id, status = "RESOLVING" });
        }
        await FinishRoomAsync(room.Id);
    }

    // ── Round completion (UC-05/06, FR-ADM-08) — the RESOLVING half-turn ────

    /// <summary>Every step is idempotent so a crash mid-completion re-runs the turn.</summary>
    public async Task FinishRoomAsync(string roomId)
    {
        var room = await db.Rooms.AsNoTracking().FirstOrDefaultAsync(r => r.Id == roomId);
        if (room is null || room.Status is "COMPLETED" or "VOIDED")
        {
            DropRoomState(roomId);
            return;
        }

        // 1. Escrow drain — projection beside the journal (ADR-04).
        string escrowCode = LedgerCodes.RoundEscrow(roomId);
        var escrow = await db.LedgerAccounts.AsNoTracking().FirstOrDefaultAsync(a => a.Code == escrowCode);
        long residual = 0;
        if (escrow is not null)
        {
            var proj = await db.WalletBalances.AsNoTracking().FirstOrDefaultAsync(w => w.AccountId == escrow.Id);
            residual = proj?.BalanceSantim ?? 0;
        }

        if (residual > 0)
        {
            await ledger.PostTransactionAsync(new PostTxInput(
                "ROUND_RESIDUAL", $"residual:{roomId}",
                $"Round residual — {room.Title}: unawarded pool to house revenue",
                roomId, room.TenantId,
                new List<EntryInput>
                {
                    new(escrowCode, "LIABILITY", $"Round escrow — {room.Title}", "DEBIT", residual, room.TenantId),
                    new(LedgerCodes.HouseRevenue(), "REVENUE", "House revenue", "CREDIT", residual, room.TenantId),
                }));
        }
        else if (residual < 0)
        {
            // Defensive: over-award (FIXED rule above the pool) — house covers the shortfall.
            await ledger.PostTransactionAsync(new PostTxInput(
                "ADJUSTMENT", $"escrow-cover:{roomId}",
                $"Escrow shortfall cover — {room.Title}",
                roomId, room.TenantId,
                new List<EntryInput>
                {
                    new(LedgerCodes.HouseRevenue(), "REVENUE", "House revenue", "DEBIT", -residual, room.TenantId),
                    new(escrowCode, "LIABILITY", $"Round escrow — {room.Title}", "CREDIT", -residual, room.TenantId),
                }));
        }

        // 2. Fairness reveal (ADR-18 step 3).
        var seal = await db.FairnessSeals.FirstOrDefaultAsync(x => x.RoomId == roomId);
        if (seal is not null && seal.RevealedAt is null)
        {
            int ticketCount = await db.Tickets.CountAsync(t => t.RoomId == roomId);
            seal.RevealedSeed = Draw.OpenSealedSeed(seal.ServerSeedEnc);
            seal.RevealedAt = DateTime.UtcNow;
            seal.InputHash = Draw.BuildInputHash(roomId, room.GrossSantim, room.NetPoolSantim, ticketCount);
            await db.SaveChangesAsync();
        }

        // 3. Immutable round report (FR-ADM-08).
        await PersistRoundReportAsync(roomId);

        // 4. Terminal state + event + config unlock.
        var roomRow = await db.Rooms.FirstAsync(r => r.Id == roomId);
        roomRow.Status = "COMPLETED";
        roomRow.CompletedAt = DateTime.UtcNow;
        roomRow.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        long prizesPaid = room.GrossSantim - room.NetPoolSantim;
        await ledger.EmitOutboxAsync("ROUND_COMPLETED", roomId, new
        {
            roomId,
            title = room.Title,
            gross = room.GrossSantim.ToString(),
            netPool = room.NetPoolSantim.ToString(),
            prizesPaid = prizesPaid.ToString(),
            residual = residual > 0 ? residual.ToString() : "0",
        });
        await broadcaster.PublishAsync(roomId, "ROUND_COMPLETED", new
        {
            roomId,
            title = room.Title,
            gross = room.GrossSantim.ToString(),
            netPool = room.NetPoolSantim.ToString(),
            prizesPaid = prizesPaid.ToString(),
            residual = residual > 0 ? residual.ToString() : "0",
            status = "COMPLETED",
        });

        var pinnedIds = new List<string> { room.TemplateVersionId, room.RulesetVersionId };
        try { pinnedIds.AddRange(JsonSerializer.Deserialize<List<string>>(room.PatternVersionIds) ?? new()); }
        catch { /* defensive only */ }
        var entityIds = await db.ConfigVersions.AsNoTracking()
            .Where(v => pinnedIds.Contains(v.Id))
            .Select(v => v.EntityId)
            .Distinct()
            .ToListAsync();
        foreach (var entityId in entityIds)
        {
            var ent = await db.ConfigEntities.FirstOrDefaultAsync(e => e.Id == entityId);
            if (ent is not null) { ent.Locked = false; ent.UpdatedAt = DateTime.UtcNow; }
        }
        await db.SaveChangesAsync();

        // 5. Commission accrual for the tenant-day (UC-15) — idempotent; non-blocking.
        if (room.TenantId is not null)
        {
            try
            {
                var outcome = await commission.RunAccrualForTenantDayAsync(room.TenantId, CommissionService.DayKey(DateTime.UtcNow));
                if (!outcome.Skipped)
                    logger.LogInformation("[engine] commission accrual {Tenant} {Day}: turnover {Turnover} × {Rate}bps = {Commission}",
                        room.TenantId, outcome.Day, outcome.TurnoverSantim, outcome.RateBps, outcome.CommissionSantim);
            }
            catch (Exception err)
            {
                logger.LogError(err, "[engine] accrual failed for tenant {Tenant} (non-blocking)", room.TenantId);
            }
        }

        DropRoomState(roomId);
        logger.LogInformation("[engine] {Title} → COMPLETED (gross {Gross}, prizes {Prizes})", room.Title, room.GrossSantim, prizesPaid);
    }

    private async Task PersistRoundReportAsync(string roomId)
    {
        var room = await db.Rooms.AsNoTracking().FirstAsync(r => r.Id == roomId);
        int ballCount = await db.BallDraws.CountAsync(b => b.RoomId == roomId);
        int ticketCount = await db.Tickets.CountAsync(t => t.RoomId == roomId);
        var claims = await db.Claims.AsNoTracking().Where(c => c.RoomId == roomId && c.Status == "CONFIRMED").ToListAsync();
        long prizesPaid = claims.Sum(c => c.AwardSantim ?? 0);
        string escrowCode = LedgerCodes.RoundEscrow(roomId);
        var escrow = await db.LedgerAccounts.AsNoTracking().FirstOrDefaultAsync(a => a.Code == escrowCode);
        long residual = escrow is null ? 0
            : await db.WalletBalances.AsNoTracking().Where(w => w.AccountId == escrow.Id).Select(w => w.BalanceSantim).FirstOrDefaultAsync();

        var payload = new
        {
            roomId,
            title = room.Title,
            variantId = room.VariantId,
            grossSantim = room.GrossSantim.ToString(),
            netPoolSantim = room.NetPoolSantim.ToString(),
            prizesSantim = prizesPaid.ToString(),
            residualSantim = residual.ToString(),
            ballsDrawn = ballCount,
            ticketsSold = ticketCount,
            claims = claims.Count,
            completedAt = DateTime.UtcNow.ToString("o"),
        };
        var existing = await db.RoundReports.FirstOrDefaultAsync(r => r.RoomId == roomId);
        if (existing is null)
            db.RoundReports.Add(new RoundReport { Id = Ids.New(), RoomId = roomId, PayloadJson = JsonSerializer.Serialize(payload) });
        else
            existing.PayloadJson = JsonSerializer.Serialize(payload);
        await db.SaveChangesAsync();
    }

    // ── Rolling scheduler (the lobby never runs dry) ────────────────────────

    public async Task<List<string>> EnsureRollingRoomsAsync(int keepAhead = 3)
    {
        var templates = await db.ConfigEntities.AsNoTracking()
            .Where(e => e.Type == "ROOM_TEMPLATE" && e.CurrentVersion > 0 && !e.Locked)
            .ToListAsync();
        var created = new List<string>();
        foreach (var tpl in templates)
        {
            var version = await db.ConfigVersions.AsNoTracking()
                .FirstOrDefaultAsync(v => v.EntityId == tpl.Id && v.Version == tpl.CurrentVersion);
            if (version is null) continue;
            var payload = JsonDocument.Parse(version.PayloadJson).RootElement;
            string title = payload.GetProperty("title").GetString()!;
            string variantId = payload.GetProperty("variantId").GetString()!;
            long priceSantim = long.Parse(payload.GetProperty("priceSantim").GetString()!);
            int cadenceMinutes = payload.GetProperty("cadenceMinutes").GetInt32();
            int salesOpenMinutes = payload.GetProperty("salesOpenMinutes").GetInt32();
            int salesMinutes = payload.GetProperty("salesMinutes").GetInt32();
            int ballIntervalMs = payload.TryGetProperty("ballIntervalMs", out var bi) ? bi.GetInt32() : 2000;
            bool autoClaim = payload.TryGetProperty("autoClaim", out var ac) && ac.ValueKind == JsonValueKind.True;
            string rulesetRef = payload.GetProperty("rulesetRef").GetString()!;

            var liveStatuses = new[] { "SCHEDULED", "SALES_OPEN", "LOCKED", "DRAWING" };
            var last = await db.Rooms.AsNoTracking()
                .Where(r => r.TemplateVersionId == version.Id && liveStatuses.Contains(r.Status))
                .OrderByDescending(r => r.ScheduledAt)
                .FirstOrDefaultAsync();
            int upcoming = await db.Rooms.CountAsync(r => r.TemplateVersionId == version.Id && liveStatuses.Contains(r.Status));

            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            long nextStartMs = last is not null
                ? new DateTimeOffset(last.ScheduledAt, TimeSpan.Zero).ToUnixTimeMilliseconds() + cadenceMinutes * 60_000L
                : nowMs + 90_000;
            if (nextStartMs < nowMs) nextStartMs = nowMs + 90_000;

            for (int i = upcoming; i < keepAhead; i++)
            {
                var rulesetEntity = await db.ConfigEntities.AsNoTracking().FirstOrDefaultAsync(e => e.Id == rulesetRef);
                if (rulesetEntity is null) break;
                var rulesetVersionRow = await db.ConfigVersions.AsNoTracking()
                    .FirstOrDefaultAsync(v => v.EntityId == rulesetRef && v.Version == rulesetEntity.CurrentVersion);
                if (rulesetVersionRow is null) break;

                var patternVersionIds = new List<string>();
                if (payload.TryGetProperty("patternRefs", out var refs))
                    foreach (var pref in refs.EnumerateArray())
                    {
                        string prefId = pref.GetString()!;
                        var ent = await db.ConfigEntities.AsNoTracking().FirstOrDefaultAsync(e => e.Id == prefId);
                        if (ent is null || ent.CurrentVersion == 0) continue;
                        var pv = await db.ConfigVersions.AsNoTracking()
                            .FirstOrDefaultAsync(v => v.EntityId == prefId && v.Version == ent.CurrentVersion);
                        if (pv is not null) patternVersionIds.Add(pv.Id);
                    }

                var nextStart = DateTimeOffset.FromUnixTimeMilliseconds(nextStartMs).UtcDateTime;
                var room = new Room
                {
                    Id = Ids.New(),
                    TenantId = tpl.TenantId,
                    Title = title,
                    TemplateVersionId = version.Id,
                    RulesetVersionId = rulesetVersionRow.Id,
                    PatternVersionIds = JsonSerializer.Serialize(patternVersionIds),
                    VariantId = variantId,
                    PriceSantim = priceSantim,
                    BallIntervalMs = ballIntervalMs,
                    AutoClaim = autoClaim,
                    ScheduledAt = nextStart,
                    SalesOpenAt = nextStart.AddMinutes(-salesOpenMinutes),
                    SalesCloseAt = nextStart.AddMinutes(salesMinutes),
                };
                db.Rooms.Add(room);
                await db.SaveChangesAsync();
                created.Add(room.Id);
                nextStartMs += cadenceMinutes * 60_000L;
            }
        }
        return created;
    }
}
