namespace BingoRoyale.Api.Domain;

// ── Tenancy ─────────────────────────────────────────────────────────────────

public class Tenant
{
    public string Id { get; set; } = "";
    public string Code { get; set; } = "";
    public string LegalName { get; set; } = "";
    public string Tin { get; set; } = "";
    public string Jurisdiction { get; set; } = "";
    public string ContactEmail { get; set; } = "";
    public string ContactPhone { get; set; } = "";
    public string Status { get; set; } = "REGISTERED";
    public string? StatusReason { get; set; }
    public string BeneficialOwners { get; set; } = "[]";
    public string? DocumentSetHash { get; set; }
    public DateTime? ApprovedAt { get; set; }
    public DateTime? SuspendedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class KybReview
{
    public string Id { get; set; } = "";
    public string TenantId { get; set; } = "";
    public string OfficerId { get; set; } = "";
    public string Decision { get; set; } = "";
    public string Note { get; set; } = "";
    public string? DocumentSetHash { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

// ── Identity & access (UC-01) ───────────────────────────────────────────────

public class User
{
    public string Id { get; set; } = "";
    /// <summary>AES-256-GCM encrypted envelope (FR-SEC-01).</summary>
    public string PhoneE164 { get; set; } = "";
    public string PhoneBlindIdx { get; set; } = "";
    public string? DisplayName { get; set; }
    public string Role { get; set; } = "PLAYER";
    public string? TenantId { get; set; }
    public string Status { get; set; } = "ACTIVE";
    public string? StatusReason { get; set; }
    public string Locale { get; set; } = "en";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastLoginAt { get; set; }
}

public class OtpCode
{
    public string Id { get; set; } = "";
    public string PhoneIdx { get; set; } = "";
    public string CodeHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
    public int Attempts { get; set; }
    public DateTime? ConsumedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class Session
{
    public string Id { get; set; } = "";
    public string UserId { get; set; } = "";
    public string RefreshHash { get; set; } = "";
    public string? UserAgent { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? RevokedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

// ── Ledger (FR-FIN) — append-only double-entry ──────────────────────────────

public class LedgerAccount
{
    public string Id { get; set; } = "";
    public string Code { get; set; } = "";
    public string Type { get; set; } = "";
    public string? TenantId { get; set; }
    public string? OwnerUserId { get; set; }
    public string DisplayName { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class JournalTransaction
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public string IdempotencyKey { get; set; } = "";
    public string? RoundId { get; set; }
    public string? TenantId { get; set; }
    public string Memo { get; set; } = "";
    public bool Demo { get; set; } = true;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class JournalEntry
{
    public string Id { get; set; } = "";
    public string TransactionId { get; set; } = "";
    public string AccountId { get; set; } = "";
    public string Direction { get; set; } = "";
    public long AmountSantim { get; set; }
    public int Seq { get; set; }
}

public class WalletBalance
{
    public string AccountId { get; set; } = "";
    public long BalanceSantim { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

// ── Game content — versioned configuration ──────────────────────────────────

public class Variant
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string GridSpec { get; set; } = "";
    public bool Active { get; set; } = true;
}

public class ConfigEntity
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public string? TenantId { get; set; }
    public string Name { get; set; } = "";
    public int CurrentVersion { get; set; }
    public bool Locked { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class ConfigVersion
{
    public string Id { get; set; } = "";
    public string EntityId { get; set; } = "";
    public int Version { get; set; }
    public string PayloadJson { get; set; } = "";
    public string PayloadHash { get; set; } = "";
    public DateTime PublishedAt { get; set; } = DateTime.UtcNow;
    public string PublishedById { get; set; } = "";
}

// ── Rooms & rounds ──────────────────────────────────────────────────────────

public class Room
{
    public string Id { get; set; } = "";
    public string? TenantId { get; set; }
    public string Title { get; set; } = "";
    public string TemplateVersionId { get; set; } = "";
    public string RulesetVersionId { get; set; } = "";
    public string PatternVersionIds { get; set; } = "[]";
    public string VariantId { get; set; } = "";
    public string Status { get; set; } = "SCHEDULED";
    public long PriceSantim { get; set; }
    public int MaxCardsPerPlayer { get; set; } = 6;
    public int BallIntervalMs { get; set; } = 4000;
    public bool AutoClaim { get; set; } = true;
    public DateTime ScheduledAt { get; set; }
    public DateTime SalesOpenAt { get; set; }
    public DateTime SalesCloseAt { get; set; }
    public long GrossSantim { get; set; }
    public long NetPoolSantim { get; set; }
    public DateTime? CommittedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public DateTime? VoidedAt { get; set; }
    public string? VoidReason { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class BallDraw
{
    public string Id { get; set; } = "";
    public string RoomId { get; set; } = "";
    public int Seq { get; set; }
    public int Ball { get; set; }
    public DateTime CalledAt { get; set; } = DateTime.UtcNow;
}

public class FairnessSeal
{
    public string Id { get; set; } = "";
    public string RoomId { get; set; } = "";
    public string Commitment { get; set; } = "";
    public string ClientSeedContribution { get; set; } = "";
    public int Nonce { get; set; }
    public string ServerSeedEnc { get; set; } = "";
    public string Salt { get; set; } = "";
    public string? RevealedSeed { get; set; }
    public DateTime? RevealedAt { get; set; }
    public string InputHash { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class Ticket
{
    public string Id { get; set; } = "";
    public string RoomId { get; set; } = "";
    public string PlayerId { get; set; } = "";
    public string? TenantId { get; set; }
    public string NumbersJson { get; set; } = "";
    public string Fingerprint { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class Purchase
{
    public string Id { get; set; } = "";
    public string IdempotencyKey { get; set; } = "";
    public string RoomId { get; set; } = "";
    public string PlayerId { get; set; } = "";
    public int Quantity { get; set; }
    public long TotalSantim { get; set; }
    public string JournalTxId { get; set; } = "";
    public string Status { get; set; } = "CONFIRMED";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class Claim
{
    public string Id { get; set; } = "";
    public string ClientClaimId { get; set; } = "";
    public string RoomId { get; set; } = "";
    public string TicketId { get; set; } = "";
    public string PlayerId { get; set; } = "";
    public string PatternVersionId { get; set; } = "";
    public int BallSeq { get; set; }
    public string Status { get; set; } = "PENDING";
    public string? ReasonCode { get; set; }
    public long? AwardSantim { get; set; }
    public string? JournalTxId { get; set; }
    public DateTime? DecidedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

// ── Payments (UC-02 demo rail) ──────────────────────────────────────────────

public class DepositIntent
{
    public string Id { get; set; } = "";
    public string IdempotencyKey { get; set; } = "";
    public string UserId { get; set; } = "";
    public long AmountSantim { get; set; }
    public string PayloadHash { get; set; } = "";
    public string Status { get; set; } = "PENDING";
    public string? ProviderRef { get; set; }
    public string? JournalTxId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ConfirmedAt { get; set; }
}

// ── Events (transactional outbox, ADR-03) + audit ───────────────────────────

public class OutboxEvent
{
    public int Id { get; set; }
    public string Type { get; set; } = "";
    public string AggregateId { get; set; } = "";
    public string PayloadJson { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? PublishedAt { get; set; }
    public string? Consumer { get; set; }
}

public class AuditRecord
{
    public int Id { get; set; }
    public string? ActorId { get; set; }
    public string? ActorRole { get; set; }
    public string? TenantId { get; set; }
    public string Action { get; set; } = "";
    public string EntityType { get; set; } = "";
    public string EntityId { get; set; } = "";
    public string? PayloadHash { get; set; }
    public string? MetaJson { get; set; }
    public DateTime At { get; set; } = DateTime.UtcNow;
}

// ── Reporting & commission ──────────────────────────────────────────────────

public class RoundReport
{
    public string Id { get; set; } = "";
    public string RoomId { get; set; } = "";
    public string PayloadJson { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class CommissionPlan
{
    public string Id { get; set; } = "";
    public string TenantId { get; set; } = "";
    public string Basis { get; set; } = "TURNOVER";
    public int RateBps { get; set; }
    public DateTime EffectiveFrom { get; set; }
    public string PayloadHash { get; set; } = "";
    public string? DraftId { get; set; }
    public string ApprovedById { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class DailyAccrual
{
    public string Id { get; set; } = "";
    public string TenantId { get; set; } = "";
    public string Day { get; set; } = "";
    public long TurnoverSantim { get; set; }
    public int RateBps { get; set; }
    public string PlanId { get; set; } = "";
    public long CommissionSantim { get; set; }
    public string JournalTxId { get; set; } = "";
    public DateTime ComputedAt { get; set; } = DateTime.UtcNow;
}
