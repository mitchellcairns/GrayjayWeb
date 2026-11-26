using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using Grayjay.ClientServer.Controllers;
using Grayjay.ClientServer.States;
using Grayjay.Desktop.POC.Port.States;
using Grayjay.Desktop.POC;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] Opens links that aren't a source's own URL yet: shortened links (t.co, search.app / share.google,
    /// goo.gl, bit.ly, dis.gd…) and redirect wrappers (google.com/url?q=, youtube.com/redirect?q=, l.facebook.com…).
    /// Unwraps and follows redirects (up to a few hops) until a source recognises the address, like a browser would.
    /// Only public internet addresses are fetched: never this machine, the LAN or the tailnet.
    /// </summary>
    public static class WebLinks
    {
        private const int MaxHops = 6;
        private const int MaxHtmlBytes = 256 * 1024;

        private static readonly HttpClient Http = CreateClient();

        private static HttpClient CreateClient()
        {
            var handler = new SocketsHttpHandler
            {
                AllowAutoRedirect = false,
                AutomaticDecompression = DecompressionMethods.All,
                ConnectTimeout = TimeSpan.FromSeconds(5),
                // Checked at connect time, so a hostname can't point us at a private address (or switch to one later).
                ConnectCallback = async (ctx, ct) =>
                {
                    var addresses = await Dns.GetHostAddressesAsync(ctx.DnsEndPoint.Host, ct);
                    var target = addresses.FirstOrDefault(IsPublic)
                        ?? throw new HttpRequestException($"{ctx.DnsEndPoint.Host} isn't a public internet address");
                    var socket = new Socket(target.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                    try
                    {
                        await socket.ConnectAsync(new IPEndPoint(target, ctx.DnsEndPoint.Port), ct);
                        return new NetworkStream(socket, ownsSocket: true);
                    }
                    catch { socket.Dispose(); throw; }
                }
            };
            var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(8) };
            // A plain (non-browser) client: shorteners like t.co answer it with a real redirect instead of a JS page.
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (compatible; GrayjayWeb link resolver)");
            client.DefaultRequestHeaders.Accept.ParseAdd("text/html,*/*;q=0.8");
            return client;
        }

        public static bool IsPublic(IPAddress ip)
        {
            if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
            if (IPAddress.IsLoopback(ip)) return false;
            var b = ip.GetAddressBytes();
            if (ip.AddressFamily == AddressFamily.InterNetwork)
            {
                return !(b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224
                    || (b[0] == 100 && b[1] >= 64 && b[1] <= 127)   // CGNAT, incl. Tailscale
                    || (b[0] == 169 && b[1] == 254)
                    || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
                    || (b[0] == 192 && b[1] == 168)
                    || (b[0] == 192 && b[1] == 0 && b[2] == 0)
                    || (b[0] == 198 && (b[1] == 18 || b[1] == 19)));
            }
            if (ip.AddressFamily == AddressFamily.InterNetworkV6)
            {
                return !(ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6Multicast || ip.Equals(IPAddress.IPv6None)
                    || (b[0] & 0xfe) == 0xfc);                       // unique local (fc00::/7), incl. Tailscale
            }
            return false;
        }

        /// <summary>What a source can do with this exact URL, or null.</summary>
        private static string? Classify(string url)
        {
            if (StatePlatform.GetContentClientOrNull(url) != null) return HandlePlan.TYPE_CONTENT;
            if (StatePlatform.GetChannelClientOrNull(url) != null) return HandlePlan.TYPE_CHANNEL;
            if (StatePlatform.GetPlaylistClientOrNull(url) != null) return HandlePlan.TYPE_PLAYLIST;
            return null;
        }

        private static Uri? AsWebUri(string? s) =>
            Uri.TryCreate(s?.Trim(), UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps) ? u : null;

        private static string? Query(Uri u, string name)
        {
            foreach (var part in u.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var eq = part.IndexOf('=');
                if (eq > 0 && part[..eq] == name) return Uri.UnescapeDataString(part[(eq + 1)..].Replace('+', ' '));
            }
            return null;
        }

        /// <summary>Redirect wrappers carry the real address in a query parameter: no need to fetch them.</summary>
        private static Uri? Unwrap(Uri u)
        {
            var host = u.Host.ToLowerInvariant();
            var path = u.AbsolutePath;
            string? inner = null;
            if (Regex.IsMatch(host, @"(^|\.)google\.[a-z.]+$") && path == "/url") inner = Query(u, "q") ?? Query(u, "url");
            else if (host.EndsWith("youtube.com") && path == "/redirect") inner = Query(u, "q");
            else if ((host == "l.facebook.com" || host == "lm.facebook.com") && path.StartsWith("/l.php")) inner = Query(u, "u");
            else if (host == "l.instagram.com") inner = Query(u, "u");
            else if (host == "l.messenger.com") inner = Query(u, "u");
            else if (host == "out.reddit.com") inner = Query(u, "url");
            else if (host == "t.umblr.com" && path == "/redirect") inner = Query(u, "z");
            else if (host == "href.li") inner = u.Query.TrimStart('?');
            else if (host == "steamcommunity.com" && path.StartsWith("/linkfilter")) inner = Query(u, "url") ?? Query(u, "u");
            return AsWebUri(inner);
        }

        private static readonly Regex MetaRefresh = new(@"<meta[^>]+http-equiv\s*=\s*[""']?refresh[""']?[^>]*content\s*=\s*[""']?\s*\d*\s*;?\s*url\s*=\s*['""]?([^""'>\s]+)", RegexOptions.IgnoreCase);
        private static readonly Regex MetaRefreshRev = new(@"<meta[^>]+content\s*=\s*[""']?\s*\d*\s*;?\s*url\s*=\s*['""]?([^""'>\s]+)[^>]*http-equiv\s*=\s*[""']?refresh", RegexOptions.IgnoreCase);
        private static readonly Regex JsLocation = new(@"(?:window\.|document\.)?location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase);
        private static readonly Regex OgUrl = new(@"<meta[^>]+property\s*=\s*[""']og:url[""'][^>]*content\s*=\s*[""']([^""']+)[""']", RegexOptions.IgnoreCase);

        /// <summary>Where this address sends a browser next: an HTTP redirect, or a page that redirects with a meta tag or script.</summary>
        private static async Task<Uri?> NextHop(Uri u, CancellationToken ct)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, u);
            using var res = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            var code = (int)res.StatusCode;
            if (code >= 300 && code < 400 && res.Headers.Location != null)
                return AsWebUri(new Uri(u, res.Headers.Location).ToString());
            if (!res.IsSuccessStatusCode) return null;
            var type = res.Content.Headers.ContentType?.MediaType ?? "";
            if (!type.Contains("html")) return null;

            await using var stream = await res.Content.ReadAsStreamAsync(ct);
            var buffer = new byte[MaxHtmlBytes];
            int total = 0, read;
            while (total < buffer.Length && (read = await stream.ReadAsync(buffer.AsMemory(total), ct)) > 0) total += read;
            var html = System.Text.Encoding.UTF8.GetString(buffer, 0, total);

            foreach (var rx in new[] { MetaRefresh, MetaRefreshRev, JsLocation, OgUrl })
            {
                var m = rx.Match(html);
                if (!m.Success) continue;
                var raw = WebUtility.HtmlDecode(m.Groups[1].Value).Replace("\\/", "/");
                if (Uri.TryCreate(u, raw, out var next) && AsWebUri(next.ToString()) is Uri n && n != u) return n;
            }
            return null;
        }

        public static async Task<HandlePlan> Plan(string input, CancellationToken ct)
        {
            var original = input.Trim().TrimEnd('.', ',', ';', ':', '!', '?', ')', ']', '}', '"', '\'', '>');
            var url = AsWebUri(original);
            if (url == null) return new HandlePlan { Type = HandlePlan.TYPE_NONE, Data = original };

            var seen = new HashSet<string>();
            for (int hop = 0; hop <= MaxHops; hop++)
            {
                for (var inner = Unwrap(url); inner != null; inner = Unwrap(inner)) url = inner;
                var current = url.ToString();
                var type = Classify(current);
                if (type != null) return new HandlePlan { Type = type, Data = current };
                if (hop == MaxHops || !seen.Add(current)) break;
                try
                {
                    var next = await NextHop(url, ct);
                    if (next == null) break;
                    url = next;
                }
                catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    Logger.i(nameof(WebLinks), $"Couldn't follow {url.Host}: {e.Message}");
                    break;
                }
            }
            return new HandlePlan { Type = HandlePlan.TYPE_NONE, Data = original };
        }

        public static void Map(IEndpointRouteBuilder app)
        {
            // Like /handle/GetHandlePlan, plus unwrapping and following short links. Data is the address to open.
            app.MapGet("/web/link/Plan", async (string url, CancellationToken ct) =>
            {
                if (string.IsNullOrWhiteSpace(url)) return Results.BadRequest(new { error = "No link" });
                return Results.Json(await Plan(url, ct));
            });
        }
    }
}
