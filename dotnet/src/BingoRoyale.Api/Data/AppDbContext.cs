using System.Text;
using BingoRoyale.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace BingoRoyale.Api.Data;

/// <summary>Cuid-like id generator: "c" + base36 timestamp + random suffix.</summary>
public static class Ids
{
    private const string Chars = "0123456789abcdefghijklmnopqrstuvwxyz";

    public static string New()
    {
        long ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var sb = new StringBuilder("c", 26);
        long t = ts;
        var tsChars = new char[8];
        for (int i = 7; i >= 0; i--) { tsChars[i] = Chars[(int)(t % 36)]; t /= 36; }
        sb.Append(tsChars);
        for (int i = 0; i < 16; i++) sb.Append(Chars[Random.Shared.Next(36)]);
        return sb.ToString();
    }
}

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Tenant> Tenants => Set<Tenant>();
    public DbSet<KybReview> KybReviews => Set<KybReview>();
    public DbSet<User> Users => Set<User>();
    public DbSet<OtpCode> OtpCodes => Set<OtpCode>();
    public DbSet<Session> Sessions => Set<Session>();
    public DbSet<LedgerAccount> LedgerAccounts => Set<LedgerAccount>();
    public DbSet<JournalTransaction> JournalTransactions => Set<JournalTransaction>();
    public DbSet<JournalEntry> JournalEntries => Set<JournalEntry>();
    public DbSet<WalletBalance> WalletBalances => Set<WalletBalance>();
    public DbSet<Variant> Variants => Set<Variant>();
    public DbSet<ConfigEntity> ConfigEntities => Set<ConfigEntity>();
    public DbSet<ConfigVersion> ConfigVersions => Set<ConfigVersion>();
    public DbSet<Room> Rooms => Set<Room>();
    public DbSet<BallDraw> BallDraws => Set<BallDraw>();
    public DbSet<FairnessSeal> FairnessSeals => Set<FairnessSeal>();
    public DbSet<Ticket> Tickets => Set<Ticket>();
    public DbSet<Purchase> Purchases => Set<Purchase>();
    public DbSet<Claim> Claims => Set<Claim>();
    public DbSet<DepositIntent> DepositIntents => Set<DepositIntent>();
    public DbSet<OutboxEvent> OutboxEvents => Set<OutboxEvent>();
    public DbSet<AuditRecord> AuditRecords => Set<AuditRecord>();
    public DbSet<RoundReport> RoundReports => Set<RoundReport>();
    public DbSet<CommissionPlan> CommissionPlans => Set<CommissionPlan>();
    public DbSet<DailyAccrual> DailyAccruals => Set<DailyAccrual>();

    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<WalletBalance>().HasKey(w => w.AccountId);
        mb.Entity<User>().HasIndex(u => u.PhoneBlindIdx).IsUnique();
        mb.Entity<Session>().HasIndex(s => s.RefreshHash).IsUnique();
        mb.Entity<LedgerAccount>().HasIndex(a => a.Code).IsUnique();
        mb.Entity<LedgerAccount>().HasIndex(a => a.OwnerUserId).IsUnique();
        mb.Entity<JournalTransaction>().HasIndex(t => t.IdempotencyKey).IsUnique();
        mb.Entity<JournalTransaction>().HasIndex(t => new { t.TenantId, t.Kind });
        mb.Entity<JournalEntry>().HasIndex(e => e.AccountId);
        mb.Entity<ConfigVersion>().HasIndex(v => new { v.EntityId, v.Version }).IsUnique();
        mb.Entity<ConfigEntity>().HasIndex(e => new { e.Type, e.TenantId });
        mb.Entity<Room>().HasIndex(r => new { r.Status, r.SalesOpenAt });
        mb.Entity<BallDraw>().HasIndex(b => new { b.RoomId, b.Seq }).IsUnique();
        mb.Entity<BallDraw>().HasIndex(b => new { b.RoomId, b.Ball }).IsUnique();
        mb.Entity<FairnessSeal>().HasIndex(s => s.RoomId).IsUnique();
        mb.Entity<Ticket>().HasIndex(t => new { t.RoomId, t.Fingerprint }).IsUnique();
        mb.Entity<Ticket>().HasIndex(t => new { t.PlayerId, t.RoomId });
        mb.Entity<Purchase>().HasIndex(p => p.IdempotencyKey).IsUnique();
        mb.Entity<Claim>().HasIndex(c => c.ClientClaimId).IsUnique();
        mb.Entity<Claim>().HasIndex(c => new { c.RoomId, c.Status });
        mb.Entity<DepositIntent>().HasIndex(d => d.IdempotencyKey).IsUnique();
        mb.Entity<OutboxEvent>().HasIndex(o => new { o.Type, o.AggregateId });
        mb.Entity<AuditRecord>().HasIndex(a => new { a.EntityType, a.EntityId });
        mb.Entity<RoundReport>().HasIndex(r => r.RoomId).IsUnique();
        mb.Entity<DailyAccrual>().HasIndex(a => new { a.TenantId, a.Day }).IsUnique();
        mb.Entity<Tenant>().HasIndex(t => t.Code).IsUnique();
        mb.Entity<OtpCode>().HasIndex(o => new { o.PhoneIdx, o.CreatedAt });
        mb.Entity<CommissionPlan>().HasIndex(c => new { c.TenantId, c.EffectiveFrom });
    }
}

/// <summary>
/// Process-wide write gate for the 1 s engine turn and demo write endpoints:
/// one writer at a time, complementing the SERIALIZABLE ledger transactions
/// mandated by Architecture v5.0 on PostgreSQL.
/// </summary>
public static class DbGate
{
    public static readonly SemaphoreSlim Write = new(1, 1);
}
