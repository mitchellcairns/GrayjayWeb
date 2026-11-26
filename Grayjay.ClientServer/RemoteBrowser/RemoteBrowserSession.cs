using Grayjay.Desktop.POC;
using System.Diagnostics;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Grayjay.ClientServer.RemoteBrowser
{
    /// <summary>
    /// A server-side Chromium instance (one process + one temporary profile per session) driven over CDP, whose
    /// screen is streamed to web clients and which receives their input. Implements <see cref="IWindow"/> so it can
    /// be used as the "interceptor window" for plugin login and captcha flows: every network request (including
    /// iframes, popups and workers) is reported to the handler with its full request headers (cookie, user-agent,
    /// authorization, ...).
    /// </summary>
    public sealed class RemoteBrowserSession : IWindow
    {
        public const int DefaultMobileWidth = 390;
        public const int DefaultMobileHeight = 844;
        public const double DefaultMobileDpr = 3;
        public const int DefaultDesktopWidth = 1024;
        public const int DefaultDesktopHeight = 800;
        public const double DefaultDesktopDpr = 1;

        private const double MaxScreencastScale = 2;
        private const int MaxScreencastDimension = 2400;
        private const int FrameIntervalMs = 50; //~20fps cap
        private static readonly TimeSpan UnpairedRequestDelay = TimeSpan.FromMilliseconds(1000);

        private static readonly JsonSerializerOptions _jsonOptions = new JsonSerializerOptions();

        public string Id { get; } = Guid.NewGuid().ToString("N").Substring(0, 12);
        public string Title { get; }
        public string InitialUrl { get; }
        public string Url { get; private set; }
        public int Width { get; private set; }
        public int Height { get; private set; }
        public double Dpr { get; private set; }
        public bool Mobile { get; }
        /// <summary>[GrayjayWeb] Shown as a real window on the server's desktop instead of only being streamed.</summary>
        public bool Headful { get; private set; }
        private bool _persistentProfile;
        public DateTime CreatedAtUtc { get; } = DateTime.UtcNow;
        public DateTime LastActivityUtc { get; private set; } = DateTime.UtcNow;
        public bool IsStarted { get; private set; }
        public bool IsClosed => _closing;
        public int ViewerCount { get { lock (_lock) return _viewers.Count; } }
        public string? EffectiveUserAgent { get; private set; }

        private readonly string? _requestedUserAgent;
        private readonly string? _injectJs;
        private readonly Action<InterceptorRequest> _handler;
        private readonly object _handlerLock = new object();

        private Process? _process;
        private string? _profileDir;
        private CdpConnection? _cdp;
        private object? _uaOverride;
        private readonly StringBuilder _stderrTail = new StringBuilder();

        private readonly object _lock = new object();
        private readonly List<PageTarget> _pages = new List<PageTarget>();
        private readonly Dictionary<string, string> _childSessions = new Dictionary<string, string>(); //sessionId -> targetId
        private PageTarget? _activePage;
        private readonly TaskCompletionSource<PageTarget> _mainPageReady = new TaskCompletionSource<PageTarget>(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly List<RemoteBrowserViewer> _viewers = new List<RemoteBrowserViewer>();

        private readonly SemaphoreSlim _screencastLock = new SemaphoreSlim(1, 1);
        private string? _screencastSessionId;
        private long _lastAckTicks;
        private string? _lastFrameMessage;
        private string? _lastUrlMessage;

        private readonly SemaphoreSlim _inputLock = new SemaphoreSlim(1, 1);
        private int _mouseButtons;
        private DateTime _lastMouseDown = DateTime.MinValue;
        private double _lastMouseDownX, _lastMouseDownY;
        private int _clickCount;
        private readonly Dictionary<int, (double X, double Y)> _touches = new Dictionary<int, (double, double)>();

        private readonly object _netLock = new object();
        private readonly Dictionary<string, Queue<PendingRequest>> _pendingRequests = new Dictionary<string, Queue<PendingRequest>>();
        private readonly Dictionary<string, Queue<PendingExtraInfo>> _pendingExtraInfo = new Dictionary<string, Queue<PendingExtraInfo>>();
        private readonly Dictionary<string, PendingRequest> _recentUnpaired = new Dictionary<string, PendingRequest>();
        private Timer? _sweepTimer;
        // [GrayjayWeb] What kind of field has focus in the page (email, password, one-time code…), so the viewer's
        // hidden input can match it and phones offer the right keyboard and password-manager autofill.
        private Timer? _focusTimer;
        private int _focusCheckRunning;
        private string? _lastFieldKind;
        private string? _lastFieldMessage;
        private int _handlerErrors;

        private CancellationTokenSource? _ytCts;
        private List<YouTubeAccountPicker.Account>? _ytAccounts;
        private string? _lastYtMessage;

        private volatile bool _closing;
        private Task? _closeTask;
        private readonly object _closeLock = new object();
        private readonly object _eventLock = new object();
        private Action? _onClosed;
        private bool _closedFired;

        /// <summary>
        /// Fired exactly once when the session is closed for any reason (CloseAsync, user cancel, idle timeout,
        /// browser crash, server shutdown). Subscribing after the session already closed invokes the handler immediately.
        /// </summary>
        public event Action OnClosed
        {
            add
            {
                bool fireNow;
                lock (_eventLock)
                {
                    fireNow = _closedFired;
                    if (!fireNow)
                        _onClosed += value;
                }
                if (fireNow)
                    SafeInvoke(value);
            }
            remove
            {
                lock (_eventLock)
                    _onClosed -= value;
            }
        }

        private sealed class PageTarget
        {
            public required string SessionId { get; init; }
            public required string TargetId { get; init; }
            public string? OpenerId { get; init; }
            public string? MainFrameId { get; set; }
            public string Url { get; set; } = "about:blank";
            public TaskCompletionSource Ready { get; } = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        private sealed class PendingRequest
        {
            public required string Url { get; init; }
            public required string Method { get; init; }
            public required Dictionary<string, List<string>> Headers { get; init; }
            public long Ticks { get; init; } = Environment.TickCount64;
        }

        private sealed class PendingExtraInfo
        {
            public required Dictionary<string, List<string>> Headers { get; init; }
            public long Ticks { get; init; } = Environment.TickCount64;
        }

        internal RemoteBrowserSession(string title, string url, string? userAgent, bool useMobileEmulation, string? injectJs, Action<InterceptorRequest> handler)
        {
            Title = title ?? "";
            InitialUrl = url;
            Url = url;
            Mobile = useMobileEmulation;
            Width = useMobileEmulation ? DefaultMobileWidth : DefaultDesktopWidth;
            Height = useMobileEmulation ? DefaultMobileHeight : DefaultDesktopHeight;
            Dpr = useMobileEmulation ? DefaultMobileDpr : DefaultDesktopDpr;
            _requestedUserAgent = string.IsNullOrWhiteSpace(userAgent) ? null : userAgent.Trim();
            _injectJs = string.IsNullOrWhiteSpace(injectJs) ? null : injectJs;
            _handler = handler ?? (_ => { });
        }

        public object Describe() => new { id = Id, title = Title, url = Url, width = Width, height = Height, mobile = Mobile, headful = Headful };

        #region Startup

        internal async Task StartAsync(string profileDir, CancellationToken cancellationToken, bool headful = false, bool persistentProfile = false)
        {
            var exe = ChromiumLocator.FindOrThrow();
            _profileDir = profileDir;
            _persistentProfile = persistentProfile;
            Headful = headful;
            Directory.CreateDirectory(profileDir);
            // A reused profile still holds the previous run's port file; never connect to that stale endpoint.
            try { File.Delete(Path.Combine(profileDir, "DevToolsActivePort")); } catch { }
            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = false,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                RedirectStandardInput = false,
                CreateNoWindow = true
            };
            foreach (var arg in BuildArguments(profileDir, headful))
                psi.ArgumentList.Add(arg);

            Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Launching {(headful ? "headful" : "headless")} browser '{exe}' for '{Title}' (mobile={Mobile}).");
            var wsUrlTcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            _process = new Process() { StartInfo = psi, EnableRaisingEvents = true };
            _process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data == null)
                    return;
                lock (_stderrTail)
                {
                    _stderrTail.AppendLine(e.Data);
                    if (_stderrTail.Length > 8000)
                        _stderrTail.Remove(0, _stderrTail.Length - 8000);
                }
                var m = Regex.Match(e.Data, @"DevTools listening on (ws://\S+)");
                if (m.Success)
                    wsUrlTcs.TrySetResult(m.Groups[1].Value);
            };
            _process.OutputDataReceived += (_, e) => { };
            _process.Exited += (_, _) =>
            {
                wsUrlTcs.TrySetException(new InvalidOperationException("The browser exited during startup: " + GetStderrTail()));
                if (IsStarted)
                    _ = CloseInternalAsync("browser process exited");
            };
            if (!_process.Start())
                throw new InvalidOperationException("Failed to start browser process " + exe);
            BrowserProcessGuard.Adopt(_process);
            RemoteBrowserManager.TrackProcess(this);
            _process.BeginErrorReadLine();
            _process.BeginOutputReadLine();

            var wsUrl = await WaitForDevToolsAsync(profileDir, wsUrlTcs.Task, cancellationToken);
            Logger.i(nameof(RemoteBrowserSession), $"[{Id}] DevTools endpoint {wsUrl}");

            _cdp = new CdpConnection();
            _cdp.OnEvent += HandleCdpEvent;
            _cdp.OnDisconnected += () =>
            {
                if (IsStarted)
                    _ = CloseInternalAsync("DevTools connection lost");
            };
            await _cdp.ConnectAsync(new Uri(wsUrl), cancellationToken);

            var version = await _cdp.SendAsync("Browser.getVersion", cancellationToken: cancellationToken);
            var product = version.Str("product") ?? "";
            var browserUa = version.Str("userAgent") ?? "";
            var fullVersion = Regex.Match(product, @"/([\d.]+)").Groups[1].Value;
            if (string.IsNullOrEmpty(fullVersion))
                fullVersion = "124.0.0.0";
            var major = fullVersion.Split('.')[0];

            var ua = _requestedUserAgent;
            if (ua == null)
            {
                ua = Mobile
                    ? $"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Mobile Safari/537.36"
                    : browserUa.Replace("HeadlessChrome", "Chrome");
            }
            EffectiveUserAgent = ua;
            _uaOverride = UserAgentHelper.BuildOverride(ua, fullVersion, product);
            Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Browser {product}, user agent '{ua}'.");

            await _cdp.TrySendAsync("Browser.setDownloadBehavior", new { behavior = "deny" });
            await _cdp.SendAsync("Target.setDiscoverTargets", new { discover = true }, cancellationToken: cancellationToken);
            await _cdp.SendAsync("Target.setAutoAttach", new { autoAttach = true, waitForDebuggerOnStart = true, flatten = true }, cancellationToken: cancellationToken);

            //Attach to the already existing initial page if auto attach did not do it.
            var targets = await _cdp.SendAsync("Target.getTargets", cancellationToken: cancellationToken);
            if (targets.Obj("targetInfos") is JsonElement infos && infos.ValueKind == JsonValueKind.Array)
            {
                foreach (var info in infos.EnumerateArray())
                {
                    if (info.Str("type") != "page")
                        continue;
                    var targetId = info.Str("targetId");
                    if (targetId == null || info.Bool("attached") == true)
                        continue;
                    bool known;
                    lock (_lock)
                        known = _pages.Any(p => p.TargetId == targetId);
                    if (!known)
                        await _cdp.TrySendAsync("Target.attachToTarget", new { targetId, flatten = true });
                }
            }

            using (var startupTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
            {
                startupTimeout.CancelAfter(TimeSpan.FromSeconds(20));
                var main = await _mainPageReady.Task.WaitAsync(startupTimeout.Token);
                await main.Ready.Task.WaitAsync(startupTimeout.Token);
            }

            _sweepTimer = new Timer(_ => SweepPendingRequests(), null, 250, 250);
            _focusTimer = new Timer(_ => _ = CheckFocusedFieldAsync(), null, 1000, 1000);
            IsStarted = true;
            Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Remote browser session ready.");
        }

        /// <summary>Starts loading the initial URL. Called by the manager after the session was handed out.</summary>
        internal void BeginInitialNavigation()
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    //Give the caller a moment to store the IWindow reference and subscribe to OnClosed.
                    await Task.Delay(150);
                    var main = await _mainPageReady.Task;
                    if (_closing || _cdp == null)
                        return;
                    await _cdp.SendAsync("Page.navigate", new { url = InitialUrl }, main.SessionId);
                }
                catch (Exception ex)
                {
                    Logger.e(nameof(RemoteBrowserSession), $"[{Id}] Initial navigation to {InitialUrl} failed: {ex.Message}", ex);
                }
            });
        }

        private List<string> BuildArguments(string profileDir, bool headful)
        {
            var args = new List<string>()
            {
                "--remote-debugging-port=0",
                "--user-data-dir=" + profileDir,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-blink-features=AutomationControlled",
                "--password-store=basic",
                "--use-mock-keychain",
                "--disable-features=Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints",
                "--disable-renderer-backgrounding",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--mute-audio",
                $"--window-size={Math.Max(Width, 400)},{Math.Max(Height + (headful ? 120 : 0), 400)}"
            };
            if (!headful)
                args.Add("--headless=new");
            //Without this the screencast is captured at 1 physical px per CSS px regardless of the emulated DPR,
            //which looks blurry on phones. Frames are still capped by Page.startScreencast maxWidth/maxHeight.
            // [GrayjayWeb] Not for visible windows: it would scale the real window on the desktop as well.
            if (Mobile && !headful)
                args.Add("--force-device-scale-factor=" + MaxScreencastScale.ToString(CultureInfo.InvariantCulture));
            if (_requestedUserAgent != null)
                args.Add("--user-agent=" + _requestedUserAgent);

            if (OperatingSystem.IsLinux())
            {
                args.Add("--disable-dev-shm-usage");
                if (Environment.GetEnvironmentVariable("GRAYJAY_REMOTE_BROWSER_NO_SANDBOX") == "1" || string.Equals(Environment.UserName, "root", StringComparison.Ordinal))
                    args.Add("--no-sandbox");
            }

            var extra = Environment.GetEnvironmentVariable("GRAYJAY_REMOTE_BROWSER_ARGS");
            if (!string.IsNullOrWhiteSpace(extra))
                args.AddRange(SplitArguments(extra));

            args.Add("about:blank");
            return args;
        }

        /// <summary>Splits on whitespace, honoring double quotes (quotes are removed): --a "--b=x y" → [--a, --b=x y].</summary>
        internal static List<string> SplitArguments(string value)
        {
            var result = new List<string>();
            var current = new StringBuilder();
            bool inQuotes = false, has = false;
            foreach (var c in value)
            {
                if (c == '"')
                {
                    inQuotes = !inQuotes;
                    has = true;
                }
                else if (char.IsWhiteSpace(c) && !inQuotes)
                {
                    if (has)
                        result.Add(current.ToString());
                    current.Clear();
                    has = false;
                }
                else
                {
                    current.Append(c);
                    has = true;
                }
            }
            if (has)
                result.Add(current.ToString());
            return result;
        }

        /// <summary>Evaluates JavaScript in the visible page (main world) and returns the value (returnByValue, promises awaited). For diagnostics.</summary>
        public async Task<JsonElement?> EvaluateAsync(string expression, TimeSpan? timeout = null)
        {
            var cdp = _cdp;
            var page = _activePage;
            if (cdp == null || page == null)
                throw new InvalidOperationException("Session is not running.");
            var res = await cdp.SendAsync("Runtime.evaluate", new { expression, awaitPromise = true, returnByValue = true }, page.SessionId, timeout ?? TimeSpan.FromSeconds(20));
            if (res.Obj("exceptionDetails") is JsonElement ex)
                throw new InvalidOperationException("Script threw: " + ex.ToString());
            if (res.Obj("result") is JsonElement r && r.TryGetProperty("value", out var v))
                return v.Clone();
            return null;
        }

        private async Task<string> WaitForDevToolsAsync(string profileDir, Task<string> fromStderr, CancellationToken cancellationToken)
        {
            var portFile = Path.Combine(profileDir, "DevToolsActivePort");
            var deadline = DateTime.UtcNow.AddSeconds(30);
            while (DateTime.UtcNow < deadline)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (fromStderr.IsCompleted)
                    return await fromStderr; //throws if the process exited
                try
                {
                    if (File.Exists(portFile))
                    {
                        string[] lines;
                        using (var fs = new FileStream(portFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                        using (var reader = new StreamReader(fs))
                            lines = reader.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                        if (lines.Length >= 2 && int.TryParse(lines[0], out var port) && port > 0)
                            return $"ws://127.0.0.1:{port}{lines[1]}";
                    }
                }
                catch (IOException)
                {
                    //File still being written
                }
                await Task.WhenAny(fromStderr, Task.Delay(100, cancellationToken));
            }
            throw new TimeoutException("Timed out waiting for the browser DevTools endpoint. " + GetStderrTail());
        }

        private string GetStderrTail()
        {
            lock (_stderrTail)
            {
                var s = _stderrTail.ToString().Trim();
                return s.Length > 1000 ? s.Substring(s.Length - 1000) : s;
            }
        }

        #endregion

        #region CDP events

        private void HandleCdpEvent(CdpEvent ev)
        {
            var p = ev.Params;
            switch (ev.Method)
            {
                case "Network.requestWillBeSent":
                    OnRequestWillBeSent(p);
                    break;
                case "Network.requestWillBeSentExtraInfo":
                    OnRequestWillBeSentExtraInfo(p);
                    break;
                case "Page.screencastFrame":
                    OnScreencastFrame(ev.SessionId, p);
                    break;
                case "Target.attachedToTarget":
                    OnAttachedToTarget(p);
                    break;
                case "Target.detachedFromTarget":
                    OnDetachedFromTarget(p.Str("sessionId"), p.Str("targetId"));
                    break;
                case "Target.targetDestroyed":
                case "Target.targetCrashed":
                    {
                        var targetId = p.Str("targetId");
                        PageTarget? page;
                        lock (_lock)
                            page = _pages.FirstOrDefault(x => x.TargetId == targetId);
                        if (page != null)
                            OnDetachedFromTarget(page.SessionId, targetId);
                    }
                    break;
                case "Page.frameNavigated":
                    {
                        var frame = p.Obj("frame");
                        if (frame == null || frame.Value.Str("parentId") != null)
                            break;
                        var page = FindPage(ev.SessionId);
                        if (page == null)
                            break;
                        page.MainFrameId = frame.Value.Str("id") ?? page.MainFrameId;
                        page.Url = frame.Value.Str("url") ?? page.Url;
                        OnPageUrlChanged(page);
                    }
                    break;
                case "Page.navigatedWithinDocument":
                    {
                        var page = FindPage(ev.SessionId);
                        if (page == null || (page.MainFrameId != null && p.Str("frameId") != page.MainFrameId))
                            break;
                        page.Url = p.Str("url") ?? page.Url;
                        OnPageUrlChanged(page);
                    }
                    break;
                case "Page.loadEventFired":
                    {
                        var page = FindPage(ev.SessionId);
                        if (page != null && page == _activePage && YouTubeAccountPicker.IsSwitcherUrl(page.Url) && (_ytAccounts == null || _ytAccounts.Count == 0))
                            ScheduleYouTubeExtraction(page, initialDelayMs: 500);
                    }
                    break;
                case "Page.javascriptDialogOpening":
                    {
                        //Nobody can answer a dialog in a headless browser, accept it so the page does not hang.
                        var sid = ev.SessionId;
                        Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Auto accepting {p.Str("type")} dialog: {p.Str("message")}");
                        _ = _cdp?.TrySendAsync("Page.handleJavaScriptDialog", new { accept = true, promptText = p.Str("defaultPrompt") ?? "" }, sid);
                    }
                    break;
            }
        }

        private PageTarget? FindPage(string? sessionId)
        {
            if (sessionId == null)
                return null;
            lock (_lock)
                return _pages.FirstOrDefault(x => x.SessionId == sessionId);
        }

        private void OnAttachedToTarget(JsonElement p)
        {
            var sessionId = p.Str("sessionId");
            var info = p.Obj("targetInfo");
            if (sessionId == null || info == null)
                return;
            var type = info.Value.Str("type") ?? "";
            var targetId = info.Value.Str("targetId") ?? "";
            var waiting = p.Bool("waitingForDebugger") ?? false;
            var targetUrl = info.Value.Str("url") ?? "";

            //Browser internal targets (WebUI like chrome://omnibox-popup, component extensions, devtools) are not ours.
            bool isInternal = targetUrl.StartsWith("chrome://", StringComparison.OrdinalIgnoreCase)
                || targetUrl.StartsWith("chrome-extension://", StringComparison.OrdinalIgnoreCase)
                || targetUrl.StartsWith("chrome-untrusted://", StringComparison.OrdinalIgnoreCase)
                || targetUrl.StartsWith("devtools://", StringComparison.OrdinalIgnoreCase)
                || targetUrl.StartsWith("edge://", StringComparison.OrdinalIgnoreCase);
            bool isChildType = type == "iframe" || type == "worker" || type == "service_worker" || type == "shared_worker";
            if (isInternal || (type != "page" && !isChildType))
            {
                Logger.v(nameof(RemoteBrowserSession), $"[{Id}] Ignoring {type} target {targetUrl}.");
                _ = Task.Run(async () =>
                {
                    if (waiting)
                        await (_cdp?.TrySendAsync("Runtime.runIfWaitingForDebugger", null, sessionId, TimeSpan.FromSeconds(5)) ?? Task.FromResult<JsonElement?>(null));
                    await (_cdp?.TrySendAsync("Target.detachFromTarget", new { sessionId }, null, TimeSpan.FromSeconds(5)) ?? Task.FromResult<JsonElement?>(null));
                });
                return;
            }

            if (type == "page")
            {
                PageTarget page;
                bool isMain;
                lock (_lock)
                {
                    if (_pages.Any(x => x.TargetId == targetId))
                    {
                        //Already attached via another session, detach the duplicate.
                        _ = _cdp?.TrySendAsync("Target.detachFromTarget", new { sessionId });
                        return;
                    }
                    page = new PageTarget()
                    {
                        SessionId = sessionId,
                        TargetId = targetId,
                        OpenerId = info.Value.Str("openerId"),
                        Url = info.Value.Str("url") ?? "about:blank"
                    };
                    isMain = _pages.Count == 0;
                    _pages.Add(page);
                }
                Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Attached to {(isMain ? "main" : "popup")} page {targetId} ({page.Url}).");
                _ = SetupPageAsync(page, waiting, isMain);
            }
            else
            {
                lock (_lock)
                    _childSessions[sessionId] = targetId;
                _ = SetupChildAsync(sessionId, type, waiting);
            }
        }

        private void OnDetachedFromTarget(string? sessionId, string? targetId)
        {
            PageTarget? page;
            bool wasActive = false;
            int remaining;
            PageTarget? newActive = null;
            lock (_lock)
            {
                if (sessionId != null)
                    _childSessions.Remove(sessionId);
                page = _pages.FirstOrDefault(x => (sessionId != null && x.SessionId == sessionId) || (targetId != null && x.TargetId == targetId));
                if (page == null)
                    return;
                _pages.Remove(page);
                remaining = _pages.Count;
                if (_activePage == page)
                {
                    wasActive = true;
                    newActive = _pages.FirstOrDefault(x => x.TargetId == page.OpenerId) ?? _pages.LastOrDefault();
                    _activePage = newActive;
                    if (_screencastSessionId == page.SessionId)
                        _screencastSessionId = null;
                }
            }
            Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Page {page.TargetId} detached, {remaining} page(s) remaining.");

            if (remaining == 0)
            {
                if (IsStarted)
                    _ = CloseInternalAsync("all pages closed");
                return;
            }
            if (wasActive && newActive != null)
                ActivatePage(newActive);
        }

        private async Task SetupPageAsync(PageTarget page, bool waiting, bool isMain)
        {
            var cdp = _cdp;
            if (cdp == null)
                return;
            var sid = page.SessionId;
            try
            {
                //A target paused on start (popups) may not answer some commands until it runs, so pipeline the setup:
                //commands are delivered in order, then the target is resumed, then the responses are awaited.
                var setup = new List<Task>()
                {
                    cdp.SendAsync("Page.enable", null, sid),
                    cdp.SendAsync("Network.enable", null, sid)
                };
                if (_uaOverride != null)
                    setup.Add(cdp.SendAsync("Emulation.setUserAgentOverride", _uaOverride, sid));
                setup.AddRange(ApplyViewportCommands(sid));
                setup.Add(cdp.TrySendAsync("Emulation.setFocusEmulationEnabled", new { enabled = true }, sid));
                if (_injectJs != null)
                    setup.Add(cdp.SendAsync("Page.addScriptToEvaluateOnNewDocument", new { source = _injectJs }, sid));
                setup.Add(cdp.TrySendAsync("Target.setAutoAttach", new { autoAttach = true, waitForDebuggerOnStart = true, flatten = true }, sid));
                var treeTask = cdp.TrySendAsync("Page.getFrameTree", null, sid);
                if (waiting)
                {
                    waiting = false;
                    setup.Add(cdp.TrySendAsync("Runtime.runIfWaitingForDebugger", null, sid));
                }
                await Task.WhenAll(setup);

                var tree = await treeTask;
                var frame = tree?.Obj("frameTree")?.Obj("frame");
                if (frame != null)
                {
                    page.MainFrameId ??= frame.Value.Str("id");
                    var url = frame.Value.Str("url");
                    if (!string.IsNullOrEmpty(url) && (string.IsNullOrEmpty(page.Url) || page.Url == "about:blank"))
                        page.Url = url;
                }
            }
            catch (Exception ex)
            {
                Logger.e(nameof(RemoteBrowserSession), $"[{Id}] Failed to set up page {page.TargetId}: {ex.Message}", ex);
            }
            finally
            {
                if (waiting)
                    await cdp.TrySendAsync("Runtime.runIfWaitingForDebugger", null, sid);
                page.Ready.TrySetResult();
            }

            if (isMain)
            {
                lock (_lock)
                    _activePage ??= page;
                _mainPageReady.TrySetResult(page);
                await EnsureScreencastAsync(false);
            }
            else
            {
                //Popups (window.open / target=_blank) become the visible page until they close.
                bool stillOpen;
                lock (_lock)
                    stillOpen = _pages.Contains(page);
                if (stillOpen)
                    ActivatePage(page);
            }
        }

        private async Task SetupChildAsync(string sessionId, string type, bool waiting)
        {
            var cdp = _cdp;
            if (cdp == null)
                return;
            var setup = new List<Task>()
            {
                cdp.TrySendAsync("Network.enable", null, sessionId, TimeSpan.FromSeconds(10))
            };
            if (_uaOverride != null)
                setup.Add(cdp.TrySendAsync("Network.setUserAgentOverride", _uaOverride, sessionId, TimeSpan.FromSeconds(10)));
            if (type == "iframe")
                setup.Add(cdp.TrySendAsync("Target.setAutoAttach", new { autoAttach = true, waitForDebuggerOnStart = true, flatten = true }, sessionId, TimeSpan.FromSeconds(10)));
            if (waiting)
                setup.Add(cdp.TrySendAsync("Runtime.runIfWaitingForDebugger", null, sessionId, TimeSpan.FromSeconds(10)));
            await Task.WhenAll(setup);
        }

        private void ActivatePage(PageTarget page)
        {
            lock (_lock)
            {
                if (!_pages.Contains(page))
                    return;
                _activePage = page;
            }
            _ = _cdp?.TrySendAsync("Target.activateTarget", new { targetId = page.TargetId });
            _ = EnsureScreencastAsync(false);
            OnPageUrlChanged(page);
        }

        #endregion

        #region Request capture

        private static Dictionary<string, List<string>> ToHeaders(JsonElement? headers)
        {
            var dict = new Dictionary<string, List<string>>(StringComparer.InvariantCultureIgnoreCase);
            if (headers == null || headers.Value.ValueKind != JsonValueKind.Object)
                return dict;
            foreach (var prop in headers.Value.EnumerateObject())
            {
                if (prop.Name.StartsWith(':'))
                    continue; //HTTP/2 pseudo headers
                var value = prop.Value.ValueKind == JsonValueKind.String ? prop.Value.GetString() ?? "" : prop.Value.ToString();
                dict[prop.Name] = value.Split('\n').ToList();
            }
            return dict;
        }

        private void OnRequestWillBeSent(JsonElement p)
        {
            var requestId = p.Str("requestId");
            var request = p.Obj("request");
            if (requestId == null || request == null)
                return;
            var url = request.Value.Str("url");
            if (string.IsNullOrEmpty(url) || !(url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                || url.StartsWith("wss://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("ws://", StringComparison.OrdinalIgnoreCase)))
                return; //data:, blob:, chrome:// etc. carry no useful headers
            var pending = new PendingRequest()
            {
                Url = url,
                Method = request.Value.Str("method") ?? "GET",
                Headers = ToHeaders(request.Value.Obj("headers"))
            };

            PendingExtraInfo? extra = null;
            lock (_netLock)
            {
                if (_pendingExtraInfo.TryGetValue(requestId, out var queue) && queue.Count > 0)
                {
                    extra = queue.Dequeue();
                    if (queue.Count == 0)
                        _pendingExtraInfo.Remove(requestId);
                }
                else
                {
                    if (!_pendingRequests.TryGetValue(requestId, out var rq))
                        _pendingRequests[requestId] = rq = new Queue<PendingRequest>();
                    rq.Enqueue(pending);
                }
            }
            if (extra != null)
                Emit(pending, extra);
        }

        private void OnRequestWillBeSentExtraInfo(JsonElement p)
        {
            var requestId = p.Str("requestId");
            if (requestId == null)
                return;
            var extra = new PendingExtraInfo() { Headers = ToHeaders(p.Obj("headers")) };

            PendingRequest? request = null;
            lock (_netLock)
            {
                if (_pendingRequests.TryGetValue(requestId, out var queue) && queue.Count > 0)
                {
                    request = queue.Dequeue();
                    if (queue.Count == 0)
                        _pendingRequests.Remove(requestId);
                }
                else if (_recentUnpaired.Remove(requestId, out var late))
                {
                    //Already reported without extra info (it arrived late), report again with the real headers.
                    request = late;
                }
                else
                {
                    if (!_pendingExtraInfo.TryGetValue(requestId, out var eq))
                        _pendingExtraInfo[requestId] = eq = new Queue<PendingExtraInfo>();
                    eq.Enqueue(extra);
                }
            }
            if (request != null)
                Emit(request, extra);
        }

        private void SweepPendingRequests()
        {
            var toEmit = new List<PendingRequest>();
            var now = Environment.TickCount64;
            lock (_netLock)
            {
                foreach (var kv in _pendingRequests.ToList())
                {
                    while (kv.Value.Count > 0 && now - kv.Value.Peek().Ticks > UnpairedRequestDelay.TotalMilliseconds)
                    {
                        var r = kv.Value.Dequeue();
                        toEmit.Add(r);
                        _recentUnpaired[kv.Key] = r;
                    }
                    if (kv.Value.Count == 0)
                        _pendingRequests.Remove(kv.Key);
                }
                foreach (var kv in _pendingExtraInfo.ToList())
                {
                    while (kv.Value.Count > 0 && now - kv.Value.Peek().Ticks > 15000)
                        kv.Value.Dequeue();
                    if (kv.Value.Count == 0)
                        _pendingExtraInfo.Remove(kv.Key);
                }
                foreach (var kv in _recentUnpaired.ToList())
                {
                    if (now - kv.Value.Ticks > 30000)
                        _recentUnpaired.Remove(kv.Key);
                }
            }
            foreach (var r in toEmit)
                Emit(r, null);
        }

        private void FlushPendingRequests()
        {
            var toEmit = new List<PendingRequest>();
            lock (_netLock)
            {
                foreach (var q in _pendingRequests.Values)
                    toEmit.AddRange(q);
                _pendingRequests.Clear();
                _pendingExtraInfo.Clear();
                _recentUnpaired.Clear();
            }
            foreach (var r in toEmit)
                Emit(r, null);
        }

        private void Emit(PendingRequest request, PendingExtraInfo? extra)
        {
            var headers = new Dictionary<string, List<string>>(request.Headers, StringComparer.InvariantCultureIgnoreCase);
            if (extra != null)
            {
                foreach (var kv in extra.Headers)
                    headers[kv.Key] = kv.Value;
            }
            var interceptorRequest = new InterceptorRequest()
            {
                Url = request.Url,
                Method = request.Method,
                Headers = headers
            };
            try
            {
                lock (_handlerLock)
                    _handler(interceptorRequest);
            }
            catch (Exception ex)
            {
                if (Interlocked.Increment(ref _handlerErrors) <= 3)
                    Logger.w(nameof(RemoteBrowserSession), $"[{Id}] Request handler threw for {request.Url}: {ex.Message}");
                else
                    Logger.v(nameof(RemoteBrowserSession), $"[{Id}] Request handler threw for {request.Url}: {ex.Message}");
            }
        }

        #endregion

        #region Focused field

        // Read-only look at document.activeElement (through same-origin iframes and shadow roots). Runs via
        // Runtime.evaluate without enabling the Runtime domain or adding globals, so the page can't tell.
        private const string FocusProbeJs = @"(() => {
  let el = document.activeElement;
  for (let i = 0; i < 8 && el; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === 'IFRAME') { try { const d = el.contentDocument; if (d && d.activeElement) { el = d.activeElement; continue; } } catch (e) {} }
    break;
  }
  if (!el) return 'none';
  const tag = el.tagName;
  const editable = el.isContentEditable || tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(button|submit|checkbox|radio|range|file|hidden|image|reset|color)$/i.test(el.type));
  if (!editable) return 'none';
  const type = (el.type || '').toLowerCase(), ac = (el.autocomplete || el.getAttribute('autocomplete') || '').toLowerCase();
  const mode = (el.inputMode || el.getAttribute('inputmode') || '').toLowerCase(), key = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
  if (type === 'password' || /password/.test(ac)) return ac.includes('new-password') ? 'new-password' : 'password';
  if (/one-time-code/.test(ac) || /totp|otp|pin|code/.test(key)) return 'code';
  if (mode === 'numeric' || mode === 'decimal' || type === 'number') return 'code';
  if (type === 'email' || /username|email/.test(ac) || /identifier|email|user|login/.test(key)) return 'username';
  if (type === 'tel') return 'tel';
  return 'text';
})()";

        private void ScheduleFocusCheck()
        {
            _ = Task.Run(async () =>
            {
                await Task.Delay(250);
                await CheckFocusedFieldAsync();
            });
        }

        private async Task CheckFocusedFieldAsync()
        {
            if (_closing || ViewerCount == 0 || Interlocked.Exchange(ref _focusCheckRunning, 1) == 1)
                return;
            try
            {
                var cdp = _cdp;
                var sid = _activePage?.SessionId;
                if (cdp == null || sid == null)
                    return;
                var res = await cdp.TrySendAsync("Runtime.evaluate", new { expression = FocusProbeJs, returnByValue = true, silent = true }, sid, TimeSpan.FromSeconds(3));
                var kind = res?.Obj("result")?.Str("value");
                if (kind == null || kind == _lastFieldKind)
                    return;
                _lastFieldKind = kind;
                var msg = JsonSerializer.Serialize(new { type = "field", kind }, _jsonOptions);
                _lastFieldMessage = msg;
                Broadcast(msg);
            }
            catch
            {
            }
            finally
            {
                Interlocked.Exchange(ref _focusCheckRunning, 0);
            }
        }

        #endregion

        #region Screencast

        private (int maxWidth, int maxHeight) GetScreencastSize()
        {
            var scale = Math.Max(1, Math.Min(Dpr, MaxScreencastScale));
            return (Math.Min(MaxScreencastDimension, (int)Math.Round(Width * scale)), Math.Min(MaxScreencastDimension, (int)Math.Round(Height * scale)));
        }

        private async Task EnsureScreencastAsync(bool restart)
        {
            var cdp = _cdp;
            if (cdp == null)
                return;
            await _screencastLock.WaitAsync();
            try
            {
                string? desired;
                lock (_lock)
                    desired = (!_closing && _viewers.Count > 0) ? _activePage?.SessionId : null;

                if (_screencastSessionId != null && (restart || _screencastSessionId != desired))
                {
                    await cdp.TrySendAsync("Page.stopScreencast", null, _screencastSessionId, TimeSpan.FromSeconds(5));
                    _screencastSessionId = null;
                }
                if (desired != null && _screencastSessionId == null)
                {
                    var (maxWidth, maxHeight) = GetScreencastSize();
                    var res = await cdp.TrySendAsync("Page.startScreencast", new { format = "jpeg", quality = 70, maxWidth, maxHeight, everyNthFrame = 1 }, desired, TimeSpan.FromSeconds(10));
                    if (res != null)
                        _screencastSessionId = desired;
                }
            }
            finally
            {
                _screencastLock.Release();
            }
        }

        private void OnScreencastFrame(string? sessionId, JsonElement p)
        {
            var ackId = (int)(p.Num("sessionId") ?? 0);
            _ = AckFrameAsync(sessionId, ackId);

            if (sessionId == null || sessionId != _activePage?.SessionId)
                return;
            var data = p.Str("data");
            if (data == null)
                return;
            var metadata = p.Obj("metadata");
            var width = metadata?.Num("deviceWidth") ?? Width;
            var height = metadata?.Num("deviceHeight") ?? Height;
            var msg = "{\"type\":\"frame\",\"data\":\"" + data + "\",\"width\":" + Math.Round(width).ToString(CultureInfo.InvariantCulture)
                + ",\"height\":" + Math.Round(height).ToString(CultureInfo.InvariantCulture) + "}";
            _lastFrameMessage = msg;
            foreach (var viewer in GetViewers())
                viewer.SetFrame(msg);
        }

        private async Task AckFrameAsync(string? sessionId, int ackId)
        {
            try
            {
                var now = Environment.TickCount64;
                var wait = FrameIntervalMs - (now - Interlocked.Read(ref _lastAckTicks));
                if (wait > 0)
                    await Task.Delay((int)wait);
                Interlocked.Exchange(ref _lastAckTicks, Environment.TickCount64);
                if (_cdp != null && !_closing)
                    await _cdp.TrySendAsync("Page.screencastFrameAck", new { sessionId = ackId }, sessionId, TimeSpan.FromSeconds(5));
            }
            catch
            {
            }
        }

        #endregion

        #region Navigation state / YouTube

        private void OnPageUrlChanged(PageTarget page)
        {
            if (page != _activePage || string.IsNullOrEmpty(page.Url))
                return;
            Url = page.Url;
            _ = SendUrlUpdateAsync(page);

            if (YouTubeAccountPicker.IsSwitcherUrl(page.Url))
                ScheduleYouTubeExtraction(page, initialDelayMs: 1200);
            else if (_ytAccounts != null || _lastYtMessage != null)
            {
                _ytCts?.Cancel();
                _ytAccounts = null;
                _lastYtMessage = null;
            }
        }

        private async Task SendUrlUpdateAsync(PageTarget page)
        {
            bool canGoBack = false;
            try
            {
                var history = await (_cdp?.TrySendAsync("Page.getNavigationHistory", null, page.SessionId, TimeSpan.FromSeconds(5)) ?? Task.FromResult<JsonElement?>(null));
                if (history == null && !_closing)
                {
                    //Fails transiently while a cross-process navigation commits.
                    await Task.Delay(300);
                    history = await (_cdp?.TrySendAsync("Page.getNavigationHistory", null, page.SessionId, TimeSpan.FromSeconds(5)) ?? Task.FromResult<JsonElement?>(null));
                }
                if (history != null)
                    canGoBack = GetHistoryTarget(history.Value, -1) != null;
            }
            catch { }
            var msg = JsonSerializer.Serialize(new { type = "url", url = page.Url, canGoBack }, _jsonOptions);
            _lastUrlMessage = msg;
            Broadcast(msg);
        }

        /// <summary>History entry id at currentIndex+offset, never the initial about:blank entry.</summary>
        private static int? GetHistoryTarget(JsonElement history, int offset)
        {
            var index = (int)(history.Num("currentIndex") ?? 0) + offset;
            var entries = history.Obj("entries");
            if (entries == null || entries.Value.ValueKind != JsonValueKind.Array || index < 0 || index >= entries.Value.GetArrayLength())
                return null;
            var entry = entries.Value[index];
            if ((entry.Str("url") ?? "").StartsWith("about:", StringComparison.OrdinalIgnoreCase))
                return null;
            return (int?)entry.Num("id");
        }

        private void ScheduleYouTubeExtraction(PageTarget page, int initialDelayMs)
        {
            _ytCts?.Cancel();
            var cts = new CancellationTokenSource();
            _ytCts = cts;
            var ct = cts.Token;
            _ = Task.Run(async () =>
            {
                // [GrayjayWeb] YouTube redirects and re-renders this page a few times; an attempt that races a navigation
                // ("Inspected target navigated or closed") must not abandon the remaining attempts.
                var delays = new[] { initialDelayMs, 1500, 2000, 3000, 4000, 6000 };
                List<YouTubeAccountPicker.Account> accounts = new List<YouTubeAccountPicker.Account>();
                foreach (var delay in delays)
                {
                    try
                    {
                        await Task.Delay(delay, ct);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                    if (!YouTubeAccountPicker.IsSwitcherUrl(page.Url) || page != _activePage || _cdp == null)
                        return;
                    try
                    {
                        accounts = await ExtractYouTubeAccountsAsync(page);
                        if (accounts.Count > 0)
                            break;
                    }
                    catch (Exception ex)
                    {
                        Logger.w(nameof(RemoteBrowserSession), $"[{Id}] YouTube account extraction attempt failed (will retry): {ex.Message}");
                    }
                }
                if (ct.IsCancellationRequested)
                    return;
                _ytAccounts = accounts;
                var msg = JsonSerializer.Serialize(new
                {
                    type = "ytAccounts",
                    accounts = accounts.Select(a => new { index = a.Index, name = a.Name, handle = a.Handle, subtitle = a.Subtitle, thumbnail = a.Thumbnail, selected = a.Selected }).ToList()
                }, _jsonOptions);
                _lastYtMessage = msg;
                Logger.i(nameof(RemoteBrowserSession), $"[{Id}] YouTube channel switcher: {accounts.Count} account(s) found{(accounts.Count > 0 ? " via " + accounts[0].Source : "")}.");
                Broadcast(msg);
            });
        }

        private async Task<List<YouTubeAccountPicker.Account>> ExtractYouTubeAccountsAsync(PageTarget page)
        {
            var cdp = _cdp;
            if (cdp == null)
                return new List<YouTubeAccountPicker.Account>();
            var res = await cdp.SendAsync("Runtime.evaluate", new
            {
                expression = YouTubeAccountPicker.ExtractScript,
                awaitPromise = true,
                returnByValue = true
            }, page.SessionId, TimeSpan.FromSeconds(20));
            if (res.Obj("exceptionDetails") is JsonElement exception)
            {
                Logger.w(nameof(RemoteBrowserSession), $"[{Id}] YouTube extraction script threw: {exception}");
                return new List<YouTubeAccountPicker.Account>();
            }
            var value = res.Obj("result")?.Obj("value");
            if (value?.Obj("errors") is JsonElement errors && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0)
                Logger.v(nameof(RemoteBrowserSession), $"[{Id}] YouTube extraction notes: {errors}");
            return YouTubeAccountPicker.Parse(value);
        }

        private async Task SelectYouTubeAccountAsync(int index)
        {
            var page = _activePage;
            var cdp = _cdp;
            var account = _ytAccounts?.FirstOrDefault(x => x.Index == index);
            if (page == null || cdp == null || account == null)
            {
                Logger.w(nameof(RemoteBrowserSession), $"[{Id}] ytSelectAccount: no account with index {index}.");
                return;
            }
            Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Selecting YouTube account #{index} ({account.Source}).");

            if (!string.IsNullOrEmpty(account.Url))
            {
                try
                {
                    var target = new Uri(new Uri(page.Url), account.Url);
                    if (target.Scheme == Uri.UriSchemeHttps || target.Scheme == Uri.UriSchemeHttp)
                    {
                        await cdp.SendAsync("Page.navigate", new { url = target.ToString() }, page.SessionId);
                        return;
                    }
                }
                catch (Exception ex)
                {
                    Logger.w(nameof(RemoteBrowserSession), $"[{Id}] Navigating to account switch URL failed, falling back to click: {ex.Message}");
                }
            }

            var res = await cdp.SendAsync("Runtime.evaluate", new
            {
                expression = YouTubeAccountPicker.BuildClickScript(account),
                awaitPromise = true,
                returnByValue = true,
                userGesture = true
            }, page.SessionId, TimeSpan.FromSeconds(10));
            if (res.Obj("result")?.Bool("value") != true)
                Logger.w(nameof(RemoteBrowserSession), $"[{Id}] Could not find a DOM element for YouTube account #{index}.");
        }

        #endregion

        #region Viewers

        private List<RemoteBrowserViewer> GetViewers()
        {
            lock (_lock)
                return _viewers.ToList();
        }

        private void Broadcast(string message)
        {
            foreach (var viewer in GetViewers())
                viewer.Enqueue(message);
        }

        /// <summary>
        /// Runs a viewer connection until the socket closes or the session ends. Protocol: see <see cref="RemoteBrowserEndpoints"/>.
        /// </summary>
        public async Task HandleViewerAsync(WebSocket socket, CancellationToken cancellationToken)
        {
            var viewer = new RemoteBrowserViewer(socket);
            if (_closing)
            {
                viewer.Enqueue("{\"type\":\"closed\"}");
                viewer.RequestClose();
                await viewer.SendLoopAsync(cancellationToken);
                return;
            }

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            lock (_lock)
                _viewers.Add(viewer);
            LastActivityUtc = DateTime.UtcNow;
            Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Viewer {viewer.Id} connected ({ViewerCount} total).");

            viewer.Enqueue(JsonSerializer.Serialize(new { type = "info", id = Id, title = Title, url = Url, width = Width, height = Height, dpr = Dpr, mobile = Mobile }, _jsonOptions));
            if (_lastUrlMessage != null)
                viewer.Enqueue(_lastUrlMessage);
            if (_lastYtMessage != null)
                viewer.Enqueue(_lastYtMessage);
            if (_lastFieldMessage != null)
                viewer.Enqueue(_lastFieldMessage);
            if (_lastFrameMessage != null)
                viewer.SetFrame(_lastFrameMessage);

            var sendTask = viewer.SendLoopAsync(cts.Token);
            _ = EnsureScreencastAsync(false);

            try
            {
                var buffer = new byte[16 * 1024];
                using var ms = new MemoryStream();
                while (socket.State == WebSocketState.Open && !cts.IsCancellationRequested)
                {
                    ms.SetLength(0);
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cts.Token);
                        if (result.MessageType == WebSocketMessageType.Close)
                            break;
                        ms.Write(buffer, 0, result.Count);
                        if (ms.Length > 1024 * 1024)
                            throw new InvalidOperationException("Viewer message too large.");
                    } while (!result.EndOfMessage);

                    if (result.MessageType == WebSocketMessageType.Close)
                        break;
                    if (result.MessageType != WebSocketMessageType.Text)
                        continue;
                    var text = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
                    try
                    {
                        await HandleViewerMessageAsync(text);
                    }
                    catch (Exception ex)
                    {
                        Logger.w(nameof(RemoteBrowserSession), $"[{Id}] Failed to handle viewer message: {ex.Message}");
                    }
                }
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                Logger.v(nameof(RemoteBrowserSession), $"[{Id}] Viewer {viewer.Id} receive ended: {ex.Message}");
            }
            finally
            {
                lock (_lock)
                    _viewers.Remove(viewer);
                if (!_closing)
                {
                    cts.Cancel();
                    try
                    {
                        if (socket.State == WebSocketState.Open || socket.State == WebSocketState.CloseReceived)
                        {
                            using var closeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Bye", closeTimeout.Token);
                        }
                    }
                    catch { }
                }
                try
                {
                    await sendTask.WaitAsync(TimeSpan.FromSeconds(5));
                }
                catch { }
                Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Viewer {viewer.Id} disconnected ({ViewerCount} remaining).");
                _ = EnsureScreencastAsync(false);
            }
        }

        private async Task HandleViewerMessageAsync(string json)
        {
            using var doc = JsonDocument.Parse(json);
            var m = doc.RootElement;
            var type = m.Str("type");
            if (type == null)
                return;
            var cdp = _cdp;
            if (cdp == null || _closing)
                return;
            if (type != "ping")
                LastActivityUtc = DateTime.UtcNow;

            switch (type)
            {
                case "close":
                    Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Closed by user.");
                    _ = CloseInternalAsync("cancelled by user");
                    return;
                case "ytSelectAccount":
                    await SelectYouTubeAccountAsync((int)(m.Num("index") ?? -1));
                    return;
                case "ytRefresh":
                    {
                        var page = _activePage;
                        if (page != null && YouTubeAccountPicker.IsSwitcherUrl(page.Url))
                            ScheduleYouTubeExtraction(page, 0);
                    }
                    return;
                case "resize":
                    await ResizeAsync(m.Num("width"), m.Num("height"), m.Num("dpr"));
                    return;
            }

            await _inputLock.WaitAsync();
            try
            {
                var page = _activePage;
                if (page == null)
                    return;
                var sid = page.SessionId;
                switch (type)
                {
                    case "pointer":
                        await HandlePointerAsync(cdp, sid, m);
                        break;
                    case "wheel":
                        await cdp.SendAsync("Input.dispatchMouseEvent", new
                        {
                            type = "mouseWheel",
                            x = m.Num("x") ?? 0,
                            y = m.Num("y") ?? 0,
                            deltaX = m.Num("deltaX") ?? 0,
                            deltaY = m.Num("deltaY") ?? 0,
                            modifiers = (int)(m.Num("modifiers") ?? 0),
                            pointerType = "mouse"
                        }, sid, TimeSpan.FromSeconds(10));
                        break;
                    case "key":
                        await HandleKeyAsync(cdp, sid, m);
                        break;
                    case "text":
                        {
                            var text = m.Str("text");
                            if (!string.IsNullOrEmpty(text))
                                await cdp.SendAsync("Input.insertText", new { text }, sid, TimeSpan.FromSeconds(10));
                        }
                        break;
                    case "back":
                    case "forward":
                        {
                            var history = await cdp.SendAsync("Page.getNavigationHistory", null, sid);
                            var entryId = GetHistoryTarget(history, type == "back" ? -1 : 1);
                            if (entryId != null)
                                await cdp.SendAsync("Page.navigateToHistoryEntry", new { entryId = entryId.Value }, sid);
                        }
                        break;
                    case "reload":
                        await cdp.SendAsync("Page.reload", new { ignoreCache = false }, sid);
                        break;
                    case "ping":
                        break;
                    default:
                        Logger.v(nameof(RemoteBrowserSession), $"[{Id}] Unknown viewer message type '{type}'.");
                        break;
                }
            }
            finally
            {
                _inputLock.Release();
            }
        }

        private async Task HandlePointerAsync(CdpConnection cdp, string sid, JsonElement m)
        {
            var action = m.Str("action") ?? "move";
            var x = m.Num("x") ?? 0;
            var y = m.Num("y") ?? 0;
            var pointerType = m.Str("pointerType") ?? "mouse";
            var modifiers = (int)(m.Num("modifiers") ?? 0);

            if (pointerType == "touch")
            {
                var id = (int)(m.Num("id") ?? 0);
                string eventType;
                switch (action)
                {
                    case "down":
                        _touches[id] = (x, y);
                        eventType = "touchStart";
                        break;
                    case "move":
                        if (!_touches.ContainsKey(id))
                            return;
                        _touches[id] = (x, y);
                        eventType = "touchMove";
                        break;
                    case "up":
                    case "cancel":
                        if (!_touches.Remove(id))
                            return;
                        ScheduleFocusCheck();
                        //Lifting one finger of several: report the remaining ones, Chrome releases the missing point.
                        eventType = _touches.Count == 0 ? (action == "cancel" ? "touchCancel" : "touchEnd") : "touchMove";
                        break;
                    default:
                        return;
                }
                var points = (eventType == "touchEnd" || eventType == "touchCancel")
                    ? new List<object>()
                    : _touches.Select(t => (object)new { x = t.Value.X, y = t.Value.Y, id = t.Key, radiusX = 4, radiusY = 4, force = 1 }).ToList();
                await cdp.SendAsync("Input.dispatchTouchEvent", new { type = eventType, touchPoints = points, modifiers }, sid, TimeSpan.FromSeconds(10));
                return;
            }

            var button = m.Str("button") ?? "left";
            if (button != "left" && button != "right" && button != "middle")
                button = "left";
            var bit = button == "left" ? 1 : button == "right" ? 2 : 4;
            switch (action)
            {
                case "down":
                    {
                        var now = DateTime.UtcNow;
                        if ((now - _lastMouseDown).TotalMilliseconds < 450 && Math.Abs(x - _lastMouseDownX) < 6 && Math.Abs(y - _lastMouseDownY) < 6)
                            _clickCount = Math.Min(_clickCount + 1, 3);
                        else
                            _clickCount = 1;
                        _lastMouseDown = now;
                        _lastMouseDownX = x;
                        _lastMouseDownY = y;
                        _mouseButtons |= bit;
                        await cdp.SendAsync("Input.dispatchMouseEvent", new { type = "mousePressed", x, y, button, buttons = _mouseButtons, clickCount = _clickCount, modifiers, pointerType = "mouse" }, sid, TimeSpan.FromSeconds(10));
                    }
                    break;
                case "up":
                case "cancel":
                    _mouseButtons &= ~bit;
                    await cdp.SendAsync("Input.dispatchMouseEvent", new { type = "mouseReleased", x, y, button, buttons = _mouseButtons, clickCount = Math.Max(1, _clickCount), modifiers, pointerType = "mouse" }, sid, TimeSpan.FromSeconds(10));
                    break;
                default:
                    {
                        var pressed = (_mouseButtons & 1) != 0 ? "left" : (_mouseButtons & 2) != 0 ? "right" : (_mouseButtons & 4) != 0 ? "middle" : "none";
                        await cdp.SendAsync("Input.dispatchMouseEvent", new { type = "mouseMoved", x, y, button = pressed, buttons = _mouseButtons, modifiers, pointerType = "mouse" }, sid, TimeSpan.FromSeconds(10));
                    }
                    break;
            }
        }

        private static readonly Dictionary<string, int> _keyCodes = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
        {
            ["Backspace"] = 8, ["Tab"] = 9, ["Enter"] = 13, ["Shift"] = 16, ["Control"] = 17, ["Alt"] = 18, ["Pause"] = 19,
            ["CapsLock"] = 20, ["Escape"] = 27, ["Esc"] = 27, [" "] = 32, ["Spacebar"] = 32, ["PageUp"] = 33, ["PageDown"] = 34, ["End"] = 35, ["Home"] = 36,
            ["ArrowLeft"] = 37, ["ArrowUp"] = 38, ["ArrowRight"] = 39, ["ArrowDown"] = 40, ["Left"] = 37, ["Up"] = 38, ["Right"] = 39, ["Down"] = 40,
            ["Insert"] = 45, ["Delete"] = 46, ["Meta"] = 91, ["F5"] = 116,
            [";"] = 186, ["="] = 187, [","] = 188, ["-"] = 189, ["."] = 190, ["/"] = 191, ["`"] = 192, ["["] = 219, ["\\"] = 220, ["]"] = 221, ["'"] = 222
        };
        private static readonly Dictionary<string, string> _keyCodeNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Backspace"] = "Backspace", ["Tab"] = "Tab", ["Enter"] = "Enter", ["Escape"] = "Escape", ["Esc"] = "Escape", [" "] = "Space",
            ["ArrowLeft"] = "ArrowLeft", ["ArrowUp"] = "ArrowUp", ["ArrowRight"] = "ArrowRight", ["ArrowDown"] = "ArrowDown",
            ["Delete"] = "Delete", ["Home"] = "Home", ["End"] = "End", ["PageUp"] = "PageUp", ["PageDown"] = "PageDown"
        };

        private static int KeyCodeFor(string key)
        {
            if (_keyCodes.TryGetValue(key, out var code))
                return code;
            if (key.Length == 1)
            {
                var c = key[0];
                if (char.IsLetter(c) && c < 128)
                    return char.ToUpperInvariant(c);
                if (char.IsDigit(c))
                    return c;
            }
            return 0;
        }

        private async Task HandleKeyAsync(CdpConnection cdp, string sid, JsonElement m)
        {
            var action = m.Str("action") ?? "press";
            var key = m.Str("key") ?? "";
            if (key.Length == 0)
                return;
            var code = m.Str("code");
            if (string.IsNullOrEmpty(code))
                code = _keyCodeNames.TryGetValue(key, out var n) ? n : (key.Length == 1 && char.IsLetter(key[0]) ? "Key" + char.ToUpperInvariant(key[0]) : (key.Length == 1 && char.IsDigit(key[0]) ? "Digit" + key : key));
            var keyCode = (int)(m.Num("keyCode") ?? 0);
            if (keyCode <= 0)
                keyCode = KeyCodeFor(key);
            var modifiers = (int)(m.Num("modifiers") ?? 0); //CDP bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8

            string? text = null;
            if (key == "Enter")
                text = "\r";
            else if ((key.Length == 1 || (key.Length == 2 && char.IsSurrogatePair(key[0], key[1]))) && (modifiers & (1 | 2 | 4)) == 0)
                text = key;

            if (action == "down" || action == "press")
            {
                await cdp.SendAsync("Input.dispatchKeyEvent", new
                {
                    type = text != null ? "keyDown" : "rawKeyDown",
                    key,
                    code,
                    windowsVirtualKeyCode = keyCode,
                    nativeVirtualKeyCode = keyCode,
                    modifiers,
                    text,
                    unmodifiedText = text,
                    autoRepeat = m.Bool("repeat") ?? false
                }, sid, TimeSpan.FromSeconds(10));
            }
            if (action == "up" || action == "press")
            {
                await cdp.SendAsync("Input.dispatchKeyEvent", new
                {
                    type = "keyUp",
                    key,
                    code,
                    windowsVirtualKeyCode = keyCode,
                    nativeVirtualKeyCode = keyCode,
                    modifiers
                }, sid, TimeSpan.FromSeconds(10));
            }
        }

        #endregion

        #region Viewport

        private Task ApplyViewportAsync(string sessionId) => Task.WhenAll(ApplyViewportCommands(sessionId));

        private List<Task> ApplyViewportCommands(string sessionId)
        {
            var tasks = new List<Task>();
            var cdp = _cdp;
            if (cdp == null)
                return tasks;
            tasks.Add(cdp.SendAsync("Emulation.setDeviceMetricsOverride", new
            {
                width = Width,
                height = Height,
                deviceScaleFactor = Dpr,
                mobile = Mobile,
                screenWidth = Width,
                screenHeight = Height,
                screenOrientation = Mobile ? new { type = Width > Height ? "landscapePrimary" : "portraitPrimary", angle = Width > Height ? 90 : 0 } : null
            }, sessionId));
            if (Mobile)
                tasks.Add(cdp.TrySendAsync("Emulation.setTouchEmulationEnabled", new { enabled = true, maxTouchPoints = 5 }, sessionId));
            return tasks;
        }

        /// <summary>Changes the emulated viewport (CSS px) and device pixel ratio of all pages in the session.</summary>
        public async Task ResizeAsync(double? width, double? height, double? dpr)
        {
            var w = (int)Math.Round(Math.Clamp(width ?? Width, 240, 2560));
            var h = (int)Math.Round(Math.Clamp(height ?? Height, 240, 2560));
            var d = Math.Round(Math.Clamp(dpr ?? Dpr, 1, 4), 2);
            if (w == Width && h == Height && Math.Abs(d - Dpr) < 0.01)
                return;
            Width = w;
            Height = h;
            Dpr = d;
            Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Viewport resized to {w}x{h}@{d}.");

            List<PageTarget> pages;
            lock (_lock)
                pages = _pages.ToList();
            foreach (var page in pages)
            {
                try
                {
                    await ApplyViewportAsync(page.SessionId);
                }
                catch (Exception ex)
                {
                    Logger.w(nameof(RemoteBrowserSession), $"[{Id}] Failed to resize page {page.TargetId}: {ex.Message}");
                }
            }
            Broadcast(JsonSerializer.Serialize(new { type = "viewport", width = Width, height = Height, dpr = Dpr, mobile = Mobile }, _jsonOptions));
            await EnsureScreencastAsync(true);
        }

        #endregion

        #region Closing

        public Task CloseAsync(CancellationToken cancellationToken = default) => CloseInternalAsync("closed by caller");

        internal Task CloseInternalAsync(string reason)
        {
            lock (_closeLock)
            {
                if (_closeTask == null)
                {
                    _closing = true;
                    _closeTask = Task.Run(() => CloseCoreAsync(reason));
                }
                return _closeTask;
            }
        }

        private async Task CloseCoreAsync(string reason)
        {
            Logger.i(nameof(RemoteBrowserSession), $"[{Id}] Closing remote browser session ({reason}).");
            try { _ytCts?.Cancel(); } catch { }
            try { _sweepTimer?.Dispose(); } catch { }
            try { _focusTimer?.Dispose(); } catch { }

            //Report requests that were still waiting for their extra info, so the consumer sees everything before OnClosed.
            try { FlushPendingRequests(); } catch { }

            foreach (var viewer in GetViewers())
            {
                viewer.Enqueue("{\"type\":\"closed\"}");
                viewer.RequestClose();
            }

            var cdp = _cdp;
            if (cdp != null && cdp.IsConnected)
                await cdp.TrySendAsync("Browser.close", null, null, TimeSpan.FromSeconds(3));
            try { cdp?.Dispose(); } catch { }

            KillProcess();

            lock (_eventLock)
                _closedFired = true;
            Action? handlers;
            lock (_eventLock)
            {
                handlers = _onClosed;
                _onClosed = null;
            }
            if (handlers != null)
            {
                foreach (var d in handlers.GetInvocationList())
                    SafeInvoke((Action)d);
            }

            RemoteBrowserManager.Unregister(this);
            await DeleteProfileDirAsync();
        }

        /// <summary>Synchronous best effort cleanup, used on server shutdown.</summary>
        internal void KillNow()
        {
            _closing = true;
            try { _cdp?.Dispose(); } catch { }
            try
            {
                if (_process != null && !_process.HasExited)
                {
                    _process.Kill(entireProcessTree: true);
                    _process.WaitForExit(3000);
                }
            }
            catch { }
            for (int i = 0; i < 6 && _profileDir != null; i++)
            {
                try
                {
                    if (Directory.Exists(_profileDir))
                        Directory.Delete(_profileDir, true);
                    break;
                }
                catch
                {
                    //File handles are released shortly after the process exits.
                    Thread.Sleep(250);
                }
            }
        }

        private void KillProcess()
        {
            var process = _process;
            if (process == null)
                return;
            try
            {
                if (!process.HasExited)
                {
                    if (!process.WaitForExit(1500))
                    {
                        process.Kill(entireProcessTree: true);
                        process.WaitForExit(5000);
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.w(nameof(RemoteBrowserSession), $"[{Id}] Failed to kill browser process: {ex.Message}");
            }
            //Child processes may outlive a gracefully closed browser for a moment; make sure they are gone.
            try { process.Kill(entireProcessTree: true); } catch { }
        }

        internal string? ProfileDir => _profileDir;

        internal bool HasExited
        {
            get
            {
                try { return _process == null || _process.HasExited; } catch { return true; }
            }
        }

        private async Task DeleteProfileDirAsync()
        {
            var dir = _profileDir;
            if (dir == null || _persistentProfile)
                return;
            for (int i = 0; i < 10; i++)
            {
                try
                {
                    if (!Directory.Exists(dir))
                        return;
                    Directory.Delete(dir, true);
                    return;
                }
                catch (Exception ex)
                {
                    if (i == 9)
                        Logger.w(nameof(RemoteBrowserSession), $"[{Id}] Failed to delete profile dir {dir}: {ex.Message}");
                    await Task.Delay(500);
                }
            }
        }

        private void SafeInvoke(Action action)
        {
            try
            {
                action();
            }
            catch (Exception ex)
            {
                Logger.e(nameof(RemoteBrowserSession), $"[{Id}] OnClosed handler threw: {ex.Message}", ex);
            }
        }

        #endregion

        #region IWindow (unsupported parts)

        public Task SetRequestProxyAsync(string url, Func<WindowRequest, Task<WindowResponse>> handler, CancellationToken cancellationToken = default)
        {
            throw new NotSupportedException("Request proxying is not supported by the remote browser.");
        }

        public Task SetRequestModifier(Func<WindowRequest, WindowRequest> handler)
        {
            Logger.w(nameof(RemoteBrowserSession), $"[{Id}] SetRequestModifier is not supported by the remote browser and is ignored.");
            return Task.CompletedTask;
        }

        public Task ConfigureLiveChatViewAsync(int viewId, Grayjay.Engine.Models.Comments.LiveChatWindowDescriptor descriptor)
        {
            throw new NotSupportedException("Live chat views are not supported by the remote browser.");
        }

        #endregion
    }

    internal static class UserAgentHelper
    {
        /// <summary>
        /// Builds parameters for Emulation/Network.setUserAgentOverride, including UA client hints metadata consistent
        /// with the given user agent string (platform, mobile, brand versions), so headless never leaks "HeadlessChrome".
        /// </summary>
        public static object BuildOverride(string ua, string browserFullVersion, string browserProduct)
        {
            var browserMajor = browserFullVersion.Split('.')[0];
            var chromeMatch = Regex.Match(ua, @"(?:Chrome|CriOS)/(\d+)((?:\.\d+)*)");
            var major = chromeMatch.Success ? chromeMatch.Groups[1].Value : browserMajor;
            var fullVersion = major == browserMajor ? browserFullVersion
                : (chromeMatch.Success && chromeMatch.Groups[2].Value.Count(c => c == '.') == 3 && !chromeMatch.Groups[2].Value.StartsWith(".0.0") ? major + chromeMatch.Groups[2].Value : major + ".0.0.0");

            string platform, platformVersion = "", architecture = "x86", bitness = "64", model = "", navigatorPlatform;
            bool mobile;
            if (ua.Contains("Android", StringComparison.OrdinalIgnoreCase))
            {
                platform = "Android";
                var v = Regex.Match(ua, @"Android (\d+(?:\.\d+)*)");
                platformVersion = v.Success ? PadVersion(v.Groups[1].Value) : "10.0.0";
                var mm = Regex.Match(ua, @"Android [\d.]+; ([^;)]+)\)");
                model = mm.Success && mm.Groups[1].Value.Trim() != "K" ? mm.Groups[1].Value.Trim() : "";
                architecture = "";
                bitness = "";
                navigatorPlatform = "Linux armv81";
                mobile = ua.Contains("Mobile", StringComparison.OrdinalIgnoreCase);
            }
            else if (ua.Contains("iPhone", StringComparison.OrdinalIgnoreCase) || ua.Contains("iPad", StringComparison.OrdinalIgnoreCase))
            {
                platform = "iOS";
                var v = Regex.Match(ua, @"OS (\d+(?:_\d+)*)");
                platformVersion = v.Success ? PadVersion(v.Groups[1].Value.Replace('_', '.')) : "17.0.0";
                architecture = "arm";
                navigatorPlatform = ua.Contains("iPad", StringComparison.OrdinalIgnoreCase) ? "iPad" : "iPhone";
                mobile = ua.Contains("iPhone", StringComparison.OrdinalIgnoreCase) || ua.Contains("Mobile", StringComparison.OrdinalIgnoreCase);
            }
            else if (ua.Contains("Windows", StringComparison.OrdinalIgnoreCase))
            {
                platform = "Windows";
                platformVersion = "10.0.0";
                navigatorPlatform = "Win32";
                mobile = false;
            }
            else if (ua.Contains("Mac OS X", StringComparison.OrdinalIgnoreCase) || ua.Contains("Macintosh", StringComparison.OrdinalIgnoreCase))
            {
                platform = "macOS";
                var v = Regex.Match(ua, @"Mac OS X (\d+(?:[_.]\d+)*)");
                platformVersion = v.Success ? PadVersion(v.Groups[1].Value.Replace('_', '.')) : "14.0.0";
                architecture = "arm";
                navigatorPlatform = "MacIntel";
                mobile = false;
            }
            else
            {
                platform = "Linux";
                navigatorPlatform = "Linux x86_64";
                mobile = ua.Contains("Mobile", StringComparison.OrdinalIgnoreCase);
            }

            var brandName = ua.Contains("Edg/", StringComparison.Ordinal) || ua.Contains("EdgA/", StringComparison.Ordinal) ? "Microsoft Edge"
                : ua.Contains("OPR/", StringComparison.Ordinal) ? "Opera" : "Google Chrome";
            var brands = new object[]
            {
                new { brand = "Chromium", version = major },
                new { brand = brandName, version = major },
                new { brand = "Not.A/Brand", version = "99" }
            };
            var fullVersionList = new object[]
            {
                new { brand = "Chromium", version = fullVersion },
                new { brand = brandName, version = fullVersion },
                new { brand = "Not.A/Brand", version = "99.0.0.0" }
            };

            var acceptLanguage = Environment.GetEnvironmentVariable("GRAYJAY_REMOTE_BROWSER_LANG");
            if (string.IsNullOrWhiteSpace(acceptLanguage))
                acceptLanguage = "en-US,en"; //Chrome appends the q-values itself

            return new
            {
                userAgent = ua,
                acceptLanguage,
                platform = navigatorPlatform,
                userAgentMetadata = new
                {
                    brands,
                    fullVersionList,
                    fullVersion,
                    platform,
                    platformVersion,
                    architecture,
                    model,
                    mobile,
                    bitness,
                    wow64 = false
                }
            };
        }

        private static string PadVersion(string v)
        {
            var parts = v.Split('.').ToList();
            while (parts.Count < 3)
                parts.Add("0");
            return string.Join('.', parts);
        }
    }
}
