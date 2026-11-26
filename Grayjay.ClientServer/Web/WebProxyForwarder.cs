using Grayjay.ClientServer.Proxy;
using Grayjay.Desktop.POC;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] Exposes the internal loopback <see cref="HttpProxy"/> on the main (authenticated) origin.
    ///
    /// The desktop app hands the player URLs like http://127.0.0.1:RANDOM/{guid}. A phone can't reach that, and a second
    /// port would also bypass authentication, so in web mode <see cref="HttpProxy.Add"/> returns "/hp/{guid}" and this
    /// endpoint forwards to the loopback listener, streaming the response (Range requests included) back to the browser.
    /// </summary>
    public static class WebProxyForwarder
    {
        public const string Prefix = "/hp";

        private static readonly HttpClient _client = new HttpClient(new SocketsHttpHandler()
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = System.Net.DecompressionMethods.None,
            UseCookies = false,
            PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30)
        })
        {
            Timeout = Timeout.InfiniteTimeSpan
        };

        // Browser headers that must not leak to the internal proxy (and from there upstream).
        private static readonly HashSet<string> _blockedRequestHeaders = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Host", "Cookie", "Authorization", "Referer", "Origin", "Connection", "Keep-Alive", "Transfer-Encoding",
            "Upgrade", "Proxy-Connection", "TE", "Content-Length", "Content-Type", "X-Forwarded-For", "X-Forwarded-Proto",
            "X-Forwarded-Host", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User"
        };
        private static readonly HashSet<string> _blockedResponseHeaders = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Connection", "Keep-Alive", "Transfer-Encoding", "Upgrade", "Proxy-Connection", "Set-Cookie", "Access-Control-Allow-Origin",
            "Access-Control-Allow-Credentials", "Access-Control-Allow-Headers", "Access-Control-Allow-Methods", "Access-Control-Expose-Headers"
        };

        public static void Map(IEndpointRouteBuilder app)
        {
            app.Map(Prefix + "/{id:guid}", HandleAsync);
        }

        private static async Task HandleAsync(HttpContext ctx, Guid id)
        {
            var proxy = HttpProxy.Get(true);
            var target = $"http://127.0.0.1:{proxy.LocalEndPoint.Port}/{id}{ctx.Request.QueryString}";

            using var request = new HttpRequestMessage(new HttpMethod(ctx.Request.Method), target);
            if (ctx.Request.ContentLength > 0 || ctx.Request.Headers.TransferEncoding.Count > 0)
            {
                request.Content = new StreamContent(ctx.Request.Body);
                if (ctx.Request.ContentType != null)
                    request.Content.Headers.TryAddWithoutValidation("Content-Type", ctx.Request.ContentType);
            }
            foreach (var header in ctx.Request.Headers)
            {
                if (_blockedRequestHeaders.Contains(header.Key))
                    continue;
                request.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
            }

            HttpResponseMessage response;
            try
            {
                response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ctx.RequestAborted);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception e)
            {
                Logger.w(nameof(WebProxyForwarder), $"Forwarding to internal proxy failed for {id}.", e);
                ctx.Response.StatusCode = 502;
                return;
            }

            using (response)
            {
                ctx.Response.StatusCode = (int)response.StatusCode;
                foreach (var header in response.Headers.Concat(response.Content.Headers))
                {
                    if (_blockedResponseHeaders.Contains(header.Key))
                        continue;
                    ctx.Response.Headers[header.Key] = header.Value.ToArray();
                }
                // Media is only ever played from our own origin.
                ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
                ctx.Response.Headers["Cache-Control"] = response.Headers.CacheControl?.ToString() ?? "private, no-store";

                try
                {
                    await using var body = await response.Content.ReadAsStreamAsync(ctx.RequestAborted);
                    await body.CopyToAsync(ctx.Response.Body, 64 * 1024, ctx.RequestAborted);
                }
                catch (OperationCanceledException) { }
                catch (IOException) { }
            }
        }
    }
}
