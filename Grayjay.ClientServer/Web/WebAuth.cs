using System.Collections.Concurrent;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Grayjay.ClientServer.Constants;
using Grayjay.Desktop.POC;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] Device-pairing authentication for web mode.
    ///
    /// Every browser/PWA install is a "device" holding a random session token in an HttpOnly, SameSite=Strict cookie.
    /// New devices join by redeeming a short-lived one-time pairing code (shown as a QR code by an already-paired device
    /// or the tray app), by an optional password, or — on the host machine only — by the launcher's local secret.
    /// Only SHA-256 hashes of tokens are persisted (web_devices.json in the data directory).
    /// </summary>
    public class WebAuth
    {
        public const string CookieName = "gj_session";
        private const int TokenBytes = 32;
        private static readonly TimeSpan PairingCodeLifetime = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan CookieLifetime = TimeSpan.FromDays(400);
        private const string CodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

        public class Device
        {
            public string Id { get; set; } = "";
            public string TokenHash { get; set; } = "";
            public string Name { get; set; } = "";
            public DateTime Created { get; set; }
            public DateTime LastSeen { get; set; }
            public string? UserAgent { get; set; }
            public string Method { get; set; } = "";
        }

        private class PairingCode
        {
            public required string Code { get; init; }
            public required DateTime Expires { get; init; }
            public required string CreatedBy { get; init; }
        }

        private readonly object _lock = new object();
        private readonly Dictionary<string, Device> _devicesByHash = new Dictionary<string, Device>();
        private readonly Dictionary<string, PairingCode> _codes = new Dictionary<string, PairingCode>();
        private readonly ConcurrentDictionary<string, List<DateTime>> _failures = new ConcurrentDictionary<string, List<DateTime>>();
        private readonly string _storePath;
        private readonly WebHostOptions _options;

        public WebAuth(WebHostOptions options)
        {
            _options = options;
            _storePath = Path.Combine(Directories.Base, "web_devices.json");
            Load();
        }

        public bool PasswordEnabled => !string.IsNullOrEmpty(_options.Password);

        #region Store
        private void Load()
        {
            try
            {
                if (!File.Exists(_storePath))
                    return;
                var devices = JsonSerializer.Deserialize<List<Device>>(File.ReadAllText(_storePath)) ?? new List<Device>();
                lock (_lock)
                {
                    foreach (var d in devices)
                        _devicesByHash[d.TokenHash] = d;
                }
                Logger.i(nameof(WebAuth), $"Loaded {devices.Count} paired device(s).");
            }
            catch (Exception e)
            {
                Logger.e(nameof(WebAuth), "Failed to load paired devices, starting empty.", e);
            }
        }

        private void Save()
        {
            List<Device> devices;
            lock (_lock)
                devices = _devicesByHash.Values.ToList();
            try
            {
                var tmp = _storePath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(devices, new JsonSerializerOptions() { WriteIndented = true }));
                File.Move(tmp, _storePath, true);
            }
            catch (Exception e)
            {
                Logger.e(nameof(WebAuth), "Failed to save paired devices.", e);
            }
        }

        private static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

        private static string NewToken()
        {
            var bytes = RandomNumberGenerator.GetBytes(TokenBytes);
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        public Device? Validate(string? token)
        {
            if (string.IsNullOrEmpty(token) || token.Length > 200)
                return null;
            var hash = Hash(token);
            lock (_lock)
            {
                if (!_devicesByHash.TryGetValue(hash, out var device))
                    return null;
                var now = DateTime.UtcNow;
                if ((now - device.LastSeen) > TimeSpan.FromMinutes(10))
                {
                    device.LastSeen = now;
                    _ = Task.Run(Save);
                }
                return device;
            }
        }

        private (Device device, string token) CreateDevice(string? name, string? userAgent, string method)
        {
            var token = NewToken();
            var device = new Device()
            {
                Id = Guid.NewGuid().ToString("N").Substring(0, 12),
                TokenHash = Hash(token),
                Name = SanitizeName(name) ?? GuessDeviceName(userAgent),
                Created = DateTime.UtcNow,
                LastSeen = DateTime.UtcNow,
                UserAgent = userAgent?.Length > 300 ? userAgent.Substring(0, 300) : userAgent,
                Method = method
            };
            lock (_lock)
                _devicesByHash[device.TokenHash] = device;
            Save();
            Logger.i(nameof(WebAuth), $"Paired new device '{device.Name}' ({device.Id}) via {method}.");
            return (device, token);
        }

        public List<Device> GetDevices()
        {
            lock (_lock)
                return _devicesByHash.Values.OrderByDescending(x => x.LastSeen).ToList();
        }

        public bool RemoveDevice(string id)
        {
            bool removed;
            lock (_lock)
            {
                var hash = _devicesByHash.FirstOrDefault(x => x.Value.Id == id).Key;
                removed = hash != null && _devicesByHash.Remove(hash);
            }
            if (removed)
                Save();
            return removed;
        }
        #endregion

        #region Pairing codes
        public (string code, DateTime expires) CreatePairingCode(string createdBy)
        {
            var chars = new char[8];
            for (int i = 0; i < chars.Length; i++)
                chars[i] = CodeAlphabet[RandomNumberGenerator.GetInt32(CodeAlphabet.Length)];
            var code = new string(chars);
            var expires = DateTime.UtcNow + PairingCodeLifetime;
            lock (_lock)
            {
                foreach (var expired in _codes.Where(x => x.Value.Expires < DateTime.UtcNow).Select(x => x.Key).ToList())
                    _codes.Remove(expired);
                _codes[code] = new PairingCode() { Code = code, Expires = expires, CreatedBy = createdBy };
            }
            return (code, expires);
        }

        private bool RedeemPairingCode(string? code)
        {
            if (string.IsNullOrWhiteSpace(code))
                return false;
            code = new string(code.ToUpperInvariant().Where(c => !char.IsWhiteSpace(c) && c != '-').ToArray());
            lock (_lock)
            {
                if (_codes.TryGetValue(code, out var pc) && pc.Expires > DateTime.UtcNow)
                {
                    _codes.Remove(code);
                    return true;
                }
            }
            return false;
        }
        #endregion

        #region Rate limiting
        private bool IsRateLimited(string key)
        {
            var list = _failures.GetOrAdd(key, _ => new List<DateTime>());
            lock (list)
            {
                list.RemoveAll(x => x < DateTime.UtcNow - TimeSpan.FromMinutes(5));
                return list.Count >= 10;
            }
        }
        private void RecordFailure(string key)
        {
            var list = _failures.GetOrAdd(key, _ => new List<DateTime>());
            lock (list)
                list.Add(DateTime.UtcNow);
        }
        private static string ClientKey(HttpContext ctx) => ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        #endregion

        #region HTTP
        public static bool IsHttps(HttpContext ctx)
            => ctx.Request.IsHttps || string.Equals(ctx.Request.Headers["X-Forwarded-Proto"].FirstOrDefault(), "https", StringComparison.OrdinalIgnoreCase);

        private static void SetSessionCookie(HttpContext ctx, string token)
        {
            ctx.Response.Cookies.Append(CookieName, token, new CookieOptions()
            {
                HttpOnly = true,
                SameSite = SameSiteMode.Strict,
                Secure = IsHttps(ctx),
                Path = "/",
                MaxAge = CookieLifetime,
                IsEssential = true
            });
        }

        public Device? GetDevice(HttpContext ctx) => ctx.Items.TryGetValue("gj_device", out var d) ? d as Device : null;

        public static bool IsPublicPath(PathString path)
        {
            if (path == "/" || path == "/favicon.ico")
                return true;
            if (path.StartsWithSegments(WebHostOptions.AppPath))
                return true;
            if (path.Equals("/auth/Status", StringComparison.OrdinalIgnoreCase)
                || path.Equals("/auth/Pair", StringComparison.OrdinalIgnoreCase)
                || path.Equals("/auth/Login", StringComparison.OrdinalIgnoreCase)
                || path.Equals("/auth/Local", StringComparison.OrdinalIgnoreCase))
                return true;
            return false;
        }

        public class PairRequest { public string? Code { get; set; } public string? Name { get; set; } }
        public class LoginRequest { public string? Password { get; set; } public string? Name { get; set; } }

        public void MapEndpoints(IEndpointRouteBuilder app)
        {
            app.MapGet("/auth/Status", (HttpContext ctx) =>
            {
                var device = _options.DisableAuth ? null : Validate(ctx.Request.Cookies[CookieName]);
                return Results.Json(new
                {
                    authenticated = _options.DisableAuth || device != null,
                    authDisabled = _options.DisableAuth,
                    passwordEnabled = PasswordEnabled,
                    device = device == null ? null : new { id = device.Id, name = device.Name }
                });
            });

            app.MapPost("/auth/Pair", async (HttpContext ctx) =>
            {
                var key = ClientKey(ctx);
                if (IsRateLimited(key) || IsRateLimited("global"))
                    return Results.Json(new { error = "Too many attempts, try again in a few minutes." }, statusCode: 429);
                var req = await ctx.Request.ReadFromJsonAsync<PairRequest>();
                if (!RedeemPairingCode(req?.Code))
                {
                    RecordFailure(key);
                    RecordFailure("global");
                    return Results.Json(new { error = "That pairing code is invalid or expired." }, statusCode: 401);
                }
                var (device, token) = CreateDevice(req?.Name, ctx.Request.Headers.UserAgent.FirstOrDefault(), "pairing");
                SetSessionCookie(ctx, token);
                return Results.Json(new { ok = true, device = new { id = device.Id, name = device.Name } });
            });

            app.MapPost("/auth/Login", async (HttpContext ctx) =>
            {
                if (!PasswordEnabled)
                    return Results.Json(new { error = "Password login is disabled on this server. Pair this device instead." }, statusCode: 400);
                var key = ClientKey(ctx);
                if (IsRateLimited(key) || IsRateLimited("global"))
                    return Results.Json(new { error = "Too many attempts, try again in a few minutes." }, statusCode: 429);
                var req = await ctx.Request.ReadFromJsonAsync<LoginRequest>();
                if (req?.Password == null || !FixedTimeEquals(req.Password, _options.Password!))
                {
                    RecordFailure(key);
                    RecordFailure("global");
                    return Results.Json(new { error = "Wrong password." }, statusCode: 401);
                }
                var (device, token) = CreateDevice(req.Name, ctx.Request.Headers.UserAgent.FirstOrDefault(), "password");
                SetSessionCookie(ctx, token);
                return Results.Json(new { ok = true, device = new { id = device.Id, name = device.Name } });
            });

            // Used by the tray launcher on the host machine: GET /auth/Local?secret=...&next=/app/
            app.MapGet("/auth/Local", (HttpContext ctx, string? secret, string? next) =>
            {
                var key = ClientKey(ctx);
                if (IsRateLimited(key))
                    return Results.StatusCode(429);
                if (string.IsNullOrEmpty(_options.LocalSecret) || secret == null || !FixedTimeEquals(secret, _options.LocalSecret))
                {
                    RecordFailure(key);
                    return Results.Redirect(WebHostOptions.AppPath + "/");
                }
                var existing = Validate(ctx.Request.Cookies[CookieName]);
                if (existing == null)
                {
                    var (_, token) = CreateDevice("This computer", ctx.Request.Headers.UserAgent.FirstOrDefault(), "local");
                    SetSessionCookie(ctx, token);
                }
                var target = (next != null && next.StartsWith('/') && !next.StartsWith("//") && !next.StartsWith("/\\")) ? next : WebHostOptions.AppPath + "/";
                return Results.Redirect(target);
            });

            app.MapPost("/auth/Logout", (HttpContext ctx) =>
            {
                var device = GetDevice(ctx);
                if (device != null)
                    RemoveDevice(device.Id);
                ctx.Response.Cookies.Delete(CookieName, new CookieOptions() { Path = "/" });
                return Results.Json(new { ok = true });
            });

            app.MapPost("/auth/PairingCode", (HttpContext ctx) =>
            {
                var device = GetDevice(ctx);
                var (code, expires) = CreatePairingCode(device?.Id ?? "noauth");
                return Results.Json(new
                {
                    code,
                    expiresInSeconds = (int)(expires - DateTime.UtcNow).TotalSeconds,
                    links = GetPairingLinks(ctx, code)
                });
            });

            // Addresses phones should use (for the in-app setup guides): Tailscale Serve's HTTPS address and configured URLs.
            app.MapGet("/web/Addresses", () => Results.Json(new
            {
                tailscale = TailscaleInfo.ServeOrigin(_options.Port),
                configured = _options.PublicUrls.Select(u => u.TrimEnd('/')).ToList()
            }));

            app.MapGet("/auth/Devices", (HttpContext ctx) =>
            {
                var current = GetDevice(ctx);
                return Results.Json(GetDevices().Select(d => new
                {
                    id = d.Id,
                    name = d.Name,
                    created = d.Created,
                    lastSeen = d.LastSeen,
                    method = d.Method,
                    current = d.Id == current?.Id
                }));
            });

            app.MapDelete("/auth/Devices/{id}", (HttpContext ctx, string id) =>
            {
                var current = GetDevice(ctx);
                var removed = RemoveDevice(id);
                if (removed && current?.Id == id)
                    ctx.Response.Cookies.Delete(CookieName, new CookieOptions() { Path = "/" });
                return Results.Json(new { ok = removed });
            });
        }

        /// <summary>
        /// Candidate URLs a phone can use to reach this server, each carrying the pairing code in the fragment
        /// (fragments are never sent to servers or written to logs).
        /// </summary>
        private List<object> GetPairingLinks(HttpContext ctx, string code)
        {
            var links = new List<object>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            void add(string label, string origin, bool secure)
            {
                if (!seen.Add(origin))
                    return;
                links.Add(new { label, url = $"{origin}{WebHostOptions.AppPath}/#pair={code}", secure });
            }

            foreach (var configured in _options.PublicUrls)
            {
                var origin = configured.TrimEnd('/');
                if (origin.EndsWith(WebHostOptions.AppPath, StringComparison.OrdinalIgnoreCase))
                    origin = origin.Substring(0, origin.Length - WebHostOptions.AppPath.Length);
                add("Configured address", origin, origin.StartsWith("https://", StringComparison.OrdinalIgnoreCase));
            }

            // Tailscale Serve (HTTPS with a real certificate: the address phones can install the app from).
            var tailscaleOrigin = TailscaleInfo.ServeOrigin(_options.Port);
            if (tailscaleOrigin != null)
                add("Tailscale (HTTPS)", tailscaleOrigin, true);

            var host = ctx.Request.Host.Host;
            bool requestIsLoopback = host == "localhost" || (IPAddress.TryParse(host, out var hostIp) && IPAddress.IsLoopback(hostIp));
            if (!requestIsLoopback)
                add("This address", $"{(IsHttps(ctx) ? "https" : "http")}://{ctx.Request.Host}", IsHttps(ctx));

            if (_options.PublicUrls.Count > 0)
                return links;
            try
            {
                foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                        continue;
                    foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily != AddressFamily.InterNetwork)
                            continue;
                        var b = ua.Address.GetAddressBytes();
                        bool tailscale = b[0] == 100 && (b[1] & 0xC0) == 64; // 100.64.0.0/10 CGNAT range used by Tailscale
                        bool lan = b[0] == 10 || (b[0] == 172 && (b[1] & 0xF0) == 16) || (b[0] == 192 && b[1] == 168);
                        if (!tailscale && !lan)
                            continue;
                        add(tailscale ? $"Tailscale ({ni.Name})" : $"Local network ({ni.Name})", $"http://{ua.Address}:{_options.Port}", false);
                    }
                }
            }
            catch (Exception e)
            {
                Logger.w(nameof(WebAuth), "Failed to enumerate network interfaces.", e);
            }
            return links;
        }

        private static bool FixedTimeEquals(string a, string b)
        {
            var ha = SHA256.HashData(Encoding.UTF8.GetBytes(a));
            var hb = SHA256.HashData(Encoding.UTF8.GetBytes(b));
            return CryptographicOperations.FixedTimeEquals(ha, hb);
        }

        private static string? SanitizeName(string? name)
        {
            if (string.IsNullOrWhiteSpace(name))
                return null;
            name = new string(name.Where(c => !char.IsControl(c)).ToArray()).Trim();
            return name.Length == 0 ? null : (name.Length > 60 ? name.Substring(0, 60) : name);
        }

        private static string GuessDeviceName(string? ua)
        {
            if (ua == null) return "Unknown device";
            string os = ua.Contains("iPhone") ? "iPhone" : ua.Contains("iPad") ? "iPad" : ua.Contains("Android") ? "Android"
                : ua.Contains("Mac OS X") ? "Mac" : ua.Contains("Windows") ? "Windows" : ua.Contains("Linux") ? "Linux" : "Device";
            string browser = ua.Contains("Edg/") ? "Edge" : ua.Contains("Firefox/") ? "Firefox" : (ua.Contains("CriOS") || ua.Contains("Chrome/")) ? "Chrome"
                : ua.Contains("Safari/") ? "Safari" : "Browser";
            return $"{browser} on {os}";
        }
        #endregion
    }

    /// <summary>[GrayjayWeb] Rejects unauthenticated requests to every non-public route, including /ws and media.</summary>
    public class WebAuthMiddleware
    {
        private readonly RequestDelegate _next;
        private readonly WebAuth _auth;
        private readonly WebHostOptions _options;

        public WebAuthMiddleware(RequestDelegate next, WebAuth auth, WebHostOptions options)
        {
            _next = next;
            _auth = auth;
            _options = options;
        }

        public async Task InvokeAsync(HttpContext context)
        {
            // Cross-site WebSocket hijacking guard: the Origin of an upgrade must match the Host.
            if (context.WebSockets.IsWebSocketRequest)
            {
                var origin = context.Request.Headers.Origin.FirstOrDefault();
                if (!string.IsNullOrEmpty(origin) && (!Uri.TryCreate(origin, UriKind.Absolute, out var originUri)
                    || !string.Equals(originUri.Authority, context.Request.Host.Value, StringComparison.OrdinalIgnoreCase)))
                {
                    context.Response.StatusCode = 403;
                    return;
                }
            }

            if (!_options.DisableAuth && !WebAuth.IsPublicPath(context.Request.Path))
            {
                var device = _auth.Validate(context.Request.Cookies[WebAuth.CookieName]);
                if (device == null)
                {
                    context.Response.StatusCode = 401;
                    context.Response.ContentType = "application/json";
                    await context.Response.WriteAsync("{\"error\":\"unauthorized\"}");
                    return;
                }
                context.Items["gj_device"] = device;
            }

            await _next(context);
        }
    }
}
