using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace BingoRoyale.Api.Hubs;

/// <summary>
/// Room realtime gateway (Architecture v5.0: "Kestrel, SignalR" — SignalR
/// gateways front the room grains). One group per room: <c>room:{roomId}</c>.
///
/// Auth: the same httpOnly <c>bg_at</c> JWT cookie the REST surface uses —
/// the JwtBearer OnMessageReceived hook covers hub requests too, because the
/// browser reaches this hub same-origin through the Next.js /hubs proxy and
/// every SignalR transport (negotiate POST, SSE GET, long-poll GET) carries
/// first-party cookies.
/// </summary>
[Authorize]
public class RoomHub : Hub
{
    /// <summary>Client entry: join the room group. Gaps are closed by the
    /// client's sequence-addressed REST catch-up (?afterSeq=N) — the hub is
    /// push-only, it never replays history.</summary>
    public Task Subscribe(string roomId, int lastSeq = 0)
    {
        if (string.IsNullOrWhiteSpace(roomId)) return Task.CompletedTask;
        return Groups.AddToGroupAsync(Context.ConnectionId, GroupName(roomId));
    }

    public Task Unsubscribe(string roomId)
    {
        if (string.IsNullOrWhiteSpace(roomId)) return Task.CompletedTask;
        return Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(roomId));
    }

    public static string GroupName(string roomId) => $"room:{roomId}";
}
