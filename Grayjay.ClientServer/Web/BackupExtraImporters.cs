using System.Text.Json;
using System.Text.RegularExpressions;
using Grayjay.ClientServer.Models.History;
using Grayjay.ClientServer.Serializers;
using Grayjay.ClientServer.States;
using Grayjay.Desktop.POC;
using Grayjay.Desktop.POC.Port.States;
using Grayjay.Engine.Models.Feed;
using Grayjay.Engine.Models.General;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] Imports the backup stores upstream Grayjay Desktop doesn't handle: watch later and watch history
    /// (both present in Grayjay Android exports). Formats, as written by Grayjay Android:
    ///   - watch_later: one entry per video — the video URL, or a serialized video JSON object.
    ///   - history: "url|||unixSeconds|||positionSeconds|||name" (name may itself contain "|||"), or a HistoryVideo JSON object.
    /// Videos are taken from the backup's video cache when present. Watch later entries missing from the cache are fetched
    /// from their source; history entries are not (there can be thousands), so they get the name from the backup and,
    /// for YouTube, a thumbnail derived from the video id.
    /// </summary>
    public static class BackupExtraImporters
    {
        private static string Normalize(string key) => new string(key.ToLowerInvariant().Where(char.IsLetter).ToArray());

        public static bool Handles(string storeKey) => Normalize(storeKey) is "watchlater" or "history" or "watchhistory";

        public static string DisplayName(string storeKey) => Normalize(storeKey) switch
        {
            "watchlater" => "Watch later",
            "history" or "watchhistory" => "Watch history",
            _ => storeKey,
        };

        public class Result
        {
            public int Imported { get; set; }
            public List<string> Warnings { get; } = new List<string>();
            public List<string> Errors { get; } = new List<string>();
        }

        public static async Task<Result> ImportAsync(string storeKey, List<string> items, StateBackup.ImportCache? cache, Func<int, int, Task> progress)
        {
            return Normalize(storeKey) == "watchlater"
                ? await ImportWatchLaterAsync(items, cache, progress)
                : await ImportHistoryAsync(items, cache, progress);
        }

        private static async Task<Result> ImportWatchLaterAsync(List<string> items, StateBackup.ImportCache? cache, Func<int, int, Task> progress)
        {
            var result = new Result();
            var existing = new HashSet<string>(StateWatchLater.Instance.GetWatchLater().Select(v => v.Url), StringComparer.OrdinalIgnoreCase);
            int done = 0;
            foreach (var item in items)
            {
                try
                {
                    var (url, parsed) = ParseVideoEntry(item);
                    if (string.IsNullOrEmpty(url) || existing.Contains(url))
                        continue;
                    PlatformVideo? video = FromCache(cache, url) ?? parsed;
                    if (video == null || video.Thumbnails == null || video.Thumbnails.Sources.Length == 0)
                    {
                        try
                        {
                            if (StatePlatform.GetContentDetails(url) is PlatformVideo details)
                                video = details;
                        }
                        catch (Exception ex)
                        {
                            if (video == null)
                                throw new Exception($"[{url}] {ex.Message}", ex);
                        }
                    }
                    if (video == null)
                        throw new Exception($"[{url}] isn't a video");
                    StateWatchLater.Instance.Add(video, false);
                    existing.Add(url);
                    result.Imported++;
                }
                catch (Exception ex)
                {
                    result.Errors.Add(ex.Message);
                }
                finally
                {
                    done++;
                    if (done % 5 == 0 || done == items.Count)
                        await progress(done, items.Count);
                }
            }
            return result;
        }

        private static async Task<Result> ImportHistoryAsync(List<string> items, StateBackup.ImportCache? cache, Func<int, int, Task> progress)
        {
            var result = new Result();
            int done = 0;
            foreach (var item in items)
            {
                try
                {
                    var entry = ParseHistoryEntry(item, cache);
                    if (entry == null)
                    {
                        result.Warnings.Add("Skipped an unreadable history entry");
                        continue;
                    }
                    var index = StateHistory.GetHistoryByVideo(entry.Video, true, entry.Date);
                    if (index != null)
                        StateHistory.UpdateHistoryPosition(entry.Video, index, true, entry.Position, entry.Date);
                    result.Imported++;
                }
                catch (Exception ex)
                {
                    result.Errors.Add(ex.Message);
                }
                finally
                {
                    done++;
                    if (done % 25 == 0 || done == items.Count)
                        await progress(done, items.Count);
                }
            }
            return result;
        }

        private static (string? url, PlatformVideo? video) ParseVideoEntry(string item)
        {
            var text = item.Trim();
            if (text.StartsWith("{"))
            {
                var video = DeserializeVideo(text);
                return (video?.Url, video);
            }
            return (text, null);
        }

        private static HistoryVideo? ParseHistoryEntry(string item, StateBackup.ImportCache? cache)
        {
            var text = item.Trim();
            if (text.StartsWith("{"))
            {
                try
                {
                    var hist = (HistoryVideo)GJsonSerializer.AndroidCompatible.DeserializeObj(text, typeof(HistoryVideo));
                    if (hist?.Video?.Url != null)
                        return hist;
                }
                catch { }
                var video = DeserializeVideo(text);
                return video == null ? null : HistoryVideo.FromVideo(video, 0, DateTime.Now);
            }

            var parts = text.Split("|||");
            if (parts.Length < 2 || string.IsNullOrWhiteSpace(parts[0]))
                return null;
            var url = parts[0].Trim();
            var date = DateTime.Now;
            if (long.TryParse(parts[1], out var unix) && unix > 0)
                date = (unix > 100_000_000_000 ? DateTimeOffset.FromUnixTimeMilliseconds(unix) : DateTimeOffset.FromUnixTimeSeconds(unix)).LocalDateTime;
            long position = parts.Length > 2 && long.TryParse(parts[2], out var p) ? Math.Max(0, p) : 0;
            var name = parts.Length > 3 ? string.Join("|||", parts.Skip(3)) : url;

            var historyVideo = FromCache(cache, url) ?? MinimalVideo(url, name);
            historyVideo.Author ??= new PlatformAuthorLink() { ID = new Grayjay.Engine.Models.General.PlatformID() { Platform = "" }, Name = "", Url = "" };
            historyVideo.Author.ID ??= new Grayjay.Engine.Models.General.PlatformID() { Platform = "" };
            return HistoryVideo.FromVideo(historyVideo, position, date);
        }

        private static PlatformVideo? FromCache(StateBackup.ImportCache? cache, string url)
            => cache?.Videos?.FirstOrDefault(v => string.Equals(v.Url, url, StringComparison.OrdinalIgnoreCase));

        private static PlatformVideo? DeserializeVideo(string json)
        {
            try { return (PlatformVideo)GJsonSerializer.AndroidCompatible.DeserializeObj(json, typeof(PlatformVideo)); }
            catch { }
            try { return JsonSerializer.Deserialize<PlatformVideo>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }); }
            catch { return null; }
        }

        private static readonly Regex YouTubeId = new Regex(@"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/)|youtu\.be/)([\w-]{11})", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private static PlatformVideo MinimalVideo(string url, string name)
        {
            var video = new PlatformVideo()
            {
                Url = url,
                ShareUrl = url,
                Name = name,
                ID = new Grayjay.Engine.Models.General.PlatformID() { Platform = "", Value = url },
                // Upstream history code dereferences Author.ID, so it must exist (an empty author marks a "broken import"
                // that gets replaced with full details the next time the video is played).
                Author = new PlatformAuthorLink() { ID = new Grayjay.Engine.Models.General.PlatformID() { Platform = "" }, Name = "", Url = "" },
                Thumbnails = new Thumbnails()
            };
            var yt = YouTubeId.Match(url);
            if (yt.Success)
            {
                video.ID.Platform = "YouTube";
                video.Thumbnails = new Thumbnails()
                {
                    Sources = new[] { new Thumbnail() { Url = $"https://i.ytimg.com/vi/{yt.Groups[1].Value}/hqdefault.jpg", Quality = 480 } }
                };
            }
            return video;
        }
    }
}
