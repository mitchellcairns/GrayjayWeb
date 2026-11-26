using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Grayjay.ClientServer.Controllers;
using Grayjay.ClientServer.Helpers;
using Grayjay.ClientServer.Models.Downloads;
using Grayjay.ClientServer.Settings;
using Grayjay.ClientServer.States;
using Grayjay.ClientServer.Transcoding;
using Grayjay.Desktop.POC;
using Grayjay.Desktop.POC.Port.States;
using Grayjay.Engine.Models.Detail;
using Grayjay.Engine.Models.Feed;
using Grayjay.Engine.Models.Video;
using Grayjay.Engine.Models.Video.Sources;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] Downloads for the PWA, so videos play with no connection. The server downloads the video with Grayjay's
    /// own downloader (into its downloads folder), joins video and audio into one ordinary file, and the phone copies that
    /// file into its own storage. Formats are picked to play everywhere: H.264 + AAC in MP4 when the source has it.
    /// </summary>
    public static class WebDownloads
    {
        public class DownloadStatus
        {
            public string Url { get; set; } = "";
            /// <summary>queued, preparing, downloading, processing, ready or error.</summary>
            public string State { get; set; } = "queued";
            public double Progress { get; set; }
            public string? Error { get; set; }
            public string? Name { get; set; }
            public string? Author { get; set; }
            public string? AuthorUrl { get; set; }
            public string? AuthorThumbnail { get; set; }
            public string? Thumbnail { get; set; }
            public int Duration { get; set; }
            public long? DateTime { get; set; }
            public int Height { get; set; }
            public bool AudioOnly { get; set; }
            /// <summary>Size of the download on the server (video + audio), when known.</summary>
            public long? Size { get; set; }
        }

        private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> FileLocks = new();

        private static bool IsAvc(string? codec) => codec != null && (codec.StartsWith("avc", StringComparison.OrdinalIgnoreCase) || codec.Contains("h264", StringComparison.OrdinalIgnoreCase));
        private static bool IsMp4(string? container) => container != null && container.Contains("mp4", StringComparison.OrdinalIgnoreCase);
        private static bool IsWebm(string? container) => container != null && container.Contains("webm", StringComparison.OrdinalIgnoreCase);

        private static VideoDownload? Downloading(string url) =>
            StateDownloads.GetDownloading().FirstOrDefault(d => string.Equals(d.Video?.Url, url, StringComparison.OrdinalIgnoreCase));

        private static string? BestThumb(Grayjay.Engine.Models.General.Thumbnails? t) =>
            t?.Sources?.OrderByDescending(x => x.Quality).FirstOrDefault()?.Url;

        private static DownloadStatus Describe(PlatformVideo? video, PlatformVideoDetails? details)
        {
            var v = (PlatformVideo?)details ?? video;
            return new DownloadStatus
            {
                Url = v?.Url ?? "",
                Name = v?.Name,
                Author = v?.Author?.Name,
                AuthorUrl = v?.Author?.Url,
                AuthorThumbnail = v?.Author?.Thumbnail,
                Thumbnail = BestThumb(v?.Thumbnails),
                Duration = (int)(v?.Duration ?? 0),
                DateTime = v?.DateTime is DateTime dt && dt.Year > 1971 ? new DateTimeOffset(dt).ToUnixTimeSeconds() : null,
            };
        }

        private static DownloadStatus StatusOf(VideoDownload d)
        {
            var s = Describe(d.Video, d.VideoDetails);
            s.State = d.State switch
            {
                DownloadState.QUEUE => "queued",
                DownloadState.PREPARING => "preparing",
                DownloadState.DOWNLOADING => "downloading",
                DownloadState.VALIDATING or DownloadState.FINALIZING => "processing",
                DownloadState.COMPLETED => "processing",
                DownloadState.ERROR => "error",
                _ => "queued"
            };
            s.Progress = Math.Clamp(d.Progress, 0, 1);
            s.Error = d.Error;
            s.Height = d.VideoSource?.Height ?? 0;
            s.AudioOnly = d.VideoSource == null && d.AudioSource != null;
            return s;
        }

        private static DownloadStatus StatusOf(VideoLocal l)
        {
            var s = Describe(l.VideoDetails, l.VideoDetails);
            s.State = "ready";
            s.Progress = 1;
            var video = l.VideoSources.FirstOrDefault();
            s.Height = video?.Height ?? 0;
            s.AudioOnly = video == null;
            s.Size = l.VideoSources.Sum(x => x.FileSize) + l.AudioSources.Sum(x => x.FileSize);
            return s;
        }

        public static DownloadStatus? Status(string url)
        {
            var local = StateDownloads.GetDownloadedVideo(url);
            if (local != null) return StatusOf(local);
            var d = Downloading(url);
            return d != null ? StatusOf(d) : null;
        }

        public static List<DownloadStatus> List() =>
            StateDownloads.GetDownloading().Where(d => d.Video != null).Select(StatusOf)
                .Concat(StateDownloads.GetDownloaded().Where(l => l.VideoDetails != null).Select(StatusOf))
                .ToList();

        /// <summary>Picks sources that play anywhere (H.264/AAC in MP4 first) at most <paramref name="maxHeight"/> tall, and starts.</summary>
        public static DownloadStatus Start(string url, int maxHeight)
        {
            var existing = Status(url);
            if (existing != null && existing.State != "error") return existing;
            if (existing?.State == "error")
            {
                var failed = Downloading(url);
                if (failed != null) StateDownloads.RemoveDownloading(failed);
            }

            if (StatePlatform.GetContentDetails(url) is not PlatformVideoDetails details)
                throw new InvalidOperationException("Only videos can be downloaded.");
            if ((existing = Status(details.Url)) != null && existing.State != "error") return existing;
            if (details.IsLive)
                throw new InvalidOperationException("Live streams can't be downloaded.");

            var videos = VideoHelper.ExpandUMPVideoSources(details.Video.VideoSources).Where(VideoHelper.IsDownloadable).ToList();
            var audios = (details.Video is UnMuxedVideoDescriptor unmuxed ? unmuxed.AudioSources?.Where(VideoHelper.IsDownloadable) ?? Enumerable.Empty<IAudioSource>() : Enumerable.Empty<IAudioSource>())
                .Concat(VideoHelper.GetUMPAudioSources(details.Video.VideoSources).Where(VideoHelper.IsDownloadable))
                .ToList();
            if (videos.Count == 0 && audios.Count == 0)
                throw new InvalidOperationException("This video can't be downloaded (it may be protected or a live stream).");

            IVideoSource? video = null;
            if (maxHeight > 0 && videos.Count > 0)
            {
                // HLS manifests need a variant picked from the manifest: let Grayjay's own downloader choose by size.
                if (videos.All(v => v is HLSManifestSource || v.Height <= 0))
                {
                    var byTarget = new VideoDownload(details, (long)maxHeight * maxHeight * 16 / 9, null);
                    StateDownloads.UpdateDownloading(byTarget);
                    _ = StateDownloads.StartDownloadCycle();
                    Logger.i(nameof(WebDownloads), $"Downloading [{details.Name}] up to {maxHeight}p (picked by the downloader)");
                    return StatusOf(byTarget);
                }
                var sized = videos.Where(v => v is not HLSManifestSource && v.Height > 0).ToList();
                var fits = sized.Where(v => v.Height <= maxHeight).ToList();
                if (fits.Count == 0) fits = sized.Where(v => v.Height == sized.Min(x => x.Height)).ToList();
                var best = fits.Max(v => v.Height);
                // Within the best height that fits: H.264 in MP4 plays on every phone (iPhones too); then MP4; then anything.
                var atBest = fits.Where(v => v.Height >= best * 0.9).ToList();
                video = atBest.FirstOrDefault(v => IsAvc(v.Codec) && IsMp4(v.Container))
                    ?? fits.Where(v => IsAvc(v.Codec) && IsMp4(v.Container)).OrderByDescending(v => v.Height).FirstOrDefault(v => v.Height >= best * 0.66)
                    ?? atBest.FirstOrDefault(v => IsMp4(v.Container))
                    ?? atBest.First();
            }
            else if (maxHeight > 0 && audios.Count == 0)
                throw new InvalidOperationException("This video can't be downloaded.");

            IAudioSource? audio = null;
            bool muxed = video != null && audios.Count == 0;
            if (!muxed && audios.Count > 0)
            {
                // Audio in the same family as the video, so the two join without converting: AAC with MP4 video (plays
                // everywhere; not e.g. IAMF/Opus-in-MP4), Opus/Vorbis with WebM.
                bool webm = video != null && IsWebm(video.Container);
                bool fits(IAudioSource a) => webm
                    ? IsWebm(a.Container)
                    : (a.Codec?.StartsWith("mp4a", StringComparison.OrdinalIgnoreCase) ?? false) || (a.Codec == null && IsMp4(a.Container));
                var compatible = audios.Where(fits).ToList();
                // Same kind of source as the video where possible (both direct links, or both streamed).
                var sameKind = compatible.Where(a => (a is UMPAudioFormatSource) == (video is UMPVideoFormatSource)).ToList();
                var pool = sameKind.Count > 0 ? sameKind : compatible.Count > 0 ? compatible : audios;
                audio = VideoHelper.SelectBestAudioSource(pool, new List<string> { webm ? "audio/webm" : "audio/mp4" }, GrayjaySettings.Instance.Playback.GetPrimaryLanguage());
            }
            if (video == null && audio == null)
                throw new InvalidOperationException("No downloadable audio or video found for this video.");

            var download = StateDownloads.StartDownload(details, video, audio, null);
            _ = StateDownloads.StartDownloadCycle();
            Logger.i(nameof(WebDownloads), $"Downloading [{details.Name}]: {video?.Height.ToString() ?? "no"}p {video?.Codec} {video?.Container} ({video?.GetType().Name}) + {audio?.Codec} {audio?.Container} ({audio?.GetType().Name})");
            return StatusOf(download);
        }

        public static void Remove(string url)
        {
            var d = Downloading(url);
            if (d != null)
            {
                StateDownloads.RemoveDownloading(d);
                // Partial files kept for resuming.
                foreach (var f in new[] { d.VideoFilePath, d.AudioFilePath }.Where(f => !string.IsNullOrEmpty(f)))
                {
                    try { if (File.Exists(VideoDownload.PartialMarker(f!))) { File.Delete(VideoDownload.PartialMarker(f!)); File.Delete(f!); } } catch { }
                }
            }
            var local = StateDownloads.GetDownloadedVideo(url);
            if (local != null)
            {
                DeleteOfflineFile(local);
                StateDownloads.RemoveDownloaded(local);
            }
        }

        private static string OfflineDirectory()
        {
            var dir = Path.Combine(StateDownloads.GetDownloadsDirectory(), "offline");
            Directory.CreateDirectory(dir);
            return dir;
        }
        private static string OfflineBase(VideoLocal l) =>
            Path.Combine(OfflineDirectory(), Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(l.Url ?? l.ID?.Value ?? ""))).ToLowerInvariant()[..20]);

        private static void DeleteOfflineFile(VideoLocal l)
        {
            foreach (var ext in new[] { ".mp4", ".webm", ".m4a", ".tmp.mp4", ".tmp.webm" })
                try { File.Delete(OfflineBase(l) + ext); } catch { }
        }

        private static string MimeFor(string path, bool audioOnly) => Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".webm" => audioOnly ? "audio/webm" : "video/webm",
            ".m4a" => "audio/mp4",
            ".mp3" => "audio/mpeg",
            ".ogg" or ".opus" => "audio/ogg",
            _ => audioOnly ? "audio/mp4" : "video/mp4",
        };

        /// <summary>One file with both video and audio for the phone to keep: joined once (no re-encoding) and reused.</summary>
        public static async Task<(string Path, string Mime)> OfflineFile(VideoLocal l)
        {
            var video = l.VideoSources.FirstOrDefault();
            var audio = l.AudioSources.FirstOrDefault();
            if (video == null && audio == null) throw new FileNotFoundException("This download has no files");
            var missing = new[] { video?.FilePath, audio?.FilePath }.FirstOrDefault(p => p != null && !File.Exists(p));
            if (missing != null) throw new FileNotFoundException("A downloaded file is missing on the server. Remove the download and download it again.");

            // Only one of the two: that file already plays on its own.
            if (video == null || audio == null)
            {
                var only = (video?.FilePath ?? audio!.FilePath)!;
                return (only, MimeFor(only, video == null));
            }

            var gate = FileLocks.GetOrAdd(l.Url ?? "", _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync();
            try
            {
                var container = DownloadController.ExportContainerFor(video.Container ?? "", video.Codec, audio.Container ?? "", audio.Codec);
                var ext = container == "webm" ? ".webm" : ".mp4";
                var output = OfflineBase(l) + ext;
                if (File.Exists(output) && new FileInfo(output).Length > 0) return (output, MimeFor(output, false));
                if (!FFMPEG.IsFFMPEGAvailable()) throw new InvalidOperationException("FFmpeg isn't available on the server, so video and audio can't be joined.");

                var temp = OfflineBase(l) + ".tmp" + ext;
                var args = new List<string> { "-hide_banner", "-loglevel", "error", "-i", video.FilePath, "-i", audio.FilePath, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy" };
                // MP4 can hold VP9/AV1/Opus too, if a source had nothing better (ExportContainerFor said mkv).
                if (ext == ".mp4") args.AddRange(new[] { "-strict", "experimental", "-movflags", "+faststart" });
                args.AddRange(new[] { "-y", temp });
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var code = await Task.Run(() => FFMPEG.ExecuteSafe(args.ToArray(), false));
                if (code != 0 || !File.Exists(temp))
                {
                    try { File.Delete(temp); } catch { }
                    throw new InvalidOperationException($"Couldn't join the video and audio (FFmpeg exited with code {code}).");
                }
                File.Move(temp, output, true);
                Logger.i(nameof(WebDownloads), $"Joined [{l.Name}] into {Path.GetFileName(output)} ({new FileInfo(output).Length / 1_000_000} MB, {sw.ElapsedMilliseconds}ms)");
                return (output, MimeFor(output, false));
            }
            finally { gate.Release(); }
        }

        public static void Map(IEndpointRouteBuilder app)
        {
            // Join video and audio as soon as a download finishes, so the phone's copy can start straight away.
            StateDownloads.OnDownloadCompleted += (download, local) =>
            {
                if (local == null) return;
                _ = Task.Run(async () =>
                {
                    try { await OfflineFile(local); }
                    catch (Exception e) { Logger.w(nameof(WebDownloads), $"Couldn't prepare [{local.Name}] for devices: {e.Message}"); }
                });
            };

            app.MapGet("/web/downloads/List", () => Results.Json(List()));
            app.MapGet("/web/downloads/Status", (string url) =>
                Status(url) is DownloadStatus s ? Results.Json(s) : Results.NotFound(new { error = "Not downloaded" }));
            app.MapPost("/web/downloads/Start", (string url, int? height) =>
            {
                try { return Results.Json(Start(url, height ?? 720)); }
                catch (Exception e) { return Results.BadRequest(new { error = e.Message }); }
            });
            app.MapPost("/web/downloads/Remove", (string url) => { Remove(url); return Results.Ok(true); });

            // The file the phone keeps. Range requests are supported (resuming, and playing it straight from the server).
            // With wait=1 the request is held until the server's download finishes: the phone's background download can be
            // started right away and completes with the app closed. Last-Modified/ETag let a browser resume it with If-Range.
            app.MapGet("/web/downloads/File", async (string url, int? wait, CancellationToken ct) =>
            {
                var local = StateDownloads.GetDownloadedVideo(url);
                if (local == null && wait == 1)
                {
                    var until = DateTime.UtcNow.AddHours(3);
                    int retries = 0;
                    while (local == null && DateTime.UtcNow < until && !ct.IsCancellationRequested)
                    {
                        var d = Downloading(url);
                        if (d == null) break;
                        if (d.State == DownloadState.ERROR)
                        {
                            // Nobody may be watching (the app is closed): retry here. It carries on from the partial file.
                            if (retries >= 3)
                                return Results.Problem(d.Error ?? "The server couldn't download it", statusCode: 502);
                            retries++;
                            Logger.w(nameof(WebDownloads), $"Download of [{d.Video?.Name}] failed ({d.Error}); retry {retries}/3");
                            try { await Task.Delay(3000 * retries, ct); } catch (OperationCanceledException) { break; }
                            if (Downloading(url)?.State == DownloadState.ERROR)
                            {
                                try { Start(url, d.VideoSource?.Height ?? (int)Math.Sqrt((d.TargetPixelCount ?? 1280 * 720) * 9 / 16.0)); }
                                catch (Exception e) { return Results.Problem(e.Message, statusCode: 502); }
                            }
                            continue;
                        }
                        try { await Task.Delay(2000, ct); } catch (OperationCanceledException) { break; }
                        local = StateDownloads.GetDownloadedVideo(url);
                    }
                }
                if (local == null) return Results.NotFound(new { error = "Not downloaded on the server (yet)" });
                try
                {
                    var (path, mime) = await OfflineFile(local);
                    var info = new FileInfo(path);
                    var etag = new Microsoft.Net.Http.Headers.EntityTagHeaderValue($"\"{info.Length:x}-{info.LastWriteTimeUtc.Ticks:x}\"");
                    return Results.File(path, mime, lastModified: info.LastWriteTimeUtc, entityTag: etag, enableRangeProcessing: true);
                }
                catch (Exception e) { return Results.Problem(e.Message, statusCode: 500); }
            });

            // Its thumbnail, for the offline list (fetched here: the image hosts don't allow the app to read them).
            app.MapGet("/web/downloads/Thumbnail", async (string url, CancellationToken ct) =>
            {
                var local = StateDownloads.GetDownloadedVideo(url);
                var thumb = BestThumb(local?.VideoDetails?.Thumbnails) ?? BestThumb(Downloading(url)?.Video?.Thumbnails);
                if (thumb == null || !Uri.TryCreate(thumb, UriKind.Absolute, out var u) || (u.Scheme != "https" && u.Scheme != "http"))
                    return Results.NotFound();
                try
                {
                    using var res = await Http.GetAsync(u, ct);
                    if (!res.IsSuccessStatusCode) return Results.StatusCode((int)res.StatusCode);
                    var bytes = await res.Content.ReadAsByteArrayAsync(ct);
                    if (bytes.Length > 5_000_000) return Results.NotFound();
                    return Results.File(bytes, res.Content.Headers.ContentType?.MediaType ?? "image/jpeg");
                }
                catch (Exception e) when (!ct.IsCancellationRequested) { return Results.Problem(e.Message, statusCode: 502); }
            });
        }
    }
}
