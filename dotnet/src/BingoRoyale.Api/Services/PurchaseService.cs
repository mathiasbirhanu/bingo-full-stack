using System.Text.Json;
using BingoRoyale.Api.Data;
using BingoRoyale.Api.Domain;
using BingoRoyale.Core;
using Microsoft.EntityFrameworkCore;

namespace BingoRoyale.Api.Services;

public record CardDto(string TicketId, int?[][] Numbers, string Fingerprint);

public record PurchaseResult(
    bool Replayed, string PurchaseId, IReadOnlyList<CardDto> Cards,
    long BalanceSantim, long NewBalanceSantim);

/// <summary>
/// Purchase saga (UC-03, FR-PLY-03/04, FR-FIN-01) — port of rooms/purchase.ts.
/// Guarantees: exactly one debit and one card set per idempotency key;
/// MAX_CARDS_REACHED / SALES_CLOSED / INSUFFICIENT_FUNDS checked BEFORE any
/// debit; CSPRNG cards with fingerprint uniqueness; TICKET_CONFIRMED event.
/// </summary>
public class PurchaseService(AppDbContext db, LedgerService ledger, ILogger<PurchaseService> logger)
{
    public async Task<PurchaseResult> PurchaseCardsAsync(string roomId, string playerId, int quantity, string idempotencyKey)
    {
        if (quantity < 1)
            throw new ApiError("VALIDATION_FAILED", "quantity must be a positive integer");
        if (string.IsNullOrEmpty(idempotencyKey) || idempotencyKey.Length < 8 || idempotencyKey.Length > 128)
            throw new ApiError("VALIDATION_FAILED", "idempotency key required");

        // 1. Idempotent replay: same key → stored original result, never double-debit.
        var existing = await db.Purchases.AsNoTracking().FirstOrDefaultAsync(p => p.IdempotencyKey == idempotencyKey);
        if (existing is not null)
        {
            var replayTickets = await db.Tickets.AsNoTracking()
                .Where(t => t.RoomId == existing.RoomId && t.PlayerId == playerId && t.CreatedAt <= existing.CreatedAt)
                .OrderBy(t => t.CreatedAt)
                .ToListAsync();
            var walletAcc = await db.LedgerAccounts.AsNoTracking()
                .FirstOrDefaultAsync(a => a.Code == LedgerCodes.PlayerWallet(playerId));
            long replayBalance = 0;
            if (walletAcc is not null)
            {
                var proj = await db.WalletBalances.AsNoTracking().FirstOrDefaultAsync(w => w.AccountId == walletAcc.Id);
                replayBalance = proj?.BalanceSantim ?? 0;
            }
            return new PurchaseResult(
                true, existing.Id,
                replayTickets.Select(t => new CardDto(t.Id, JsonSerializer.Deserialize<int?[][]>(t.NumbersJson) ?? Array.Empty<int?[]>(), t.Fingerprint)).ToList(),
                existing.TotalSantim, replayBalance);
        }

        // 2. Room must be in sales window.
        var room = await db.Rooms.FirstOrDefaultAsync(r => r.Id == roomId)
            ?? throw new ApiError("ROOM_NOT_FOUND");
        if (room.Status != "SALES_OPEN")
            throw new ApiError("SALES_CLOSED", $"room is {room.Status}");

        // 3. Card cap BEFORE any debit (FR-PLY-03).
        int held = await db.Tickets.CountAsync(t => t.RoomId == roomId && t.PlayerId == playerId);
        if (held + quantity > room.MaxCardsPerPlayer)
            throw new ApiError("MAX_CARDS_REACHED", $"holds {held} of {room.MaxCardsPerPlayer}");

        // 4. Funds check BEFORE any debit.
        long total = checked(room.PriceSantim * quantity);
        var (balance, wallet) = await ledger.WalletBalanceWithAccountAsync(playerId);
        if (balance < total)
            throw new ApiError("INSUFFICIENT_FUNDS");

        // 5. Issue CSPRNG cards (retry on the rare fingerprint collision).
        var tickets = new List<CardDto>();
        for (int i = 0; i < quantity; i++)
        {
            bool done = false;
            for (int attempt = 0; attempt < 5 && !done; attempt++)
            {
                var (cells, fingerprint) = Cards.GenerateCard(room.VariantId);
                var ticket = new Ticket
                {
                    Id = Ids.New(),
                    RoomId = room.Id,
                    PlayerId = playerId,
                    TenantId = room.TenantId,
                    NumbersJson = JsonSerializer.Serialize(cells),
                    Fingerprint = fingerprint,
                };
                try
                {
                    db.Tickets.Add(ticket);
                    await db.SaveChangesAsync();
                    tickets.Add(new CardDto(ticket.Id, cells, fingerprint));
                    done = true;
                }
                catch (DbUpdateException ex) when (ex.InnerException?.Message.Contains("UNIQUE") == true)
                {
                    db.Entry(ticket).State = EntityState.Detached;
                    if (attempt == 4)
                        throw new ApiError("INTERNAL", "card fingerprint collision after 5 attempts");
                }
            }
        }

        // 6. Debit wallet → escrow, balanced and idempotent.
        var posted = await ledger.PostTransactionAsync(new PostTxInput(
            "PURCHASE", $"purchase:{idempotencyKey}",
            $"{quantity} card(s) @ {Money.SantimToEtb(room.PriceSantim)} ETB — room {room.Title}",
            room.Id, room.TenantId,
            new List<EntryInput>
            {
                new(LedgerCodes.PlayerWallet(playerId), "LIABILITY", "Player wallet", "DEBIT", total, null, playerId),
                new(LedgerCodes.RoundEscrow(room.Id), "LIABILITY", $"Round escrow — {room.Title}", "CREDIT", total, room.TenantId),
            }));

        var purchase = new Purchase
        {
            Id = Ids.New(),
            IdempotencyKey = idempotencyKey,
            RoomId = room.Id,
            PlayerId = playerId,
            Quantity = quantity,
            TotalSantim = total,
            JournalTxId = posted.Id,
        };
        db.Purchases.Add(purchase);

        // 7. Round financial counters (gross up, net pool follows gross until prizes flow).
        room.GrossSantim = checked(room.GrossSantim + total);
        room.NetPoolSantim = checked(room.NetPoolSantim + total);
        room.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        // 8. Ticket event for the room engine.
        await ledger.EmitOutboxAsync("TICKET_CONFIRMED", room.Id, new
        {
            purchaseId = purchase.Id,
            playerId,
            quantity,
            ticketIds = tickets.Select(t => t.TicketId),
        });
        await ledger.AuditAsync("PURCHASE_CONFIRMED", "Purchase", purchase.Id,
            actorId: playerId, actorRole: "PLAYER", tenantId: room.TenantId,
            meta: new { quantity, total = total.ToString(), journalTxId = posted.Id });

        long newBalance = await ledger.WalletBalanceOfAsync(playerId);
        logger.LogInformation("[purchase] {Player} bought {Qty} card(s) in {Title} for {Total} snt",
            playerId, quantity, room.Title, total);

        return new PurchaseResult(false, purchase.Id, tickets, balance, newBalance);
    }
}
