// [GrayjayWeb] Headless entry point: runs the Grayjay engine and API as the backend of the Grayjay PWA.
// Modified from Grayjay.Desktop.CEF/Program.cs (Copyright FUTO Holdings, Inc., Source First License 1.1).
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Grayjay.ClientServer;
using Grayjay.ClientServer.Constants;
using Grayjay.ClientServer.RemoteBrowser;
using Grayjay.ClientServer.Settings;
using Grayjay.ClientServer.States;
using Grayjay.ClientServer.Web;
using Grayjay.Desktop.POC;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

namespace Grayjay.Web.Host
{
    public static class Program
    {
        public static async Task<int> Main(string[] args)
        {
            var opts = ParseOptions(args, out var dataDir, out bool showHelp, out var logFile);
            if (showHelp)
            {
                PrintHelp();
                return 0;
            }
            if (logFile != null)
                LogToFile(logFile);

            Directories.SetBase(dataDir);
            Console.WriteLine($"Grayjay Web server — data directory: {Directories.Base}");

            Logger.LoadFromSettings();
            Grayjay.Engine.Logger.LogCallback = (level, tag, message, ex) => Logger.Log((LogLevel)level, tag, message, ex);
            Grayjay.Engine.Logger.WillLog = (level) => Logger.WillLog((LogLevel)level);
            SyncShared.Logger.WillLog = (level) => Logger.WillLog((LogLevel)level);
            SyncShared.Logger.LogCallback = (level, tag, message, ex) => Logger.Log((LogLevel)level, tag, message, ex);
            FUTO.MDNS.Logger.LogCallback = (level, tag, message, ex) => Logger.Log((LogLevel)level, tag, message, ex);
            FUTO.MDNS.Logger.WillLog = (level) => Logger.WillLog((LogLevel)level);

            GrayjayDevSettings.Instance.DeveloperMode = File.Exists(Path.Combine(Directories.Base, "DEV"));

            // Plugin sign-in and captchas run in a server-side Chromium streamed to the PWA (remote login browser).
            WebWindowProvider.InterceptorFactory = (title, url, userAgent, mobile, injectJs, handler, ct) =>
                RemoteBrowserManager.CreateInterceptorWindowAsync(title, url, userAgent, mobile, injectJs, handler, ct);
            GrayjayServer.WebEndpointsHook = app =>
            {
                RemoteBrowserEndpoints.Map(app);
                // Forget remembered sign-in browser profiles (called when signing out of a source).
                app.MapPost("/RemoteBrowser/ForgetAccounts", () => Results.Json(new { removed = RemoteBrowserManager.ForgetPersistentProfiles() }));
            };

            Logger.i(nameof(Program), "StateApp.Startup");
            await StateApp.Startup();

            var server = new GrayjayServer(new WebWindowProvider(), isHeadlessMode: true, isServerMode: true, tokenSecurity: false)
            {
                Web = opts
            };

            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
            AppDomain.CurrentDomain.ProcessExit += (_, _) => { try { cts.Cancel(); } catch { } };

            var runTask = Task.Run(async () =>
            {
                try
                {
                    await server.RunServerAsync(null, cts.Token);
                }
                catch (Exception ex)
                {
                    Logger.e(nameof(Program), "Server crashed.", ex);
                    Environment.ExitCode = 1;
                }
            });

            // If the server fails before it starts listening, exit (non-zero) instead of waiting forever,
            // so the tray app can report the failure and restart it.
            var started = Task.Run(() => server.StartedResetEvent.Wait(cts.Token));
            if (await Task.WhenAny(started, runTask) == runTask && !server.StartedResetEvent.IsSet)
            {
                Logger.e(nameof(Program), "Server stopped before it finished starting.");
                return Environment.ExitCode == 0 ? 1 : Environment.ExitCode;
            }
            PrintBanner(server, opts);

            await runTask;
            try { await server.StopServer(); } catch { }
            return Environment.ExitCode;
        }

        private static void PrintBanner(GrayjayServer server, WebHostOptions opts)
        {
            Console.WriteLine();
            Console.WriteLine("  Grayjay Web is running.");
            Console.WriteLine($"  Open:  http://localhost:{opts.Port}{WebHostOptions.AppPath}/");
            foreach (var url in opts.PublicUrls)
                Console.WriteLine($"         {url.TrimEnd('/')}{WebHostOptions.AppPath}/");
            // Listening on loopback only (behind a tunnel or reverse proxy): LAN addresses wouldn't answer.
            if (!IPAddress.IsLoopback(opts.ListenAddress))
                foreach (var ip in GetLanAddresses())
                    Console.WriteLine($"         http://{ip}:{opts.Port}{WebHostOptions.AppPath}/");

            if (opts.DisableAuth)
            {
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("  Authentication is DISABLED (--no-auth). Anyone who can reach this port controls this server.");
                Console.ResetColor();
            }
            else if (server.WebAuth != null && server.WebAuth.GetDevices().Count == 0 && (opts.LocalSecret == null || _secretFromFile))
            {
                // Standalone (no tray app): print a code so the very first device can pair.
                var (code, _) = server.WebAuth.CreatePairingCode("console");
                Console.WriteLine();
                Console.WriteLine($"  No devices are paired yet. Pairing code (valid 10 minutes): {code}");
                var baseUrl = opts.PublicUrls.FirstOrDefault()?.TrimEnd('/') ?? $"http://<this-computer>:{opts.Port}";
                Console.WriteLine($"  Or open {baseUrl}{WebHostOptions.AppPath}/#pair={code}");
            }
            Console.WriteLine();
        }

        private static IEnumerable<IPAddress> GetLanAddresses()
        {
            try
            {
                return NetworkInterface.GetAllNetworkInterfaces()
                    .Where(ni => ni.OperationalStatus == OperationalStatus.Up && ni.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                    .SelectMany(ni => ni.GetIPProperties().UnicastAddresses)
                    .Select(x => x.Address)
                    .Where(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a) && !a.ToString().StartsWith("169.254."))
                    .ToList();
            }
            catch
            {
                return Array.Empty<IPAddress>();
            }
        }

        private static string DefaultDataDir()
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            if (string.IsNullOrEmpty(appData))
                appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config");
            return Path.Combine(appData, "GrayjayWeb");
        }

        /// <summary>
        /// Copies everything printed (startup lines, the first pairing code, warnings) to a file as well: for running as a
        /// background service with no console, e.g. a scheduled task whose log a dashboard shows. Kept under ~10 MB.
        /// </summary>
        private static void LogToFile(string path)
        {
            try
            {
                path = Path.GetFullPath(path);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                if (File.Exists(path) && new FileInfo(path).Length > 10_000_000)
                    File.Move(path, path + ".old", true);
                var file = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) { AutoFlush = true };
                file.WriteLine($"----- {DateTime.Now:yyyy-MM-dd HH:mm:ss} start -----");
                Console.SetOut(TextWriter.Synchronized(new TeeWriter(Console.Out, file)));
                Console.SetError(TextWriter.Synchronized(new TeeWriter(Console.Error, file)));
            }
            catch (Exception e) { Console.Error.WriteLine($"Can't write the log file {path}: {e.Message}"); }
        }

        private sealed class TeeWriter : TextWriter
        {
            private readonly TextWriter _a, _b;
            public TeeWriter(TextWriter a, TextWriter b) { _a = a; _b = b; }
            public override System.Text.Encoding Encoding => System.Text.Encoding.UTF8;
            public override void Write(char value) { try { _a.Write(value); } catch { } try { _b.Write(value); } catch { } }
            public override void Write(string? value) { try { _a.Write(value); } catch { } try { _b.Write(value); } catch { } }
            public override void WriteLine(string? value) { try { _a.WriteLine(value); } catch { } try { _b.WriteLine(value); } catch { } }
            public override void Flush() { try { _a.Flush(); } catch { } try { _b.Flush(); } catch { } }
        }

        /// <summary>
        /// The secret that signs a browser on this computer in without pairing (GET /auth/Local?secret=…), kept in a file
        /// so a shortcut on the server can use it, like the tray app does. Created on first start.
        /// </summary>
        private static bool _secretFromFile;

        private static string LoadOrCreateSecret(string path)
        {
            path = Path.GetFullPath(path);
            if (File.Exists(path) && File.ReadAllText(path).Trim() is string existing && existing.Length >= 32)
                return existing;
            var secret = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, secret);
            return secret;
        }

        private static WebHostOptions ParseOptions(string[] args, out string dataDir, out bool showHelp, out string? logFile)
        {
            string? env(string name) => Environment.GetEnvironmentVariable(name) is string v && v.Length > 0 ? v : null;

            var opts = new WebHostOptions();
            dataDir = env("GRAYJAY_DATA_DIR") ?? DefaultDataDir();
            logFile = env("GRAYJAY_LOG_FILE");
            string? localSecretFile = env("GRAYJAY_LOCAL_SECRET_FILE");
            showHelp = false;

            if (env("GRAYJAY_PORT") is string p && int.TryParse(p, out var port)) opts.Port = port;
            if (env("GRAYJAY_BIND") is string b && IPAddress.TryParse(b, out var bind)) opts.ListenAddress = bind;
            opts.Password = env("GRAYJAY_PASSWORD");
            opts.LocalSecret = env("GRAYJAY_LOCAL_SECRET");
            opts.DisableAuth = env("GRAYJAY_NO_AUTH") == "1";
            opts.AppRoot = env("GRAYJAY_APP_ROOT");
            if (env("GRAYJAY_PUBLIC_URLS") is string urls)
                opts.PublicUrls = urls.Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries).ToList();

            for (int i = 0; i < args.Length; i++)
            {
                string next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"Missing value for {args[i]}");
                switch (args[i])
                {
                    case "--port": opts.Port = int.Parse(next()); break;
                    case "--bind": opts.ListenAddress = IPAddress.Parse(next()); break;
                    case "--data-dir": dataDir = next(); break;
                    case "--app-root": opts.AppRoot = next(); break;
                    case "--password": opts.Password = next(); break;
                    case "--no-auth": opts.DisableAuth = true; break;
                    case "--public-url": opts.PublicUrls.Add(next()); break;
                    case "--log-file": logFile = next(); break;
                    case "--local-secret-file": localSecretFile = next(); break;
                    case "-h":
                    case "--help": showHelp = true; break;
                    default: Console.WriteLine($"Ignoring unknown argument {args[i]}"); break;
                }
            }

            if (opts.LocalSecret == null && localSecretFile != null)
            {
                opts.LocalSecret = LoadOrCreateSecret(localSecretFile);
                _secretFromFile = true; // a service with shortcuts, not the tray: still print the first pairing code
            }
            opts.AppRoot ??= FindAppRoot();
            return opts;
        }

        private static string? FindAppRoot()
        {
            var candidates = new[]
            {
                Path.Combine(AppContext.BaseDirectory, "app"),
                Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "Grayjay.Web.App", "dist"),
                Path.Combine(Environment.CurrentDirectory, "Grayjay.Web.App", "dist"),
            };
            return candidates.Select(Path.GetFullPath).FirstOrDefault(c => File.Exists(Path.Combine(c, "index.html")));
        }

        private static void PrintHelp()
        {
            Console.WriteLine("""
                GrayjayWebServer — self-hosted backend for the Grayjay PWA

                  --port <n>         Port to listen on (default 11338, env GRAYJAY_PORT)
                  --bind <ip>        Address to bind (default 0.0.0.0, env GRAYJAY_BIND; use 127.0.0.1 behind Tailscale Serve)
                  --data-dir <dir>   Data directory (default <AppData>/GrayjayWeb, env GRAYJAY_DATA_DIR)
                  --app-root <dir>   Built PWA directory (default ./app, env GRAYJAY_APP_ROOT)
                  --password <pw>    Allow password sign-in in addition to pairing (env GRAYJAY_PASSWORD)
                  --public-url <url> Address phones use to reach this server; repeatable (env GRAYJAY_PUBLIC_URLS, comma-separated)
                  --log-file <path>  Also write what's printed (incl. the first pairing code) to this file (env GRAYJAY_LOG_FILE)
                  --local-secret-file <path>  Secret for signing in a browser on this computer without pairing, as the tray
                                     does (GET /auth/Local?secret=...); created if missing (env GRAYJAY_LOCAL_SECRET_FILE)
                  --no-auth          Disable authentication (only behind an authenticating reverse proxy)

                Env GRAYJAY_LOCAL_SECRET: secret the tray app uses to sign in on this computer via /auth/Local.
                Env GRAYJAY_CHROME_PATH: Chrome/Edge/Chromium used for plugin sign-in (remote login browser).
                """);
        }
    }
}
