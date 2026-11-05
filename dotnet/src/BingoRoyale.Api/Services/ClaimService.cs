using System.Collections.Concurrent;
using System.Text.Json;
using BingoRoyale.Api.Data;
using BingoRoyale.Api.Domain;
using BingoRoyale.Core;
using Microsoft.EntityFrameworkCore;

namespace BingoRoyale.Api.Services;

/// <summary>
/// Player BINGO! claims — the manual-play path (UC-04, room.autoClaim = false).
/// Port of engine/claim.ts. Semantics (honest by construction):
///   · the server never trusts client daubs — every claim validates against
///     the CALLED-ball set;
///   · the caller must have DAUBED every pattern cell on the card they claim
///     with — daubs arrive per card and are intersected with the called set;
///   · the tier pays across EVERY ticket in the room completing it (tie split);
///   · rolled-up patterns never pay; the tier closes at first payment;
///   · claims serialize per room with a mutex (two taps racing a tick resolve
///     one after the other, never twice).
/// </summary>
public class ClaimService(AppDbContext db, EngineService engine, PayService pay, ILogger<ClaimService> logger)
{
    public record ClaimDaub(string TicketId, IReadOnlyList<int> Numbers);

    public record ClaimOutcome(
        bool Claimed, string? Reason = null, string? Message = null, string? Label = null,
        string? EachSantim = null, int? BallSeq = null, int? Winners = null,
        BestHint? Best = null);

    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Locks = new();

    private static SemaphoreSlim LockFor(string roomId) =>
        Locks.GetOrAdd(roomId, _ => new SemaphoreSlim(1, 1));

    public async Task<ClaimOutcome> ClaimPrizeAsync(string roomId, string playerId, IReadOnlyList<ClaimDaub> daubs)
    {
        var gate = LockFor(roomId);
        await gate.WaitAsync();
        try
        {
            return await ClaimPrizeInnerAsync(roomId, playerId, daubs);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<ClaimOutcome> ClaimPrizeInnerAsync(string roomId, string playerId, IReadOnlyList<ClaimDaub> daubs)
    {
        var room = await db.Rooms.FirstOrDefaultAsync(r => r.Id == roomId);
        if (room is null) return new ClaimOutcome(false, "ROOM_NOT_FOUND", "Round not found.");
        if (room.Status != "DRAWING")
            return new ClaimOutcome(false, "ROOM_NOT_DRAWING", "The round is not drawing right now.");
        if (room.AutoClaim)
            return new ClaimOutcome(false, "AUTO_CLAIM_ROOM", "This hall pays automatically — no tap needed.");

        // Grain state (rebuilt from the DB any time — crash-safe).
        var state = EngineService.RoomState(roomId) ?? await engine.BuildRoomStateAsync(room);
        if (state.Tickets is null) await LoadTicketsIntoAsync(state);

        // The called set from the system of record — client daubs are only UI.
        var balls = await db.BallDraws.AsNoTracking()
            .Where(b => b.RoomId == roomId)
            .OrderBy(b => b.Seq)
            .Select(b => new { b.Seq, b.Ball })
            .ToListAsync();
        var called = balls.Select(b => b.Ball).ToHashSet();
        int seq = balls.Count > 0 ? balls[^1].Seq : 0;
        int ball = balls.Count > 0 ? balls[^1].Ball : 0;

        // The caller's per-card daubs. Server truth applies twice: daubs for
        // cards the player doesn't hold are dropped, and every daub is
        // intersected with the called set inside pickClaim.
        var daubByTicket = new Dictionary<string, HashSet<int>>();
        if (daubs is not null)
            foreach (var d in daubs)
            {
                if (d is null || string.IsNullOrEmpty(d.TicketId) || d.Numbers is null) continue;
                daubByTicket[d.TicketId] = d.Numbers.Where(n => n >= 1 && n <= 90).ToHashSet();
            }

        var myTickets = new List<CallerTicket>();
        var allTickets = new List<RoomTicket>();
        foreach (var (ticketId, t) in state.Tickets!)
        {
            allTickets.Add(new RoomTicket { TicketId = ticketId, PlayerId = t.PlayerId, Cells = t.Cells });
            if (t.PlayerId == playerId)
                myTickets.Add(new CallerTicket
                {
                    TicketId = ticketId,
                    Cells = t.Cells,
                    Daubed = daubByTicket.TryGetValue(ticketId, out var set) ? set : new HashSet<int>(),
                });
        }
        if (myTickets.Count == 0)
            return new ClaimOutcome(false, "NO_TICKETS", "You hold no cards in this round.");

        var pick = ClaimCore.PickClaim(new PickInput
        {
            VariantId = room.VariantId,
            Rules = state.Rules.Select(r => new RuleLite { PatternRef = r.PatternRef, Label = r.Label }).ToList(),
            Patterns = state.Patterns,
            ClosedRules = state.ClosedRules,
            RolledRules = state.RolledRules,
            MyTickets = myTickets,
            AllTickets = allTickets,
            Called = called,
        });

        if (pick.Pattern is null)
        {
            return new ClaimOutcome(
                false, "NOT_YET",
                pick.Best is not null
                    ? $"Not yet — {pick.Best.Remaining} more for {pick.Best.Label}! Tap them on your card."
                    : "Not yet — keep tapping!",
                Best: pick.Best);
        }

        var rule = state.Rules[pick.RuleIndex];
        var res = await pay.PayTierAsync(new PayService.PayTierInput(
            roomId, room.Title, room.TenantId,
            pick.Pattern.EntityId, pick.Pattern.VersionId, pick.Pattern.Label,
            rule, seq, ball, pick.Winners.Select(w => new PayService.TierWinnerRef(w.TicketId, w.PlayerId)).ToList(), "player", playerId));

        // Keep the in-process grain in sync: the next tick must not re-award.
        state.ClosedRules.Add(pick.Pattern.EntityId);

        logger.LogInformation("[engine] {Title} ← BINGO! claim \"{Label}\" paid ball #{Ball} @{Seq} ({Count} winner(s))",
            room.Title, pick.Pattern.Label, ball, seq, pick.Winners.Count);

        return new ClaimOutcome(
            true, Label: pick.Pattern.Label, EachSantim: res.Each.ToString(),
            BallSeq: seq, Winners: pick.Winners.Count);
    }

    private async Task LoadTicketsIntoAsync(EngineRoomState state)
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
}
