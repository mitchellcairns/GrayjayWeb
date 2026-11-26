using System.Text.Json;
using Grayjay.ClientServer.Constants;
using Grayjay.Desktop.POC;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] "Hide this creator": a server-side list (shared by every paired device) of creators whose content the
    /// PWA filters out of Discover, Subscriptions, search and Up next. Stored as JSON in the data directory.
    /// </summary>
    public static class WebHiddenCreators
    {
        public class HiddenCreator
        {
            public string Url { get; set; } = "";
            public string? Name { get; set; }
            public string? Thumbnail { get; set; }
            public string? Platform { get; set; }
            /// <summary>Platform channel id, so a creator matches whichever of their URLs a feed uses.</summary>
            public string? Id { get; set; }
            public DateTime HiddenAt { get; set; }
        }

        private static readonly object Lock = new();
        private static List<HiddenCreator>? _cache;
        private static string FilePath => Path.Combine(Directories.Base, "web_hidden_creators.json");
        private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

        private static List<HiddenCreator> Load()
        {
            if (_cache != null) return _cache;
            try
            {
                _cache = File.Exists(FilePath) ? JsonSerializer.Deserialize<List<HiddenCreator>>(File.ReadAllText(FilePath), Json) ?? new() : new();
            }
            catch (Exception e)
            {
                Logger.w(nameof(WebHiddenCreators), "Couldn't read hidden creators: " + e.Message);
                _cache = new();
            }
            return _cache;
        }

        private static void Save(List<HiddenCreator> list)
        {
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(list, Json));
            File.Move(tmp, FilePath, true);
            _cache = list;
            Task.Run(async () => { try { await GrayjayServer.Instance.WebSocket.Broadcast(null, "HiddenCreatorsChanged"); } catch { } });
        }

        public static void Map(IEndpointRouteBuilder app)
        {
            app.MapGet("/web/hidden/List", () =>
            {
                lock (Lock) return Results.Json(Load().OrderByDescending(x => x.HiddenAt).ToList(), Json);
            });

            app.MapPost("/web/hidden/Add", (HiddenCreator creator) =>
            {
                if (string.IsNullOrWhiteSpace(creator.Url) || creator.Url.Length > 2048)
                    return Results.BadRequest(new { error = "A creator URL is required" });
                lock (Lock)
                {
                    var list = Load().Where(x => !Same(x, creator)).ToList();
                    creator.HiddenAt = DateTime.UtcNow;
                    list.Add(creator);
                    Save(list);
                }
                return Results.Json(new { ok = true });
            });

            app.MapPost("/web/hidden/Remove", (HiddenCreator creator) =>
            {
                lock (Lock)
                {
                    var list = Load();
                    var next = list.Where(x => !Same(x, creator)).ToList();
                    if (next.Count != list.Count) Save(next);
                }
                return Results.Json(new { ok = true });
            });
        }

        private static bool Same(HiddenCreator a, HiddenCreator b) =>
            string.Equals(a.Url, b.Url, StringComparison.OrdinalIgnoreCase) ||
            (!string.IsNullOrEmpty(a.Id) && a.Id == b.Id && a.Platform == b.Platform);
    }
}
