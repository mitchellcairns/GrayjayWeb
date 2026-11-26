using System.Diagnostics;
using System.Text.Json;
using Grayjay.Desktop.POC;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] If Tailscale Serve publishes this server (the tray's "Remote access → Turn on", or a manual
    /// `tailscale serve`), returns its https://machine.tailnet.ts.net origin so pairing QR codes can offer the installable
    /// HTTPS address first. Reads the local Tailscale CLI; returns null when it isn't installed (e.g. inside Docker).
    /// </summary>
    public static class TailscaleInfo
    {
        private static readonly object Lock = new();
        private static (DateTime at, int port, string? origin) _cache;

        public static string? ServeOrigin(int port)
        {
            lock (Lock)
            {
                if (_cache.port == port && DateTime.UtcNow - _cache.at < TimeSpan.FromSeconds(30))
                    return _cache.origin;
            }
            string? origin = null;
            try { origin = Query(port); }
            catch (Exception e) { Logger.w(nameof(TailscaleInfo), "Couldn't read tailscale serve status: " + e.Message); }
            lock (Lock) _cache = (DateTime.UtcNow, port, origin);
            return origin;
        }

        private static string? Exe()
        {
            var candidates = OperatingSystem.IsWindows()
                ? new[] { @"C:\Program Files\Tailscale\tailscale.exe", @"C:\Program Files (x86)\Tailscale\tailscale.exe" }
                : OperatingSystem.IsMacOS()
                    ? new[] { "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale" }
                    : new[] { "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale" };
            var found = candidates.FirstOrDefault(File.Exists);
            if (found != null) return found;
            var name = OperatingSystem.IsWindows() ? "tailscale.exe" : "tailscale";
            return (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
                .Select(d => { try { return Path.Combine(d, name); } catch { return null; } })
                .FirstOrDefault(p => p != null && File.Exists(p));
        }

        private static string? Query(int port)
        {
            var exe = Exe();
            if (exe == null) return null;
            var psi = new ProcessStartInfo(exe, "serve status --json")
            {
                RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true
            };
            using var p = Process.Start(psi);
            if (p == null) return null;
            var stdout = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(5000)) { try { p.Kill(); } catch { } return null; }
            using var doc = JsonDocument.Parse(stdout.Result.Length == 0 ? "{}" : stdout.Result);
            if (!doc.RootElement.TryGetProperty("Web", out var web) || web.ValueKind != JsonValueKind.Object) return null;
            var target = $"127.0.0.1:{port}";
            var targetLocalhost = $"localhost:{port}";
            foreach (var host in web.EnumerateObject())
            {
                if (!host.Value.TryGetProperty("Handlers", out var handlers) || handlers.ValueKind != JsonValueKind.Object) continue;
                foreach (var h in handlers.EnumerateObject())
                {
                    if (h.Value.TryGetProperty("Proxy", out var proxy) && proxy.GetString() is string s && (s.Contains(target) || s.Contains(targetLocalhost)))
                    {
                        var hostPort = host.Name;
                        return "https://" + (hostPort.EndsWith(":443") ? hostPort[..^4] : hostPort);
                    }
                }
            }
            return null;
        }
    }
}
