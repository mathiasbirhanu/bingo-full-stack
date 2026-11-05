namespace BingoRoyale.Core;

/// <summary>
/// Ledger account codes (FR-FIN-01) — the contract between every money-moving
/// module; they appear verbatim in journal entries and reports.
/// Natural-balance rule: DEBIT raises ASSET/EXPENSE; CREDIT raises
/// LIABILITY/REVENUE/EQUITY. The projection stores the natural balance.
/// </summary>
public static class LedgerCodes
{
    public static string PlayerWallet(string userId) => $"PLAYER_WALLET:{userId}";
    public static string RoundEscrow(string roundId) => $"ROUND_ESCROW:{roundId}";
    public static string PaymentClearing() => "PAYMENT_CLEARING:DEMO";
    public static string PayoutClearing() => "PAYOUT_CLEARING:DEMO";
    public static string ExternalFunding() => "EXTERNAL_FUNDING";
    public static string HouseRevenue() => "HOUSE_REVENUE";
    public static string PlatformCommission(string tenantId) => $"PLATFORM_COMMISSION:{tenantId}";
    public static string PartnerPayable(string tenantId) => $"PARTNER_PAYABLE:{tenantId}";

    private static readonly HashSet<string> NaturalDebit = new() { "ASSET", "EXPENSE" };

    /// <summary>The wallet projection uses the account's natural balance.</summary>
    public static long NaturalBalance(string type, long debits, long credits) =>
        NaturalDebit.Contains(type) ? debits - credits : credits - debits;
}
