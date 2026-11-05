using BingoRoyale.Api.Data;
using BingoRoyale.Api.Domain;
using BingoRoyale.Core;
using Microsoft.EntityFrameworkCore;

namespace BingoRoyale.Api.Services;

/// <summary>
/// Daily commission accrual (UC-15, FR-PRT-09, D-PRT-02 turnover basis) —
/// port of commission/accrual.ts.
///   commission = floor(turnoverSantim × rateBps / 10000) — int64 exact.
///   journal:   DR PLATFORM_COMMISSION:{tenantId} (expense)
///              CR PARTNER_PAYABLE:{tenantId}      (liability)
/// Idempotent per tenant-day; re-runs recompute the day's turnover and post
/// one delta adjustment when the truth moved.
/// </summary>
public class CommissionService(AppDbContext db, LedgerService ledger)
{
    public record AccrualOutcome(string TenantId, string Day, long TurnoverSantim, int RateBps,
        long CommissionSantim, bool Adjusted, bool Skipped);

    /// <summary>Ethiopia is UTC+3, no DST (PLATFORM_TIMEZONE = Africa/Addis_Ababa).</summary>
    public static string DayKey(DateTime utc) => utc.AddHours(3).Date.ToString("yyyy-MM-dd");

    private async Task<long> TurnoverForDayAsync(string tenantId, DateTime dayStartUtc, DateTime dayEndUtc)
    {
        // Turnover = confirmed purchase stakes for tenant-scoped rounds (D-PRT-02).
        var txIds = await db.JournalTransactions.AsNoTracking()
            .Where(t => t.Kind == "PURCHASE" && t.TenantId == tenantId && t.CreatedAt >= dayStartUtc && t.CreatedAt < dayEndUtc)
            .Select(t => t.Id)
            .ToListAsync();
        long sum = 0;
        var entries = await db.JournalEntries.AsNoTracking()
            .Where(e => txIds.Contains(e.TransactionId))
            .ToListAsync();
        // The CREDIT side of a purchase is the escrow leg — its amount is the stake.
        foreach (var e in entries)
            if (e.Direction == "CREDIT") sum = checked(sum + e.AmountSantim);
        return sum;
    }

    public async Task<AccrualOutcome> RunAccrualForTenantDayAsync(string tenantId, string day)
    {
        // Ethiopia is UTC+3 — day boundaries computed in that offset.
        var dayStartUtc = DateTime.Parse($"{day}T00:00:00").AddHours(-3);
        var dayEndUtc = dayStartUtc.AddHours(24);

        long turnover = await TurnoverForDayAsync(tenantId, dayStartUtc, dayEndUtc);
        var existing = await db.DailyAccruals.FirstOrDefaultAsync(a => a.TenantId == tenantId && a.Day == day);

        if (turnover == 0)
        {
            // Nothing to accrue — but an existing row must be corrected to zero
            // via adjustment, never silently deleted.
            if (existing is not null && existing.CommissionSantim > 0)
            {
                await ledger.PostTransactionAsync(new PostTxInput(
                    "COMMISSION_ACCRUAL", $"accrual-adj:{tenantId}:{day}:rev",
                    $"Accrual reversal — no turnover for {day}",
                    null, tenantId,
                    new List<EntryInput>
                    {
                        new(LedgerCodes.PlatformCommission(tenantId), "EXPENSE", "Platform commission", "CREDIT", existing.CommissionSantim, tenantId),
                        new(LedgerCodes.PartnerPayable(tenantId), "LIABILITY", "Partner payable", "DEBIT", existing.CommissionSantim, tenantId),
                    }));
                existing.TurnoverSantim = 0;
                existing.CommissionSantim = 0;
                await db.SaveChangesAsync();
                return new AccrualOutcome(tenantId, day, 0, existing.RateBps, 0, true, true);
            }
            return new AccrualOutcome(tenantId, day, 0, 0, 0, false, true);
        }

        var plan = await db.CommissionPlans.AsNoTracking()
            .Where(p => p.TenantId == tenantId && p.EffectiveFrom <= dayEndUtc)
            .OrderByDescending(p => p.EffectiveFrom)
            .FirstOrDefaultAsync();
        if (plan is null)
            return new AccrualOutcome(tenantId, day, turnover, 0, 0, false, true);

        long commission = Money.FloorBps(turnover, plan.RateBps);

        if (existing is null)
        {
            var posted = await ledger.PostTransactionAsync(new PostTxInput(
                "COMMISSION_ACCRUAL", $"accrual:{tenantId}:{day}",
                $"Commission {plan.RateBps} bps × turnover {turnover} snt ({day})",
                null, tenantId,
                new List<EntryInput>
                {
                    new(LedgerCodes.PlatformCommission(tenantId), "EXPENSE", "Platform commission", "DEBIT", commission, tenantId),
                    new(LedgerCodes.PartnerPayable(tenantId), "LIABILITY", "Partner payable", "CREDIT", commission, tenantId),
                }));
            db.DailyAccruals.Add(new DailyAccrual
            {
                Id = Data.Ids.New(),
                TenantId = tenantId,
                Day = day,
                TurnoverSantim = turnover,
                RateBps = plan.RateBps,
                PlanId = plan.Id,
                CommissionSantim = commission,
                JournalTxId = posted.Id,
            });
            await db.SaveChangesAsync();
            return new AccrualOutcome(tenantId, day, turnover, plan.RateBps, commission, false, false);
        }

        // Recompute path — delta adjustment if the day's truth moved.
        long delta = checked(commission - existing.CommissionSantim);
        if (delta == 0)
            return new AccrualOutcome(tenantId, day, turnover, plan.RateBps, commission, false, false);
        bool isIncrease = delta > 0;
        long abs = isIncrease ? delta : -delta;
        await ledger.PostTransactionAsync(new PostTxInput(
            "COMMISSION_ACCRUAL", $"accrual-adj:{tenantId}:{day}:{existing.CommissionSantim}",
            $"Accrual adjustment ({(isIncrease ? "+" : "-")}{abs} snt) for {day}",
            null, tenantId,
            isIncrease
                ? new List<EntryInput>
                {
                    new(LedgerCodes.PlatformCommission(tenantId), "EXPENSE", "Platform commission", "DEBIT", abs, tenantId),
                    new(LedgerCodes.PartnerPayable(tenantId), "LIABILITY", "Partner payable", "CREDIT", abs, tenantId),
                }
                : new List<EntryInput>
                {
                    new(LedgerCodes.PlatformCommission(tenantId), "EXPENSE", "Platform commission", "CREDIT", abs, tenantId),
                    new(LedgerCodes.PartnerPayable(tenantId), "LIABILITY", "Partner payable", "DEBIT", abs, tenantId),
                }));
        existing.TurnoverSantim = turnover;
        existing.CommissionSantim = commission;
        existing.RateBps = plan.RateBps;
        existing.PlanId = plan.Id;
        await db.SaveChangesAsync();
        return new AccrualOutcome(tenantId, day, turnover, plan.RateBps, commission, true, false);
    }
}
