using BingoRoyale.Api.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using System.Net.Sockets;

namespace BingoRoyale.Api.Services;

/// <summary>
/// Engine boot — the game-gateway heartbeat. A 1-second process-level loop
/// drives every live room exactly one grain turn per tick (ADR-01), plus the
/// rolling demo-room scheduler every 30 s so the lobby never runs dry.
/// Port of engine/boot.ts + src/instrumentation.ts.
/// </summary>
public class EngineHost(IServiceScopeFactory scopeFactory, ILogger<EngineHost> logger) : BackgroundService
{
    public const int TickMs = 1_000;
    public const int SchedulerEveryMs = 30_000;

    // Health/introspection for the ops console.
    private long _ticks;
    private long _lastTickAt;
    private double _lastTickMs;
    private string? _lastError;
    private long _lastSchedulerRun;

    public object Status() => new
    {
        booted = true,
        ticking = false,
        cachedRooms = EngineService.RegistrySize,
        ticks = Interlocked.Read(ref _ticks),
        lastTickAt = _lastTickAt == 0 ? null : DateTimeOffset.FromUnixTimeMilliseconds(_lastTickAt).ToString("o"),
        lastTickMs = _lastTickMs,
        lastError = _lastError,
    };

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Schema + demo-world seed happen in Program.cs BEFORE the listener
        // opens (deterministic readiness) — nothing to do here.
        logger.LogInformation("[engine] game engine booted (.NET) — 1s grain turns, rolling scheduler 30s");
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(TickMs));
        var lastTurnFinished = true;
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                if (!lastTurnFinished) continue; // non-reentrant grain turns
                lastTurnFinished = false;
                var started = Environment.TickCount64;
                try
                {
                    await RunTurnAsync(stoppingToken);
                    Interlocked.Increment(ref _ticks);
                    _lastTickAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    _lastTickMs = Environment.TickCount64 - started;
                    _lastError = null;
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception err)
                {
                    _lastError = err.Message;
                    logger.LogError(err, "[engine] turn failed");
                }
                finally
                {
                    lastTurnFinished = true;
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // graceful shutdown — the drum stops, nothing else to do
        }
    }

    /// <summary>One process tick: every live room gets at most one sequential turn.</summary>
    private async Task RunTurnAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var engine = scope.ServiceProvider.GetRequiredService<EngineService>();
        var statuses = EngineService.LiveStatuses.ToArray();

        var rooms = await db.Rooms.AsNoTracking()
            .Where(r => statuses.Contains(r.Status))
            .OrderBy(r => r.ScheduledAt)
            .ToListAsync(ct);

        foreach (var room in rooms)
        {
            await DbGate.Write.WaitAsync(ct);
            try
            {
                switch (room.Status)
                {
                    case "SCHEDULED":
                        if (DateTime.UtcNow >= room.SalesOpenAt)
                        {
                            var live = await db.Rooms.FirstAsync(r => r.Id == room.Id, ct);
                            await engine.TransitionSalesOpenAsync(live);
                        }
                        break;
                    case "SALES_OPEN":
                        if (DateTime.UtcNow >= room.SalesCloseAt)
                        {
                            var live = await db.Rooms.FirstAsync(r => r.Id == room.Id, ct);
                            await engine.TransitionLockAsync(live);
                        }
                        break;
                    case "LOCKED":
                        if (DateTime.UtcNow >= room.ScheduledAt)
                        {
                            var live = await db.Rooms.FirstAsync(r => r.Id == room.Id, ct);
                            await engine.TransitionDrawingAsync(live);
                        }
                        break;
                    case "DRAWING":
                    {
                        var live = await db.Rooms.FirstAsync(r => r.Id == room.Id, ct);
                        await engine.TickDrawingAsync(live);
                        break;
                    }
                    case "RESOLVING":
                        await engine.FinishRoomAsync(room.Id); // crash-safe: every step idempotent
                        break;
                }
            }
            catch (Exception err)
            {
                logger.LogError(err, "[engine] room {RoomId} ({Title}) turn failed", room.Id, room.Title);
            }
            finally
            {
                DbGate.Write.Release();
            }
        }

        await MaybeRunSchedulerAsync(db, engine, ct);
    }

    private async Task MaybeRunSchedulerAsync(AppDbContext db, EngineService engine, CancellationToken ct)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now - Interlocked.Read(ref _lastSchedulerRun) < SchedulerEveryMs) return;
        Interlocked.Exchange(ref _lastSchedulerRun, now);
        try
        {
            var created = await engine.EnsureRollingRoomsAsync(3);
            if (created.Count > 0)
                logger.LogInformation("[engine] scheduler created {Count} room(s)", created.Count);
        }
        catch (Exception err)
        {
            logger.LogError(err, "[engine] scheduler failed");
        }
    }
}
