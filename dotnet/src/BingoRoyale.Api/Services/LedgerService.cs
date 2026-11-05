using BingoRoyale.Api.Data;
using BingoRoyale.Api.Domain;
using BingoRoyale.Core;
using Microsoft.EntityFrameworkCore;

namespace BingoRoyale.Api.Services;

public record class EntryInput(
    string AccountCode, string AccountType, string AccountName,
    string Direction, long Amount, string? TenantId = null, string? OwnerUserId = null);

public record class PostTxInput(
    string Kind, string IdempotencyKey, string Memo, string? RoundId, string? TenantId,
    IReadOnlyList<EntryInput> Entries);

public record class PostedTx(string Id, string IdempotencyKey, bool Replayed);

/// <summary>
/// Journal posting (FR-FIN-01) — the only door into the double-entry ledger.
/// Guarantees (identical to src/modules/ledger/post.ts):
///   · idempotencyKey unique — a replayed key returns the ORIGINAL transaction;
///   · balanced invariant sum(DEBIT) == sum(CREDIT), asserted before write;
///   · projection beside journal (ADR-04) — WalletBalance in the same transaction.
/// </summary>
public class LedgerService(AppDbContext db)
{
    /// <summary>Get-or-create an account inside the current transaction.</summary>
    private async Task<LedgerAccount> EnsureAccountTxAsync(EntryInput e)
    {
        var existing = await db.LedgerAccounts.FirstOrDefaultAsync(a => a.Code == e.AccountCode);
        if (existing is not null) return existing;
        var acc = new LedgerAccount
        {
            Id = Ids.New(),
            Code = e.AccountCode,
            Type = e.AccountType,
            DisplayName = e.AccountName,
            TenantId = e.TenantId,
            OwnerUserId = e.OwnerUserId,
        };
        db.LedgerAccounts.Add(acc);
        return acc;
    }

    public async Task<PostedTx> PostTransactionAsync(PostTxInput input)
    {
        if (input.Entries.Count < 2)
            throw new ApiError("VALIDATION_FAILED", "journal needs at least two entries");

        // 1. Idempotency: same key → replay the original result.
        var existingTx = await db.JournalTransactions
            .AsNoTracking()
            .FirstOrDefaultAsync(t => t.IdempotencyKey == input.IdempotencyKey);
        if (existingTx is not null)
            return new PostedTx(existingTx.Id, existingTx.IdempotencyKey, true);

        // 2. Validate: positive amounts, balanced sums.
        long debits = 0, credits = 0;
        foreach (var e in input.Entries)
        {
            if (e.Amount <= 0) throw new ApiError("VALIDATION_FAILED", "journal amounts must be positive");
            if (e.Direction == "DEBIT") debits = checked(debits + e.Amount);
            else credits = checked(credits + e.Amount);
        }
        if (debits != credits)
            throw new ApiError("INTERNAL", $"unbalanced journal {debits} != {credits} for {input.Kind}");

        // 3. SERIALIZABLE debit path (Architecture v5.0 / FR-FIN-01): account
        //    get-or-create, journal rows and the WalletBalance projection commit
        //    atomically under SERIALIZABLE isolation. A serialization failure
        //    (SQLSTATE 40001) clears the change tracker and retries once.
        for (int attempt = 1; ; attempt++)
        {
            try
            {
                await using var tx = await db.Database.BeginTransactionAsync(
                    System.Data.IsolationLevel.Serializable);
                var posted = await PostValidatedTxAsync(input);
                await tx.CommitAsync();
                return posted;
            }
            catch (Npgsql.PostgresException pe) when (pe.SqlState == "40001" && attempt < 2)
            {
                db.ChangeTracker.Clear(); // retry with a clean unit of work
            }
        }
    }

    /// <summary>Journal + projection write; caller owns validation and the transaction.</summary>
    private async Task<PostedTx> PostValidatedTxAsync(PostTxInput input)
    {
        // Resolve accounts (get-or-create inside the transaction).
        var accounts = new Dictionary<string, LedgerAccount>();
        foreach (var e in input.Entries)
            if (!accounts.ContainsKey(e.AccountCode))
                accounts[e.AccountCode] = await EnsureAccountTxAsync(e);

        // 4. Create transaction + entries.
        var trx = new JournalTransaction
        {
            Id = Ids.New(),
            Kind = input.Kind,
            IdempotencyKey = input.IdempotencyKey,
            Memo = input.Memo,
            RoundId = input.RoundId,
            TenantId = input.TenantId,
            Demo = true,
        };
        db.JournalTransactions.Add(trx);
        for (int idx = 0; idx < input.Entries.Count; idx++)
        {
            var e = input.Entries[idx];
            db.JournalEntries.Add(new JournalEntry
            {
                Id = Ids.New(),
                TransactionId = trx.Id,
                AccountId = accounts[e.AccountCode].Id,
                Direction = e.Direction,
                AmountSantim = e.Amount,
                Seq = idx,
            });
        }

        // Update projections in the same transaction.
        foreach (var (code, acc) in accounts)
        {
            long delta = 0;
            foreach (var e in input.Entries.Where(x => x.AccountCode == code))
            {
                bool isDebit = e.Direction == "DEBIT";
                delta += LedgerCodes.NaturalBalance(acc.Type, isDebit ? e.Amount : 0, isDebit ? 0 : e.Amount);
            }
            if (delta == 0) continue;
            var proj = await db.WalletBalances.FirstOrDefaultAsync(w => w.AccountId == acc.Id);
            if (proj is not null)
            {
                proj.BalanceSantim = checked(proj.BalanceSantim + delta);
                proj.UpdatedAt = DateTime.UtcNow;
            }
            else
            {
                db.WalletBalances.Add(new WalletBalance { AccountId = acc.Id, BalanceSantim = delta });
            }
        }

        await db.SaveChangesAsync();
        return new PostedTx(trx.Id, trx.IdempotencyKey, false);
    }

    public async Task EmitOutboxAsync(string type, string aggregateId, object payload, string consumer = "gateway")
    {
        db.OutboxEvents.Add(new OutboxEvent
        {
            Type = type,
            AggregateId = aggregateId,
            PayloadJson = System.Text.Json.JsonSerializer.Serialize(payload),
            Consumer = consumer,
        });
        await db.SaveChangesAsync();
    }

    public async Task AuditAsync(string action, string entityType, string entityId,
        string? actorId = null, string? actorRole = null, string? tenantId = null, object? meta = null)
    {
        db.AuditRecords.Add(new AuditRecord
        {
            Action = action,
            EntityType = entityType,
            EntityId = entityId,
            ActorId = actorId,
            ActorRole = actorRole,
            TenantId = tenantId,
            MetaJson = meta is null ? null : System.Text.Json.JsonSerializer.Serialize(meta),
        });
        await db.SaveChangesAsync();
    }

    public async Task<long> WalletBalanceOfAsync(string userId)
    {
        var acc = await db.LedgerAccounts.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Code == LedgerCodes.PlayerWallet(userId));
        if (acc is null) return 0;
        var proj = await db.WalletBalances.AsNoTracking().FirstOrDefaultAsync(w => w.AccountId == acc.Id);
        return proj?.BalanceSantim ?? 0;
    }

    public async Task<(long Balance, LedgerAccount Account)> WalletBalanceWithAccountAsync(string userId)
    {
        var acc = await db.LedgerAccounts.FirstAsync(a => a.Code == LedgerCodes.PlayerWallet(userId));
        var proj = await db.WalletBalances.FirstOrDefaultAsync(w => w.AccountId == acc.Id);
        return (proj?.BalanceSantim ?? 0, acc);
    }
}

/// <summary>API error with a stable machine code — maps to the TS ApiError envelope.</summary>
public class ApiError(string code, string? message = null) : Exception(message ?? code)
{
    public string Code { get; } = code;

    public int Status => Code switch
    {
        "UNAUTHENTICATED" => 401,
        "FORBIDDEN" => 403,
        "NOT_FOUND" or "ROOM_NOT_FOUND" => 404,
        "VALIDATION_FAILED" or "INVALID_PHONE" or "INVALID_OR_EXPIRED_OTP" or "RATE_LIMITED"
            or "MAX_CARDS_REACHED" or "INSUFFICIENT_FUNDS" or "SALES_CLOSED" or "IDEMPOTENCY_CONFLICT"
            or "BAD_SPEED" or "BAD_PRICE" or "PRICE_LOCKED" or "SPEED_OUT_OF_RANGE" => 400,
        _ => 500,
    }
        ;
}
