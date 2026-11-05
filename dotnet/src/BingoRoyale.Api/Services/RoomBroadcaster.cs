using BingoRoyale.Api.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BingoRoyale.Api.Services;

/// <summary>
/// Push side of the room gateway. Every outbox event that lands in the REST
/// catch-up (<c>?afterSeq=N</c>) is mirrored to the SignalR room group so live
/// clients get the ball the moment the drum spins (Architecture v5.0 room
/// event distribution; ≤64-byte budget incl. SignalR overhead).
///
/// Delivery contract: at-least-once push, deduped client-side by event id;
/// the sequence-addressed REST catch-up stays authoritative — a dropped push
/// costs one poll interval, never correctness.
/// </summary>
public interface IRoomBroadcaster
{
    Task PublishAsync(string roomId, string type, object payload);
}

public class RoomBroadcaster(IHubContext<RoomHub> hub, ILogger<RoomBroadcaster> logger) : IRoomBroadcaster
{
    public async Task PublishAsync(string roomId, string type, object payload)
    {
        try
        {
            var evt = new { id = Guid.NewGuid().ToString("N"), type, payload };
            await hub.Clients.Group(RoomHub.GroupName(roomId)).SendAsync("room-event", evt);
        }
        catch (Exception err)
        {
            // Never let a push failure break the 1s grain turn — the REST
            // catch-up is the safety net by design (ADR-19).
            logger.LogWarning(err, "[hub] publish {Type} for {RoomId} failed — REST catch-up remains authoritative", type, roomId);
        }
    }
}
