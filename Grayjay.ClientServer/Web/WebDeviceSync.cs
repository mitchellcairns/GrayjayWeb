using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Grayjay.ClientServer.Constants;
using Grayjay.Desktop.POC;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] Things that follow you between your devices:
    /// - the play queue (one list shared by every paired device, saved in the data directory);
    /// - "now playing" per device, so another device can offer "Continue here" at the right position;
    /// - "pause", sent to the device you continued from.
    /// Every open app gets the change events over the WebSocket; commands carry a target id and other devices ignore them.
    /// </summary>
    public static class WebDeviceSync
    {
        private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

        // ---------- Queue ----------
        private static readonly object QueueLock = new();
        private static string QueueFile => Path.Combine(Directories.Base, "web_queue.json");
        private const int MaxQueue = 500;

        public class QueueState
        {
            public JsonArray Items { get; set; } = new();
            public bool Saved { get; set; }
            public DateTime? UpdatedAt { get; set; }
            public string? UpdatedBy { get; set; }
        }

        private static QueueState ReadQueue()
        {
            try
            {
                if (File.Exists(QueueFile))
                    return JsonSerializer.Deserialize<QueueState>(File.ReadAllText(QueueFile), Json) ?? new QueueState();
            }
            catch (Exception e) { Logger.w(nameof(WebDeviceSync), "Couldn't read the queue: " + e.Message); }
            return new QueueState();
        }

        // ---------- Now playing ----------
        public class NowPlaying
        {
            public string DeviceId { get; set; } = "";
            public string? DeviceName { get; set; }
            public string? Url { get; set; }
            public string? Name { get; set; }
            public string? Thumbnail { get; set; }
            public string? Author { get; set; }
            public double Position { get; set; }
            public double Duration { get; set; }
            public bool Playing { get; set; }
            public bool AudioOnly { get; set; }
            public DateTime UpdatedAt { get; set; }
        }

        public class NowPlayingReport : NowPlaying
        {
            /// <summary>Used only when auth is disabled (no paired device to identify the caller).</summary>
            public string? ClientId { get; set; }
            /// <summary>Periodic position update: stored, but not broadcast.</summary>
            public bool Heartbeat { get; set; }
        }

        public class Command
        {
            public string TargetId { get; set; } = "";
            /// <summary>Only "pause" for now.</summary>
            public string Kind { get; set; } = "";
            public string? FromId { get; set; }
            public string? FromName { get; set; }
            public string? ClientId { get; set; }
        }

        private static readonly ConcurrentDictionary<string, NowPlaying> Playing = new();
        private static readonly TimeSpan Keep = TimeSpan.FromHours(12);

        private static (string id, string? name) Caller(HttpContext ctx, string? clientId)
        {
            var device = GrayjayServer.Instance.WebAuth?.GetDevice(ctx);
            if (device != null) return (device.Id, device.Name);
            return (string.IsNullOrWhiteSpace(clientId) ? "local" : clientId[..Math.Min(64, clientId.Length)], null);
        }

        private static void Broadcast(object? message, string type) =>
            Task.Run(async () => { try { await GrayjayServer.Instance.WebSocket.Broadcast(message, type); } catch { } });

        public static void Map(IEndpointRouteBuilder app)
        {
            app.MapGet("/web/queue", () =>
            {
                lock (QueueLock) return Results.Json(ReadQueue(), Json);
            });

            app.MapPost("/web/queue", (HttpContext ctx, JsonArray items) =>
            {
                if (items.Count > MaxQueue) return Results.BadRequest(new { error = $"The queue holds up to {MaxQueue} videos" });
                var (id, name) = Caller(ctx, ctx.Request.Query["clientId"]);
                lock (QueueLock)
                {
                    var state = new QueueState { Items = items, Saved = true, UpdatedAt = DateTime.UtcNow, UpdatedBy = id };
                    var tmp = QueueFile + ".tmp";
                    File.WriteAllText(tmp, JsonSerializer.Serialize(state, Json));
                    File.Move(tmp, QueueFile, true);
                }
                Broadcast(new { by = id }, "QueueChanged");
                return Results.Json(new { ok = true });
            });

            app.MapGet("/web/nowplaying", () =>
            {
                var cutoff = DateTime.UtcNow - Keep;
                foreach (var kv in Playing.Where(kv => kv.Value.UpdatedAt < cutoff).ToList()) Playing.TryRemove(kv.Key, out _);
                return Results.Json(new { now = DateTime.UtcNow, devices = Playing.Values.OrderByDescending(x => x.UpdatedAt).ToList() }, Json);
            });

            app.MapPost("/web/nowplaying", (HttpContext ctx, NowPlayingReport report) =>
            {
                var (id, name) = Caller(ctx, report.ClientId);
                if (string.IsNullOrEmpty(report.Url))
                {
                    if (Playing.TryRemove(id, out _)) Broadcast(new { deviceId = id }, "NowPlayingChanged");
                    return Results.Json(new { ok = true });
                }
                var state = new NowPlaying
                {
                    DeviceId = id, DeviceName = name ?? report.DeviceName, Url = report.Url, Name = report.Name, Thumbnail = report.Thumbnail,
                    Author = report.Author, Position = Math.Max(0, report.Position), Duration = Math.Max(0, report.Duration), Playing = report.Playing,
                    AudioOnly = report.AudioOnly, UpdatedAt = DateTime.UtcNow
                };
                Playing.TryGetValue(id, out var previous);
                Playing[id] = state;
                bool changed = previous == null || previous.Url != state.Url || previous.Playing != state.Playing || !report.Heartbeat;
                if (changed) Broadcast(new { deviceId = id }, "NowPlayingChanged");
                return Results.Json(new { ok = true });
            });

            app.MapPost("/web/device/Command", (HttpContext ctx, Command cmd) =>
            {
                if (string.IsNullOrEmpty(cmd.TargetId) || cmd.Kind != "pause")
                    return Results.BadRequest(new { error = "Unknown command" });
                var (id, name) = Caller(ctx, cmd.ClientId);
                cmd.FromId = id;
                cmd.FromName = name ?? cmd.FromName;
                cmd.ClientId = null;
                Broadcast(cmd, "DeviceCommand");
                return Results.Json(new { ok = true });
            });
        }
    }
}
