using BingoRoyale.Api.Data;
using BingoRoyale.Api.Domain;
using BingoRoyale.Core;
using Microsoft.EntityFrameworkCore;

namespace BingoRoyale.Api.Services;

/// <summary>
/// Tier payment — the shared awarding core (FR-PLY-02, ADR-16). Both awarding
/// paths use this exact code so the maths can never drift:
///   · engine auto-claim (room.autoClaim = true) — pays on the ball tick;
///   · player BINGO! claims (room.autoClaim = false) — pays on claim (UC-04).
/// One paying tier is exactly: one balanced PRIZE journal, one Claim row per
/// winning ticket, one AWARDS_RESOLVED outbox event, one audit line — and the
/// net-pool decrement on the room row. Simultaneous winners split floor-first.
/// </summary>
public class PayService(AppDbContext db, LedgerService ledger, IRoomBroadcaster broadcaster)
{
    public record TierWinnerRef(string TicketId, string PlayerId);

    public record PayTierInput(
        string RoomId, string RoomTitle, string? TenantId,
        string PatternEntityId, string PatternVersionId, string PatternLabel,
        PrizeRule Rule, int Seq, int Ball,
        IReadOnlyList<TierWinnerRef> Winners, string ClaimKind, string? ClaimPlayerId = null);

    public record PayTierResult(long Tier, long Each, long Total);

    public async Task<PayTierResult> PayTierAsync(PayTierInput input)
    {
        // Tier amounts always recompute from the room row (FR-PLY-02: live
        // preview equals engine maths — same function, same inputs).
        var fresh = await db.Rooms.AsNoTracking().FirstAsync(r => r.Id == input.RoomId);
        long tier = PrizeRules.TierAmountFor(input.Rule, fresh.GrossSantim, fresh.NetPoolSantim);
        long each = tier > 0 ? tier / input.Winners.Count : 0;
        long total = each * input.Winners.Count;

        PostedTx? posted = null;
        if (total > 0)
        {
            var entries = new List<EntryInput>
            {
                new(LedgerCodes.RoundEscrow(input.RoomId), "LIABILITY", $"Round escrow — {input.RoomTitle}",
                    "DEBIT", total, input.TenantId),
            };
            entries.AddRange(input.Winners.Select(w => new EntryInput(
                LedgerCodes.PlayerWallet(w.PlayerId), "LIABILITY", "Player wallet",
                "CREDIT", each, null, w.PlayerId)));
            string memo = $"Prize \"{input.PatternLabel}\" — {input.Winners.Count} winner(s), ball #{input.Ball} @{input.Seq}"
                          + (input.ClaimKind == "player" ? " (BINGO! claim)" : "");
            posted = await ledger.PostTransactionAsync(new PostTxInput(
                "PRIZE", $"prize:{input.RoomId}:{input.PatternEntityId}:{input.Seq}", memo,
                input.RoomId, input.TenantId, entries));
        }

        foreach (var w in input.Winners)
        {
            string prefix = input.ClaimKind == "auto" ? "auto" : $"player:{input.ClaimPlayerId}";
            db.Claims.Add(new Claim
            {
                Id = Ids.New(),
                ClientClaimId = $"{prefix}:{input.RoomId}:{input.PatternEntityId}:{w.TicketId}",
                RoomId = input.RoomId,
                TicketId = w.TicketId,
                PlayerId = w.PlayerId,
                PatternVersionId = input.PatternVersionId,
                BallSeq = input.Seq,
                Status = "CONFIRMED",
                AwardSantim = total > 0 ? each : null,
                JournalTxId = posted?.Id,
                DecidedAt = DateTime.UtcNow,
            });
        }

        if (total > 0)
        {
            await db.Rooms.Where(r => r.Id == input.RoomId)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(r => r.NetPoolSantim, fresh.NetPoolSantim - total)
                    .SetProperty(r => r.UpdatedAt, DateTime.UtcNow));
        }

        var winnersPayload = input.Winners.Select(w => new { playerId = w.PlayerId, ticketId = w.TicketId, award = each.ToString() });
        await ledger.EmitOutboxAsync("AWARDS_RESOLVED", input.RoomId, new
        {
            roomId = input.RoomId,
            seq = input.Seq,
            ball = input.Ball,
            patternId = input.PatternEntityId,
            label = input.PatternLabel,
            tier = tier.ToString(),
            each = each.ToString(),
            winners = winnersPayload,
        });
        await broadcaster.PublishAsync(input.RoomId, "AWARDS_RESOLVED", new
        {
            roomId = input.RoomId,
            seq = input.Seq,
            ball = input.Ball,
            patternId = input.PatternEntityId,
            label = input.PatternLabel,
            tier = tier.ToString(),
            each = each.ToString(),
            winners = winnersPayload,
        });

        await ledger.AuditAsync("AWARD_CONFIRMED", "Claim", $"{input.RoomId}:{input.PatternEntityId}:{input.Seq}",
            actorId: input.ClaimKind == "player" ? input.ClaimPlayerId : null,
            actorRole: input.ClaimKind == "auto" ? "ENGINE" : "PLAYER",
            tenantId: input.TenantId,
            meta: new { ball = input.Ball, seq = input.Seq, winners = input.Winners.Count, tier = tier.ToString(), each = each.ToString(), via = input.ClaimKind });

        return new PayTierResult(tier, each, total);
    }
}
