using System.Text.Json;
using BingoRoyale.Api.Data;
using BingoRoyale.Api.Domain;
using BingoRoyale.Core;
using Microsoft.EntityFrameworkCore;

namespace BingoRoyale.Api.Services;

/// <summary>
/// Bootstrap seed — port of scripts/seed.ts, idempotent (safe to re-run).
/// Creates exactly what the SRS demo needs and nothing more.
/// </summary>
public class SeedService(AppDbContext db, LedgerService ledger, EngineService engine, ILogger<SeedService> logger)
{
    private async Task<User> UpsertUserAsync(string phone, string role, string? tenantId, string? displayName)
    {
        var e164 = CryptoBox.NormalizeEthiopianPhone(phone)!;
        var idx = CryptoBox.PhoneBlindIndex(e164);
        var existing = await db.Users.FirstOrDefaultAsync(u => u.PhoneBlindIdx == idx);
        if (existing is not null)
        {
            if (existing.Role != role || (existing.TenantId ?? null) != tenantId)
            {
                existing.Role = role;
                existing.TenantId = tenantId;
                existing.DisplayName = displayName ?? existing.DisplayName;
                await db.SaveChangesAsync();
            }
            return existing;
        }
        var user = new User
        {
            Id = Ids.New(),
            PhoneE164 = CryptoBox.EncryptPhone(e164),
            PhoneBlindIdx = idx,
            Role = role,
            TenantId = tenantId,
            DisplayName = displayName,
        };
        db.Users.Add(user);
        await db.SaveChangesAsync();
        return user;
    }

    private record PublishedEntity(ConfigEntity Entity, ConfigVersion Version);

    private async Task<PublishedEntity> PublishEntityAsync(
        string type, string name, string? tenantId, object payload, string publishedById, bool republishIfChanged = false)
    {
        string payloadJson = JsonSerializer.Serialize(payload);
        string payloadHash = CryptoBox.HashPayload(JsonDocument.Parse(payloadJson).RootElement.Clone());

        var existing = await db.ConfigEntities
            .FirstOrDefaultAsync(e => e.Type == type && e.Name == name && (e.TenantId ?? null) == tenantId);
        if (existing is not null && existing.CurrentVersion > 0)
        {
            var v = await db.ConfigVersions
                .FirstOrDefaultAsync(x => x.EntityId == existing.Id && x.Version == existing.CurrentVersion);
            if (v is not null)
            {
                if (republishIfChanged && !existing.Locked)
                {
                    bool same;
                    try
                    {
                        // structural compare (order-insensitive), like JSON.stringify(JSON.parse) in the TS seed
                        same = JTokenDeepEqual(JsonDocument.Parse(v.PayloadJson).RootElement, JsonDocument.Parse(payloadJson).RootElement);
                    }
                    catch { same = false; }
                    if (!same)
                    {
                        var nv = new ConfigVersion
                        {
                            Id = Ids.New(),
                            EntityId = existing.Id,
                            Version = existing.CurrentVersion + 1,
                            PayloadJson = payloadJson,
                            PayloadHash = payloadHash,
                            PublishedById = publishedById,
                        };
                        db.ConfigVersions.Add(nv);
                        existing.CurrentVersion = nv.Version;
                        existing.UpdatedAt = DateTime.UtcNow;
                        await db.SaveChangesAsync();
                        logger.LogInformation("↻ republished {Name} → v{Version} (tuned settings)", name, nv.Version);
                        return new PublishedEntity(existing, nv);
                    }
                }
                return new PublishedEntity(existing, v);
            }
        }

        var entity = existing ?? new ConfigEntity { Id = Ids.New(), Type = type, Name = name, TenantId = tenantId };
        if (existing is null) db.ConfigEntities.Add(entity);
        var version = new ConfigVersion
        {
            Id = Ids.New(),
            EntityId = entity.Id,
            Version = entity.CurrentVersion + 1,
            PayloadJson = payloadJson,
            PayloadHash = payloadHash,
            PublishedById = publishedById,
        };
        db.ConfigVersions.Add(version);
        entity.CurrentVersion = version.Version;
        entity.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        return new PublishedEntity(entity, version);
    }

    private static bool JTokenDeepEqual(JsonElement a, JsonElement b)
    {
        if (a.ValueKind != b.ValueKind) return false;
        switch (a.ValueKind)
        {
            case JsonValueKind.Object:
                var ap = a.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal).ToList();
                var bp = b.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal).ToList();
                if (ap.Count != bp.Count) return false;
                for (int i = 0; i < ap.Count; i++)
                {
                    if (ap[i].Name != bp[i].Name) return false;
                    if (!JTokenDeepEqual(ap[i].Value, bp[i].Value)) return false;
                }
                return true;
            case JsonValueKind.Array:
                var aa = a.EnumerateArray().ToList();
                var ba = b.EnumerateArray().ToList();
                if (aa.Count != ba.Count) return false;
                for (int i = 0; i < aa.Count; i++)
                    if (!JTokenDeepEqual(aa[i], ba[i])) return false;
                return true;
            case JsonValueKind.Number:
                return a.GetRawText() == b.GetRawText();
            default:
                return a.GetRawText() == b.GetRawText();
        }
    }

    public async Task SeedAsync()
    {
        logger.LogInformation("── bingo seed (.NET): start ──");

        // 1. Bootstrap funding (balanced: equity → demo clearing).
        await ledger.PostTransactionAsync(new PostTxInput(
            "ADJUSTMENT", "seed:bootstrap:funding:v1",
            "Bootstrap funding — EXTERNAL_FUNDING to demo clearing",
            null, null,
            new List<EntryInput>
            {
                new(LedgerCodes.ExternalFunding(), "EQUITY", "External funding (bootstrap)", "CREDIT", 100_000_000),
                new(LedgerCodes.PaymentClearing(), "ASSET", "Demo payment clearing", "DEBIT", 100_000_000),
            }));
        logger.LogInformation("✓ bootstrap funding (1,000,000.00 ETB in demo clearing)");

        // 2. Variants.
        foreach (var v in new[]
                 {
                     new { Id = "BALL_75", Name = "75-Ball American Bingo", GridSpec = "{\"rows\":5,\"cols\":5,\"freeCells\":[[2,2]]}" },
                     new { Id = "BALL_90", Name = "90-Ball UK Bingo", GridSpec = "{\"rows\":3,\"cols\":9,\"freeCells\":[]}" },
                 })
        {
            if (await db.Variants.FindAsync(v.Id) is null)
                db.Variants.Add(new Variant { Id = v.Id, Name = v.Name, GridSpec = v.GridSpec, Active = true });
        }
        await db.SaveChangesAsync();
        logger.LogInformation("✓ variants BALL_75 / BALL_90");

        // 3. Admin officer first (publisher of record for all config).
        var admin = await UpsertUserAsync("+251911000001", "ADMIN", null, "Platform Admin");

        // 4. Pattern catalogue (versioned config entities).
        var corners = await PublishEntityAsync("PATTERN", "Four Corners", null, Patterns.FourCorners75().ToJsonString2(), admin.Id);
        var xPattern = await PublishEntityAsync("PATTERN", "X Pattern", null, Patterns.X75().ToJsonString2(), admin.Id);
        var topLine = await PublishEntityAsync("PATTERN", "Top Line", null, Patterns.Row75(0).ToJsonString2(), admin.Id);
        var blackout = await PublishEntityAsync("PATTERN", "Blackout", null, Patterns.Blackout75().ToJsonString2(), admin.Id);
        var line90 = await PublishEntityAsync("PATTERN", "One Line", null, Patterns.Line90().ToJsonString2(), admin.Id);
        var twoLines90 = await PublishEntityAsync("PATTERN", "Two Lines", null, Patterns.TwoLines90().ToJsonString2(), admin.Id);
        var fullHouse90 = await PublishEntityAsync("PATTERN", "Full House", null, Patterns.FullHouse90().ToJsonString2(), admin.Id);
        logger.LogInformation("✓ pattern catalogue (7 patterns)");

        // 5. Prize rulesets — worst-case stays inside the payout guardrails.
        var rules75 = new RulesetPayload
        {
            Rules =
            {
                new PrizeRule { PatternRef = corners.Entity.Id, Label = "Four Corners", AwardType = "PERCENT_NET_POOL", ValueBps = 1500 },
                new PrizeRule { PatternRef = xPattern.Entity.Id, Label = "X Pattern", AwardType = "PERCENT_NET_POOL", ValueBps = 2000 },
                new PrizeRule { PatternRef = topLine.Entity.Id, Label = "Top Line", AwardType = "PERCENT_NET_POOL", ValueBps = 2500 },
                new PrizeRule { PatternRef = blackout.Entity.Id, Label = "Blackout", AwardType = "PERCENT_NET_POOL", ValueBps = 3000 },
            },
        };
        var rules90 = new RulesetPayload
        {
            Rules =
            {
                new PrizeRule { PatternRef = line90.Entity.Id, Label = "One Line", AwardType = "PERCENT_NET_POOL", ValueBps = 2000 },
                new PrizeRule { PatternRef = twoLines90.Entity.Id, Label = "Two Lines", AwardType = "PERCENT_NET_POOL", ValueBps = 3000 },
                new PrizeRule { PatternRef = fullHouse90.Entity.Id, Label = "Full House", AwardType = "PERCENT_NET_POOL", ValueBps = 3500 },
            },
        };
        if (!PrizeRules.ValidateRulesetShape(rules75).Valid || !PrizeRules.ValidateRulesetShape(rules90).Valid)
            throw new InvalidOperationException("seed ruleset invalid");
        var rs75 = await PublishEntityAsync("PRIZE_RULESET", "Golden Rules 75", null, RulesetToJson(rules75), admin.Id);
        var rs90 = await PublishEntityAsync("PRIZE_RULESET", "Golden Rules 90", null, RulesetToJson(rules90), admin.Id);
        logger.LogInformation("✓ prize rulesets (75-ball, 90-ball)");

        // 6. Room templates — the rolling scheduler's input.
        await PublishEntityAsync("ROOM_TEMPLATE", "Golden Hall 75", null, new
        {
            title = "Golden Hall 75",
            variantId = "BALL_75",
            priceSantim = "500",
            cadenceMinutes = 10,
            salesOpenMinutes = 4,
            salesMinutes = 1,
            ballIntervalMs = 2000,
            autoClaim = false,
            rulesetRef = rs75.Entity.Id,
            patternRefs = new[] { corners.Entity.Id, xPattern.Entity.Id, topLine.Entity.Id, blackout.Entity.Id },
        }, admin.Id, republishIfChanged: true);

        await PublishEntityAsync("ROOM_TEMPLATE", "Rapid Fire 90", null, new
        {
            title = "Rapid Fire 90",
            variantId = "BALL_90",
            priceSantim = "300",
            cadenceMinutes = 8,
            salesOpenMinutes = 3,
            salesMinutes = 1,
            ballIntervalMs = 1800,
            autoClaim = false,
            rulesetRef = rs90.Entity.Id,
            patternRefs = new[] { line90.Entity.Id, twoLines90.Entity.Id, fullHouse90.Entity.Id },
        }, admin.Id, republishIfChanged: true);
        logger.LogInformation("✓ room templates (Golden Hall 75 @2s, Rapid Fire 90 @1.8s — manual BINGO! claims)");

        // 7. Tenant (KYB-approved) + owner + commission plan (UC-11/12).
        var tenant = await db.Tenants.FirstOrDefaultAsync(t => t.Code == "SHEGER");
        if (tenant is null)
        {
            tenant = new Tenant
            {
                Id = Ids.New(),
                Code = "SHEGER",
                LegalName = "Sheger Entertainment PLC",
                Tin = "00-1234567890",
                Jurisdiction = "Addis Ababa, Ethiopia",
                ContactEmail = "ops@sheger-demo.et",
                ContactPhone = "+251911000002",
                Status = "REGISTERED",
                BeneficialOwners = "[{\"name\":\"Abebe Kebede\",\"idType\":\"PASSPORT\",\"idRef\":\"ET-DEMO-0001\",\"sharePct\":100}]",
            };
            db.Tenants.Add(tenant);
            await db.SaveChangesAsync();
        }
        var owner = await UpsertUserAsync("+251911000002", "TENANT_OWNER", tenant.Id, "Sheger Ops");
        if (tenant.Status != "APPROVED")
        {
            tenant.Status = "APPROVED";
            tenant.ApprovedAt = DateTime.UtcNow;
            tenant.StatusReason = null;
            tenant.DocumentSetHash = CryptoBox.Sha256Hex("seed:dossier:v1");
            db.KybReviews.Add(new KybReview
            {
                Id = Ids.New(),
                TenantId = tenant.Id,
                OfficerId = admin.Id,
                Decision = "APPROVED",
                Note = "Seed approval — demo dossier",
                DocumentSetHash = CryptoBox.Sha256Hex("seed:dossier:v1"),
            });
            await db.SaveChangesAsync();
        }
        if (!await db.CommissionPlans.AnyAsync(p => p.TenantId == tenant.Id))
        {
            db.CommissionPlans.Add(new CommissionPlan
            {
                Id = Ids.New(),
                TenantId = tenant.Id,
                Basis = "TURNOVER",
                RateBps = 2500,
                EffectiveFrom = DateTime.UtcNow.AddHours(-1),
                PayloadHash = CryptoBox.Sha256Hex("seed:plan:v1"),
                ApprovedById = admin.Id,
                DraftId = "seed:plan:v1",
            });
            await db.SaveChangesAsync();
        }
        logger.LogInformation("✓ tenant {Code} APPROVED, owner {Owner}, commission 25.00% TURNOVER", tenant.Code, owner.Id[^4..]);

        // Tenant-branded template — proves tenant-owned content flows through the same scheduler.
        await PublishEntityAsync("ROOM_TEMPLATE", "Sheger Lounge 90", tenant.Id, new
        {
            title = "Sheger Lounge 90",
            variantId = "BALL_90",
            priceSantim = "400",
            cadenceMinutes = 12,
            salesOpenMinutes = 4,
            salesMinutes = 1,
            ballIntervalMs = 2200,
            autoClaim = false,
            rulesetRef = rs90.Entity.Id,
            patternRefs = new[] { line90.Entity.Id, twoLines90.Entity.Id, fullHouse90.Entity.Id },
        }, admin.Id, republishIfChanged: true);
        logger.LogInformation("✓ tenant room template (Sheger Lounge 90)");

        // 8. Demo player with a funded wallet (UC-02 demo deposit, ledger-real).
        var demoPlayer = await UpsertUserAsync("+251911000003", "PLAYER", null, "Lucky Star");
        var walletAcc = await db.LedgerAccounts.AsNoTracking()
            .FirstOrDefaultAsync(a => a.Code == LedgerCodes.PlayerWallet(demoPlayer.Id));
        long walletBalance = 0;
        if (walletAcc is not null)
            walletBalance = await db.WalletBalances.AsNoTracking()
                .Where(w => w.AccountId == walletAcc.Id)
                .Select(w => w.BalanceSantim)
                .FirstOrDefaultAsync();
        if (walletBalance == 0)
        {
            await ledger.PostTransactionAsync(new PostTxInput(
                "DEPOSIT", "seed:deposit:demo:v1",
                "Demo player wallet funding (simulated checkout)",
                null, null,
                new List<EntryInput>
                {
                    new(LedgerCodes.PaymentClearing(), "ASSET", "Demo payment clearing", "DEBIT", 50_000),
                    new(LedgerCodes.PlayerWallet(demoPlayer.Id), "LIABILITY", "Player wallet", "CREDIT", 50_000, null, demoPlayer.Id),
                }));
        }
        logger.LogInformation("✓ demo player funded (500.00 ETB) — {PlayerId}", demoPlayer.Id);

        // 9. Rolling rooms via the production scheduler input.
        var created = await engine.EnsureRollingRoomsAsync(3);
        logger.LogInformation("✓ rolling rooms ensured ({Count} created now, scheduler keeps them flowing)", created.Count);

        logger.LogInformation("── bingo seed (.NET): done ──");
    }

    private static object RulesetToJson(RulesetPayload ruleset) => new
    {
        rules = ruleset.Rules.Select(r => new
        {
            patternRef = r.PatternRef,
            label = r.Label,
            awardType = r.AwardType,
            valueBps = r.ValueBps,
            valueSantim = r.ValueSantim?.ToString(),
        }),
    };
}

/// <summary>Payload JSON exactly as the TS seed publishes it (kind-kind spelling).</summary>
public static class PatternPayloadJsonExt
{
    public static object ToJsonString2(this PatternPayload p) => p.Kind switch
    {
        PatternKind.Cells => new { kind = "CELLS", cells = p.Cells!.Select(c => new[] { c[0]!.Value, c[1]!.Value }) },
        PatternKind.RowsMin => new { kind = "ROWS_MIN", rows = p.Rows!.Value },
        _ => new { kind = "FULL_HOUSE" },
    };
}
