using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using Grayjay.ClientServer.Constants;
using Grayjay.ClientServer.Settings;
using Grayjay.ClientServer.States;
using Grayjay.Desktop.POC;
using Grayjay.Desktop.POC.Port.States;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] First-run setup and data import for web mode. The desktop app imports via native file pickers;
    /// here the browser uploads the file instead, and the existing import dialogs ("import", "importSubs") and Grayjay
    /// Sync pairing ("syncConfirm") run unchanged, rendered by the PWA from their WebSocket custom-dialog events.
    /// </summary>
    public static class WebSetupEndpoints
    {
        private const long MaxUpload = 512L * 1024 * 1024;
        private static string SetupFile => Path.Combine(Directories.Base, "web_setup.json");

        public static void Map(IEndpointRouteBuilder app)
        {
            app.MapGet("/web/setup/Status", () =>
            {
                bool done = File.Exists(SetupFile);
                return Results.Json(new
                {
                    done,
                    subscriptions = StateSubscriptions.GetSubscriptions().Count,
                    enabledSources = StatePlatform.GetEnabledClients().Count,
                    installedSources = StatePlugins.GetPlugins().Count,
                    syncEnabled = GrayjaySettings.Instance.Synchronization.Enabled,
                    syncDevices = SafeSyncDeviceCount()
                });
            });

            app.MapPost("/web/setup/Complete", () =>
            {
                File.WriteAllText(SetupFile, JsonSerializer.Serialize(new { completed = DateTime.UtcNow }));
                return Results.Json(new { ok = true });
            });

            // Grayjay backup (.zip from Grayjay Android or Desktop "Export"): starts the "import" custom dialog.
            app.MapPost("/web/import/Backup", async (HttpContext ctx) =>
            {
                var bytes = await ReadUploadAsync(ctx);
                if (bytes == null)
                    return Results.Json(new { error = "No file was uploaded." }, statusCode: 400);
                StateBackup.ExportStructure export;
                try
                {
                    export = StateBackup.ExportStructure.FromZipBytes(bytes);
                }
                catch (InvalidDataException)
                {
                    return Results.Json(new { error = "That file isn't a Grayjay backup (.zip)." }, statusCode: 400);
                }
                if ((export.Stores?.Count ?? 0) == 0 && (export.Plugins?.Count ?? 0) == 0 && string.IsNullOrEmpty(export.Settings))
                    return Results.Json(new { error = "That zip doesn't contain any Grayjay data." }, statusCode: 400);
                Logger.i(nameof(WebSetupEndpoints), $"Importing backup: {export.Stores?.Count ?? 0} stores, {export.Plugins?.Count ?? 0} plugins.");
                StateBackup.Import(export);
                return Results.Json(new
                {
                    ok = true,
                    stores = export.Stores?.ToDictionary(x => x.Key, x => x.Value.Count),
                    plugins = export.Plugins?.Count ?? 0
                });
            });

            // NewPipe subscriptions export (.json): starts the "importSubs" custom dialog.
            app.MapPost("/web/import/NewPipe", async (HttpContext ctx) =>
            {
                var bytes = await ReadUploadAsync(ctx);
                if (bytes == null)
                    return Results.Json(new { error = "No file was uploaded." }, statusCode: 400);
                try
                {
                    var obj = JsonNode.Parse(bytes)?.AsObject();
                    if (obj == null || !obj.ContainsKey("subscriptions") || obj["subscriptions"]!.GetValueKind() != JsonValueKind.Array)
                        return Results.Json(new { error = "That file isn't a NewPipe subscriptions export." }, statusCode: 400);
                    StateBackup.ImportNewPipeSubs(obj);
                    return Results.Json(new { ok = true, count = obj["subscriptions"]!.AsArray().Count });
                }
                catch (JsonException)
                {
                    return Results.Json(new { error = "That file isn't valid JSON." }, statusCode: 400);
                }
            });

            // Backup download in the same zip format Grayjay imports (Android "Import", or this server's import).
            app.MapGet("/web/export/Backup", () =>
            {
                var export = StateBackup.Export();
                var bytes = ToZipBytes(export);
                var name = $"grayjay-backup-{DateTime.Now:yyyy-MM-dd}.zip";
                return Results.File(bytes, "application/zip", name);
            });

            // Grayjay Sync: link this server with Grayjay on another device (phone or desktop) by QR code.
            app.MapPost("/web/sync/Enable", async () =>
            {
                var settings = GrayjaySettings.Instance;
                if (!settings.Synchronization.Enabled)
                {
                    settings.Synchronization.Enabled = true;
                    settings.Save();
                }
                if (StateSync.Instance.SyncService == null)
                {
                    try
                    {
                        await StateSync.Instance.StartAsync();
                    }
                    catch (Exception e)
                    {
                        Logger.e(nameof(WebSetupEndpoints), "Failed to start sync.", e);
                        return Results.Json(new { error = "Couldn't start Grayjay Sync: " + e.Message }, statusCode: 500);
                    }
                }
                return Results.Json(new { ok = true, pairingUrl = StateSync.Instance.GetPairingUrl() });
            });
        }

        /// <summary>Inverse of <see cref="StateBackup.ExportStructure.FromZip"/>.</summary>
        public static byte[] ToZipBytes(StateBackup.ExportStructure export)
        {
            using var ms = new MemoryStream();
            using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, true))
            {
                void write(string name, string content)
                {
                    var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
                    using var w = new StreamWriter(entry.Open());
                    w.Write(content);
                }
                write("exportInfo", JsonSerializer.Serialize(export.ExportInfo ?? new Dictionary<string, string>()));
                if (!string.IsNullOrEmpty(export.Settings))
                    write("settings", export.Settings);
                write("plugins", JsonSerializer.Serialize(export.Plugins ?? new Dictionary<string, string>()));
                write("plugin_settings", JsonSerializer.Serialize(export.PluginSettings ?? new Dictionary<string, Dictionary<string, string>>()));
                foreach (var store in export.Stores ?? new Dictionary<string, List<string>>())
                    write("stores/" + store.Key, JsonSerializer.Serialize(store.Value));
                // The cache only speeds up importing; skip it rather than fail the export.
                try { if (export.Cache?.Videos != null) write("cache_videos", JsonSerializer.Serialize(export.Cache.Videos)); }
                catch (Exception e) { Logger.w(nameof(WebSetupEndpoints), "Skipping video cache in export: " + e.Message); }
                try { if (export.Cache?.Channels != null) write("cache_channels", JsonSerializer.Serialize(export.Cache.Channels)); }
                catch (Exception e) { Logger.w(nameof(WebSetupEndpoints), "Skipping channel cache in export: " + e.Message); }
            }
            return ms.ToArray();
        }

        private static int SafeSyncDeviceCount()
        {
            try { return StateSync.Instance.GetAllDevices().Count(); } catch { return 0; }
        }

        /// <summary>Accepts either a raw request body or a multipart form with a single file.</summary>
        private static async Task<byte[]?> ReadUploadAsync(HttpContext ctx)
        {
            if (ctx.Request.ContentLength > MaxUpload)
                return null;
            using var ms = new MemoryStream();
            if (ctx.Request.HasFormContentType)
            {
                var form = await ctx.Request.ReadFormAsync();
                var file = form.Files.FirstOrDefault();
                if (file == null)
                    return null;
                await file.CopyToAsync(ms);
            }
            else
            {
                await ctx.Request.Body.CopyToAsync(ms);
            }
            return ms.Length > 0 ? ms.ToArray() : null;
        }
    }
}
