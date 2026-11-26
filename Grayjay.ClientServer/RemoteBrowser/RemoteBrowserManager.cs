using Grayjay.Desktop.POC;
using System.Collections.Concurrent;

namespace Grayjay.ClientServer.RemoteBrowser
{
    /// <summary>
    /// Owns all remote browser sessions: creation (with a concurrency cap), lookup, idle timeout,
    /// UI broadcasts (RemoteBrowserOpened / RemoteBrowserClosed) and cleanup on server shutdown.
    /// </summary>
    public static class RemoteBrowserManager
    {
        public const string EnvProfileDir = "GRAYJAY_REMOTE_BROWSER_PROFILE_DIR";

        public static int MaxSessions { get; set; } = 3;
        public static TimeSpan IdleTimeout { get; set; } = TimeSpan.FromMinutes(15);
        public static TimeSpan StartTimeout { get; set; } = TimeSpan.FromSeconds(60);

        private static readonly ConcurrentDictionary<string, RemoteBrowserSession> _sessions = new ConcurrentDictionary<string, RemoteBrowserSession>();
        private static readonly ConcurrentDictionary<string, RemoteBrowserSession> _processes = new ConcurrentDictionary<string, RemoteBrowserSession>();
        private static readonly object _lock = new object();
        private static int _starting = 0;
        private static Timer? _idleTimer;
        private static bool _initialized = false;
        private static bool _staleCleaned = false;

        private static void EnsureInitialized()
        {
            lock (_lock)
            {
                if (_initialized)
                    return;
                _initialized = true;
                AppDomain.CurrentDomain.ProcessExit += (_, _) => KillAll();
                AppDomain.CurrentDomain.UnhandledException += (_, e) =>
                {
                    if (e.IsTerminating)
                        KillAll();
                };
                _idleTimer = new Timer(_ => CheckIdle(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
            }
        }

        /// <summary>
        /// Same contract as <see cref="IWindowProvider.CreateInterceptorWindowAsync"/>: launches a remote browser,
        /// loads <paramref name="url"/> and reports every request (with full headers incl. cookie) to <paramref name="handler"/>.
        /// The returned window fires <see cref="IWindow.OnClosed"/> when it is closed for any reason.
        /// Throws (with a user presentable message) when no Chromium is installed or too many sessions are open.
        /// </summary>
        public static async Task<IWindow> CreateInterceptorWindowAsync(string title, string url, string userAgent, bool useMobileEmulation, string? injectJs, Action<InterceptorRequest> handler, CancellationToken cancellationToken = default)
        {
            return await CreateSessionAsync(title, url, userAgent, useMobileEmulation, injectJs, handler, cancellationToken);
        }

        public static async Task<RemoteBrowserSession> CreateSessionAsync(string title, string url, string? userAgent, bool useMobileEmulation, string? injectJs, Action<InterceptorRequest> handler, CancellationToken cancellationToken = default)
        {
            EnsureInitialized();
            if (string.IsNullOrWhiteSpace(url))
                throw new ArgumentException("A URL is required.", nameof(url));

            //Fail fast with a clear message before reserving a slot.
            ChromiumLocator.FindOrThrow();

            lock (_lock)
            {
                var open = _sessions.Values.Count(x => !x.IsClosed) + _starting;
                if (open >= MaxSessions)
                    throw new InvalidOperationException($"Too many remote browser sessions are open (maximum {MaxSessions}). Close an existing login window and try again.");
                _starting++;
            }

            RemoteBrowserSession? session = null;
            try
            {
                CleanupStaleProfiles();
                session = new RemoteBrowserSession(title, url, userAgent, useMobileEmulation, injectJs, handler);
                var profileDir = Path.Combine(GetProfileBaseDir(), "rb-" + session.Id);

                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(StartTimeout);
                await session.StartAsync(profileDir, timeout.Token);
                _sessions[session.Id] = session;
            }
            catch (Exception ex)
            {
                Logger.e(nameof(RemoteBrowserManager), "Failed to start remote browser session: " + ex.Message, ex);
                if (session != null)
                {
                    try { await session.CloseInternalAsync("startup failed"); } catch { }
                }
                if (ex is OperationCanceledException && !cancellationToken.IsCancellationRequested)
                    throw new TimeoutException("Timed out starting the remote login browser.", ex);
                throw;
            }
            finally
            {
                lock (_lock)
                    _starting--;
            }

            Logger.i(nameof(RemoteBrowserManager), $"Remote browser session {session.Id} opened for '{title}' ({url}).");
            BroadcastSafe(session.Describe(), "RemoteBrowserOpened");
            session.BeginInitialNavigation();
            return session;
        }

        public static IReadOnlyList<RemoteBrowserSession> GetSessions()
        {
            return _sessions.Values.Where(x => x.IsStarted && !x.IsClosed).OrderBy(x => x.CreatedAtUtc).ToList();
        }

        public static RemoteBrowserSession? GetSession(string id)
        {
            return _sessions.TryGetValue(id, out var s) && !s.IsClosed ? s : null;
        }

        public static async Task CloseAllAsync()
        {
            var sessions = _sessions.Values.ToList();
            await Task.WhenAll(sessions.Select(s => s.CloseInternalAsync("server shutting down")));
        }

        internal static void TrackProcess(RemoteBrowserSession session)
        {
            EnsureInitialized();
            _processes[session.Id] = session;
        }

        internal static void Unregister(RemoteBrowserSession session)
        {
            _processes.TryRemove(session.Id, out _);
            if (_sessions.TryRemove(session.Id, out _))
            {
                Logger.i(nameof(RemoteBrowserManager), $"Remote browser session {session.Id} closed.");
                BroadcastSafe(new { id = session.Id }, "RemoteBrowserClosed");
            }
        }

        private static void BroadcastSafe(object payload, string type)
        {
            try
            {
                var ws = GrayjayServer.Instance?.WebSocket;
                if (ws == null)
                    return;
                _ = ws.Broadcast(payload, type).ContinueWith(t =>
                {
                    if (t.Exception != null)
                        Logger.w(nameof(RemoteBrowserManager), $"Broadcast {type} failed: {t.Exception.GetBaseException().Message}");
                }, TaskScheduler.Default);
            }
            catch (Exception ex)
            {
                Logger.w(nameof(RemoteBrowserManager), $"Broadcast {type} failed: {ex.Message}");
            }
        }

        private static void CheckIdle()
        {
            try
            {
                var now = DateTime.UtcNow;
                foreach (var session in _sessions.Values.ToList())
                {
                    if (session.IsClosed)
                        continue;
                    if (now - session.LastActivityUtc > IdleTimeout)
                    {
                        Logger.i(nameof(RemoteBrowserManager), $"Closing idle remote browser session {session.Id}.");
                        _ = session.CloseInternalAsync("idle timeout");
                    }
                    else if (session.IsStarted && session.HasExited)
                        _ = session.CloseInternalAsync("browser process exited");
                }
            }
            catch (Exception ex)
            {
                Logger.e(nameof(RemoteBrowserManager), "Idle check failed: " + ex.Message, ex);
            }
        }

        private static void KillAll()
        {
            foreach (var session in _processes.Values.ToList())
            {
                try
                {
                    session.KillNow();
                }
                catch { }
            }
        }

        public static string GetProfileBaseDir()
        {
            var env = Environment.GetEnvironmentVariable(EnvProfileDir);
            var dir = !string.IsNullOrWhiteSpace(env) ? env : Path.Combine(Path.GetTempPath(), "grayjay-remote-browser");
            Directory.CreateDirectory(dir);
            return dir;
        }

        /// <summary>Removes profile directories left behind by a crashed server (after killing their orphaned browsers).</summary>
        private static void CleanupStaleProfiles()
        {
            lock (_lock)
            {
                if (_staleCleaned)
                    return;
                _staleCleaned = true;
            }
            var baseDir = GetProfileBaseDir();
            var active = new HashSet<string>(_processes.Values.Select(x => x.ProfileDir).Where(x => x != null).Select(x => x!));
            BrowserProcessGuard.KillOrphans(baseDir, active);
            try
            {
                foreach (var dir in Directory.GetDirectories(baseDir, "rb-*"))
                {
                    try
                    {
                        if (!active.Contains(dir))
                            Directory.Delete(dir, true); //fails harmlessly for directories still in use
                    }
                    catch { }
                }
            }
            catch { }
        }
    }

    /// <summary>
    /// Optional <see cref="IWindowProvider"/> for headless/web mode: interceptor windows become remote browser
    /// sessions, everything else (native windows, file dialogs) is not available on a headless server.
    /// </summary>
    public class RemoteBrowserWindowProvider : IWindowProvider
    {
        public Task<IWindow> CreateInterceptorWindowAsync(string title, string url, string userAgent, bool useMobileEmulation, string? injectJs, Action<InterceptorRequest> handler, CancellationToken cancellationToken = default)
            => RemoteBrowserManager.CreateInterceptorWindowAsync(title, url, userAgent, useMobileEmulation, injectJs, handler, cancellationToken);

        public Task<IWindow> CreateWindowAsync(string url, string title, int preferredWidth, int preferredHeight, int minimumWidth = 0, int minimumHeight = 0, Func<IWindow, Task>? beforeLoad = null)
            => throw new NotSupportedException("Native windows are not available when running as a web server.");

        public Task<string>? ShowDirectoryDialogAsync(CancellationToken cancellationToken = default)
            => throw new NotSupportedException("Directory dialogs are not available when running as a web server.");

        public Task<string?> ShowFileDialogAsync((string name, string pattern)[] filters, CancellationToken cancellationToken = default)
            => throw new NotSupportedException("File dialogs are not available when running as a web server.");

        public Task<string?> ShowSaveFileDialogAsync(string name, (string name, string pattern)[] filters, CancellationToken cancellationToken = default)
            => throw new NotSupportedException("Save dialogs are not available when running as a web server.");
    }
}
