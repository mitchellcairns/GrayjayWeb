using System.Net;
using Grayjay.ClientServer.ExceptionHandlers;
using Grayjay.ClientServer.Proxy;
using Grayjay.ClientServer.States;
using Grayjay.ClientServer.WebSockets;
using System.Diagnostics;
using Microsoft.Extensions.FileProviders;
using Grayjay.Desktop.POC;
using Grayjay.ClientServer.Settings;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Grayjay.Engine.Packages;
using System.Collections.Concurrent;
using Grayjay.ClientServer.Web;

namespace Grayjay.ClientServer
{
    public class GrayjayServer
    {
        private const bool ShowAspLogs = false;

        WebApplication _app;

        public static GrayjayServer Instance { get; private set; }

        public IWindowProvider WindowProvider { get; private set; }
        public IWindowProvider GetWindowProviderOrThrow() => WindowProvider ?? throw new InvalidOperationException("No WindowProvider set");
        public bool ServerMode = true;
        public bool HeadlessMode = true;

        public WebSocketEndpoint WebSocket { get; private set; } = new WebSocketEndpoint("/ws");
        public ManualResetEventSlim StartedResetEvent = new ManualResetEventSlim(false);
        public Uri? BaseUri { get; private set; } = null;
        public string? BaseUrl { get; private set; } = null;

        public bool UseTokenSecurity { get; private set; } = true;

        /// <summary>[GrayjayWeb] Set to run as a self-hosted web app backend. See <see cref="WebHostOptions"/>.</summary>
        public WebHostOptions? Web { get; set; } = null;
        public WebAuth? WebAuth { get; private set; } = null;
        public bool IsWebMode => Web != null;
        private ConcurrentDictionary<string, string> _tokens = new ConcurrentDictionary<string, string>();

        public GrayjayServer(IWindowProvider windowProvider = null, bool isHeadlessMode = false, bool isServerMode = false, bool tokenSecurity = true)
        {
            WindowProvider = windowProvider;
            HeadlessMode = isHeadlessMode;
            ServerMode = isServerMode;
            Instance = this;
            UseTokenSecurity = tokenSecurity;
        }

        public async Task RunServerAsync(string proxyUrl = null, CancellationToken cancellationToken = default)
        {
            Logger.i(nameof(GrayjayServer), $"RunServerAsync: Called with (proxyUrl = {proxyUrl}).");

            if (Constants.App.Version > PackageBridge.AppVersion)
                PackageBridge.AppVersion = Constants.App.Version;

            var builder = WebApplication.CreateBuilder();
            if (Web != null)
            {
                WebAuth = new WebAuth(Web);
                HttpProxy.PublicPrefix = WebProxyForwarder.Prefix;
                builder.Services.AddSingleton(Web);
                builder.Services.AddSingleton(WebAuth);
            }

            builder.WebHost.ConfigureKestrel(serverOptions =>
            {
                if (Web != null)
                {
                    Logger.Info<GrayjayServer>($"Running in Web mode, listening on {Web.ListenAddress}:{Web.Port}");
                    serverOptions.Listen(Web.ListenAddress, Web.Port);
                    if (Web.ListenAddress.Equals(IPAddress.Any) && System.Net.Sockets.Socket.OSSupportsIPv6)
                    {
                        try { serverOptions.Listen(IPAddress.IPv6Loopback, Web.Port); } catch { }
                    }
                }
                else if (ServerMode)
                {
                    Logger.Info<GrayjayServer>("Running in Server mode, listening to all ips on port 11338");
                    serverOptions.Listen(IPAddress.Any, 11338);
                }
                else
                    serverOptions.Listen(IPAddress.Loopback, 0);
            });

            builder.Services
                .AddExceptionHandler<ScriptExceptionHandler>()
                .AddLogging((logBuilder) =>
                {
                    logBuilder.ClearProviders();
                    logBuilder.AddProvider(new GrayjayLoggerProvider());
                })
                .AddControllers()
                /*
                .AddJsonOptions((options) =>
                {
                    var converters = GJsonSerializer.Options.Converters;
                    foreach (var converter in converters)
                        options.JsonSerializerOptions.Converters.Add(converter);
                })*/
                .AddApplicationPart(typeof(GrayjayServer).Assembly);
            _app = builder.Build();

            _app.UseExceptionHandler(o => { });
            if (Web != null)
            {
                // Must run before websockets, static files and controllers so every non-public route is authenticated.
                _app.UseMiddleware<WebAuthMiddleware>();
                // Static files must run before routing, or the SPA fallback endpoint would shadow them.
                UseWebAppStaticFiles(_app, Web);
            }
            _app.UseWebSockets();
            _app.UseRouting();
            _app.MapControllers();
            _app.Lifetime.ApplicationStarted.Register(() =>
            {
                var server = _app.Services.GetRequiredService<IServer>();
                var addressFeature = server.Features.Get<IServerAddressesFeature>()!;
                var address = addressFeature.Addresses.First();

                Logger.i(nameof(GrayjayServer), $"RunServerAsync: Server running on {address}.");
                BaseUri = new Uri(address.Replace("://0.0.0.0", "://127.0.0.1").Replace("://[::]", "://127.0.0.1"));
                BaseUrl = address;
                if (BaseUrl.EndsWith('/'))
                    BaseUrl = BaseUrl.Substring(0, BaseUrl.Length - 1);
                // In web mode every URL handed to clients must be same-origin relative: the browser may be on another device.
                if (Web != null)
                    BaseUrl = "";

                StartedResetEvent.Set();
            });

            if (Web != null)
            {
                _app.MapGet("/", () => Results.Redirect(WebHostOptions.AppPath + "/"));
                WebAuth!.MapEndpoints(_app);
                WebProxyForwarder.Map(_app);
                WebSetupEndpoints.Map(_app);
                WebHiddenCreators.Map(_app);
                WebDeviceSync.Map(_app);
                MapWebApp(_app, Web);
                WebEndpointsHook?.Invoke(_app);
            }
            else
            {
                _app.MapGet("/", () => Results.Redirect(GetIndexUrl()));
            }
            _app.MapGet("/dev", () => Results.Redirect("/Developer/Index"));
            _app.MapGet("/Developer/source.js", () => Results.Redirect("/Developer/Source"));
            _app.MapGet("/Developer/dev_bridge.js", () => Results.Redirect("/Developer/DevBridge"));
            _app.MapGet("/Developer/source_docs.js", () => Results.Redirect("/Developer/SourceDocs"));
            _app.MapGet("/Developer/source_doc_urls.js", () => Results.Redirect("/Developer/SourceDocUrls"));

            if (proxyUrl != null)
            {
                _app.MapWhen((context) => context.Request.Path.StartsWithSegments("/web"), (builder) =>
                {
                    builder.Run(async (context) =>
                    {
                        string query = context.Request.QueryString.Value;
                        string url = proxyUrl + context.Request.Path + ((string.IsNullOrEmpty(query)) ? "" : "?" + query);

                        using (HttpClient client = new HttpClient())
                        {
                            foreach (var header in context.Request.Headers)
                                client.DefaultRequestHeaders.Add(header.Key, header.Value.ToList());
                            HttpResponseMessage resp = await client.GetAsync(url);
                            int code = (int)resp.StatusCode;
                            if (code != 200)
                                context.Response.StatusCode = code;
                            else
                            {
                                context.Response.ContentType = resp.Content.Headers.ContentType.MediaType;
                                context.Response.Headers.Add("Referrer-Policy", "no-referrer");
                                await resp.Content.ReadAsStream().CopyToAsync(context.Response.Body);
                            }
                        }
                    });
                });
            }
            else
            {
                string? staticFilesPath = Utilities.FindDirectory("wwwroot");
                if (staticFilesPath == null && Web == null)
                    throw new Exception("Failed to find wwwroot.");
                // [GrayjayWeb] The desktop UI (wwwroot/web) is optional in web mode; the PWA is served from /app instead.
                if (staticFilesPath != null)
                {

                Logger.i(nameof(GrayjayServer), $"RunServerAsync: Static files path '" + staticFilesPath + "'.");
                _app.UseStaticFiles(new StaticFileOptions
                {
                    FileProvider = new PhysicalFileProvider(staticFilesPath),
                    OnPrepareResponse = (act) =>
                    {
                        act.Context.Response.Headers.Append("Referrer-Policy", "no-referrer");
                    }
                });

                _app.MapFallback(context =>
                {
                    context.Response.ContentType = "text/html";
                    return context.Response.SendFileAsync(Path.Combine(staticFilesPath, "web", "index.html"));
                });
                }
            }

            Logger.i(nameof(GrayjayServer), $"RunServerAsync: MapWhen Websocket.");
            _app.MapWhen(x => x.Request.Path.StartsWithSegments(WebSocket.Url), (builder) =>
            {
                builder.Run(async (context) =>
                {
                    if (context.WebSockets.IsWebSocketRequest)
                    {
                        var websocket = await context.WebSockets.AcceptWebSocketAsync();

                        //TODO: New thread
                        await WebSocket.HandleClient(websocket);
                    }
                    else
                        context.Response.StatusCode = 400;
                });
            });

            Logger.i(nameof(GrayjayServer), $"RunServerAsync: Start StateCasting.");
            //TODO: Start everything
            StateCasting.Instance.Start();
            if (GrayjaySettings.Instance.Synchronization.Enabled)
                await StateSync.Instance.StartAsync();

            if (Web == null)
                _app.UseMiddleware<TokenMiddleware>(this);
            _app.UseMiddleware<RequestLoggingMiddleware>();
            Logger.i(nameof(GrayjayServer), $"RunServerAsync: _app.RunAsync(cancellationToken) starting...");
            _ = Task.Run(async () =>
            {
                try
                {
                    await StateDownloads.StartDownloadCycle();
                }
                catch (Exception e)
                {
                    Logger.e(nameof(GrayjayServer), "Exception occurred in StartDownloadCycle.", e);
                }
            });

            await _app.RunAsync(cancellationToken);
            Logger.i(nameof(GrayjayServer), $"RunServerAsync: _app.RunAsync(cancellationToken) finished.");
        }
        /// <summary>[GrayjayWeb] Extra endpoints to map in web mode (e.g. the remote login browser).</summary>
        public static Action<WebApplication>? WebEndpointsHook { get; set; }

        private static bool HasWebApp(WebHostOptions web)
            => web.AppRoot != null && Directory.Exists(web.AppRoot) && File.Exists(Path.Combine(web.AppRoot, "index.html"));

        private static void UseWebAppStaticFiles(WebApplication app, WebHostOptions web)
        {
            if (!HasWebApp(web))
                return;
            string root = web.AppRoot!;
            Logger.i(nameof(GrayjayServer), $"Serving PWA from '{root}' at {WebHostOptions.AppPath}.");
            var provider = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
            provider.Mappings[".webmanifest"] = "application/manifest+json";
            app.UseStaticFiles(new StaticFileOptions
            {
                FileProvider = new PhysicalFileProvider(root),
                RequestPath = WebHostOptions.AppPath,
                ContentTypeProvider = provider,
                OnPrepareResponse = (ctx) =>
                {
                    var headers = ctx.Context.Response.Headers;
                    headers["Referrer-Policy"] = "no-referrer";
                    headers["X-Content-Type-Options"] = "nosniff";
                    var name = ctx.File.Name;
                    if (ctx.Context.Request.Path.StartsWithSegments(WebHostOptions.AppPath + "/assets"))
                        headers["Cache-Control"] = "public, max-age=31536000, immutable";
                    else
                        headers["Cache-Control"] = "no-cache";
                    if (name == "sw.js")
                        headers["Service-Worker-Allowed"] = WebHostOptions.AppPath + "/";
                }
            });
        }

        /// <summary>[GrayjayWeb] Serves the PWA under /app with an SPA fallback and PWA-friendly caching.</summary>
        private static void MapWebApp(WebApplication app, WebHostOptions web)
        {
            string? root = web.AppRoot;
            if (root == null || !Directory.Exists(root) || !File.Exists(Path.Combine(root, "index.html")))
            {
                Logger.w(nameof(GrayjayServer), $"PWA not found at '{root}'. Build Grayjay.Web.App (npm run build) or pass --app-root.");
                app.MapGet(WebHostOptions.AppPath + "/{**rest}", () => Results.Content(
                    "<!doctype html><meta name=viewport content='width=device-width'><body style='font-family:system-ui;background:#111;color:#eee;padding:2rem'>" +
                    "<h1>Grayjay Web</h1><p>The server is running, but the web app has not been built.</p><p>Run <code>npm install && npm run build</code> in <code>Grayjay.Web.App</code>.</p>",
                    "text/html"));
                return;
            }

            var index = Path.Combine(root, "index.html");
            app.MapFallback(WebHostOptions.AppPath + "/{**rest:nonfile}", async (HttpContext ctx) =>
            {
                ctx.Response.ContentType = "text/html; charset=utf-8";
                ctx.Response.Headers["Cache-Control"] = "no-cache";
                ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
                await ctx.Response.SendFileAsync(index);
            });
        }

        public async Task StopServer()
        {
            //TODO: Stop other things?
            WebSocket.Dispose();
            StateSync.Cleanup();
            StateCasting.Instance.Dispose();
            await GrayjayCastingServer.StopAsync();
            await _app.StopAsync();
            HttpProxy.Stop();
        }


        public string GetFullIndexUrl()
        {
            return $"{GrayjayServer.Instance.BaseUrl}{GrayjayServer.Instance.GetIndexUrl()}";
        }
        public string GetIndexUrl()
        {
            return "/web/index.html";
        }
        public bool HasToken(string token)
        {
            return _tokens.ContainsKey(token);
        }
        public string GetToken(string id)
        {
            return _tokens.FirstOrDefault(x => x.Value == id).Key;
        }
        public void RegisterToken(string token)
        {
            _tokens.TryAdd(token, null);
        }

        public async Task RegisterTokenWindow(IWindow window)
        {
            var modifierToken = Guid.NewGuid().ToString();
            RegisterToken(modifierToken);
            await window.SetRequestModifier((req) =>
            {
                var uri = new Uri(req.Url);
                if (uri.Authority == GrayjayServer.Instance.BaseUri?.Authority)
                    req.Headers["_token"] = new List<string>() { modifierToken.ToString() };
                return req;
            });
        }
    }
}
