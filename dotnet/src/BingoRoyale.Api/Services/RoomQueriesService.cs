using System.Text.Json;
using BingoRoyale.Api.Data;
using BingoRoyale.Api.Domain;
using BingoRoyale.Core;
using Microsoft.EntityFrameworkCore;

namespace BingoRoyale.Api.Services;

/// <summary>
/// Room queries — lists, detail with rules + live prize preview (FR-PLY-02:
/// the prize table shown equals the live preview recomputed from confirmed
/// sales). Port of rooms/queries.ts listRooms/roomDetail.
/// </summary>
public class RoomQueriesService(AppDbContext db)
{
    public async Task<IReadOnlyList<object>> ListRoomsAsync()
    {
        var rooms = await db.Rooms.AsNoTracking().OrderBy(r => r.ScheduledAt).ToListAsync();
        var tickets = await db.Tickets.AsNoTracking().Select(t => new { t.RoomId, t.PlayerId }).ToListAsync();
        var playerCounts = tickets.GroupBy(t => new { t.RoomId, t.PlayerId })
            .GroupBy(g => g.Key.RoomId)
            .ToDictionary(g => g.Key, g => g.Count());
        var ticketCounts = tickets.GroupBy(t => t.RoomId).ToDictionary(g => g.Key, g => g.Count());

        return rooms.Select(r => new
        {
            id = r.Id,
            title = r.Title,
            variantId = r.VariantId,
            status = r.Status,
            tenantId = r.TenantId,
            priceSantim = r.PriceSantim.ToString(),
            maxCards = r.MaxCardsPerPlayer,
            scheduledAt = r.ScheduledAt.ToString("o"),
            salesOpenAt = r.SalesOpenAt.ToString("o"),
            players = playerCounts.GetValueOrDefault(r.Id),
            tickets = ticketCounts.GetValueOrDefault(r.Id),
        }).ToList();
    }

    public async Task<object> RoomDetailAsync(string roomId, string? viewerPlayerId)
    {
        var room = await db.Rooms.AsNoTracking().FirstOrDefaultAsync(r => r.Id == roomId)
            ?? throw new ApiError("ROOM_NOT_FOUND");

        var playerRows = await db.Tickets.AsNoTracking()
            .Where(t => t.RoomId == room.Id)
            .Select(t => t.PlayerId)
            .Distinct()
            .ToListAsync();

        var rulesetVersion = await db.ConfigVersions.AsNoTracking()
            .FirstOrDefaultAsync(v => v.Id == room.RulesetVersionId);
        var ruleset = RulesetPayload.FromJson(JsonDocument.Parse(rulesetVersion?.PayloadJson ?? "{}").RootElement);
        long netPool = room.NetPoolSantim; // gross − prizes paid so far

        var patternVersionIds = JsonSerializer.Deserialize<List<string>>(room.PatternVersionIds) ?? new();
        var patternVersions = patternVersionIds.Count > 0
            ? await db.ConfigVersions.AsNoTracking().Where(v => patternVersionIds.Contains(v.Id)).ToListAsync()
            : new List<ConfigVersion>();
        var entityIds = patternVersions.Select(v => v.EntityId).Distinct().ToList();
        var entities = entityIds.Count > 0
            ? await db.ConfigEntities.AsNoTracking().Where(e => entityIds.Contains(e.Id)).ToListAsync()
            : new List<ConfigEntity>();
        var labelByEntity = entities.ToDictionary(e => e.Id, e => e.Name);

        var prizeTable = ruleset.Rules.Select(rule =>
        {
            var pv = patternVersions.FirstOrDefault(v => v.EntityId == rule.PatternRef);
            return new
            {
                patternId = rule.PatternRef,
                patternLabel = labelByEntity.GetValueOrDefault(rule.PatternRef) ?? rule.Label ?? rule.PatternRef,
                awardType = rule.AwardType,
                tierSantim = PrizeRules.TierAmountFor(rule, room.GrossSantim, netPool).ToString(),
                versionId = pv?.Id,
            };
        }).ToList();

        // Pattern shapes for the player UI — same pinned versions the round
        // resolves against (FR-ROOM-02). A failed parse drops the diagram.
        var patterns = new List<object>();
        foreach (var pv in patternVersions)
        {
            try
            {
                var payload = PatternPayload.FromJson(JsonDocument.Parse(pv.PayloadJson).RootElement);
                patterns.Add(new
                {
                    patternId = pv.EntityId,
                    label = labelByEntity.GetValueOrDefault(pv.EntityId) ?? pv.EntityId,
                    payload = System.Text.Json.Nodes.JsonNode.Parse(payload.ToJsonString())!,
                });
            }
            catch { /* drop the diagram, never the round */ }
        }

        var myTickets = new List<object>();
        if (viewerPlayerId is not null)
        {
            var mine = await db.Tickets.AsNoTracking()
                .Where(t => t.RoomId == room.Id && t.PlayerId == viewerPlayerId)
                .OrderBy(t => t.CreatedAt)
                .ToListAsync();
            foreach (var t in mine)
                myTickets.Add(new
                {
                    ticketId = t.Id,
                    numbers = System.Text.Json.Nodes.JsonNode.Parse(t.NumbersJson)!,
                    fingerprint = t.Fingerprint,
                });
        }

        return new
        {
            id = room.Id,
            title = room.Title,
            variantId = room.VariantId,
            status = room.Status,
            tenantId = room.TenantId,
            priceSantim = room.PriceSantim.ToString(),
            maxCards = room.MaxCardsPerPlayer,
            ballIntervalMs = room.BallIntervalMs,
            autoClaim = room.AutoClaim,
            players = playerRows.Count,
            scheduledAt = room.ScheduledAt.ToString("o"),
            salesOpenAt = room.SalesOpenAt.ToString("o"),
            salesCloseAt = room.SalesCloseAt.ToString("o"),
            grossSantim = room.GrossSantim.ToString(),
            netPoolSantim = netPool.ToString(),
            prizeTable,
            patterns,
            myTickets,
        };
    }
}
