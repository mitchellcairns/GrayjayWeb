using System.Runtime.InteropServices;

namespace Grayjay.ClientServer.RemoteBrowser
{
    /// <summary>
    /// Finds a Chromium based browser (Chrome, Chromium, Edge, Brave) that can be driven over the Chrome DevTools Protocol.
    /// Lookup order: env GRAYJAY_CHROME_PATH, then well known install locations / PATH entries for the current OS.
    /// </summary>
    public static class ChromiumLocator
    {
        public const string EnvChromePath = "GRAYJAY_CHROME_PATH";

        public static string? Find()
        {
            var env = Environment.GetEnvironmentVariable(EnvChromePath);
            if (!string.IsNullOrWhiteSpace(env))
            {
                env = env.Trim().Trim('"');
                if (File.Exists(env))
                    return env;
                //Explicitly configured but invalid: do not silently fall back to another browser.
                return FindOnPath(env);
            }

            foreach (var candidate in GetCandidates())
            {
                try
                {
                    if (Path.IsPathRooted(candidate))
                    {
                        if (File.Exists(candidate))
                            return candidate;
                    }
                    else
                    {
                        var found = FindOnPath(candidate);
                        if (found != null)
                            return found;
                    }
                }
                catch
                {
                    //Ignore invalid candidates
                }
            }
            return null;
        }

        public static string FindOrThrow()
        {
            var env = Environment.GetEnvironmentVariable(EnvChromePath);
            var found = Find();
            if (found != null)
                return found;

            if (!string.IsNullOrWhiteSpace(env))
                throw new FileNotFoundException($"The browser configured via {EnvChromePath} ('{env}') does not exist. Install Chrome, Chromium or Edge on the server, or fix {EnvChromePath}.");

            string hint;
            if (OperatingSystem.IsWindows())
                hint = "Install Google Chrome or Microsoft Edge on the server";
            else if (OperatingSystem.IsMacOS())
                hint = "Install Google Chrome, Chromium or Microsoft Edge in /Applications on the server";
            else
                hint = "Install Chromium on the server (e.g. 'apt install chromium' or 'apk add chromium')";
            throw new FileNotFoundException($"No Chromium based browser was found on the server, which is required for logging in from the web interface. {hint}, or set the {EnvChromePath} environment variable to the browser executable.");
        }

        private static IEnumerable<string> GetCandidates()
        {
            if (OperatingSystem.IsWindows())
            {
                var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
                var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                var roots = new[] { programFiles, programFilesX86, localAppData }.Where(x => !string.IsNullOrEmpty(x)).Distinct().ToList();

                foreach (var root in roots)
                    yield return Path.Combine(root, "Google", "Chrome", "Application", "chrome.exe");
                foreach (var root in roots)
                    yield return Path.Combine(root, "Chromium", "Application", "chrome.exe");
                foreach (var root in roots)
                    yield return Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe");
                foreach (var root in roots)
                    yield return Path.Combine(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe");
                yield return "chrome.exe";
                yield return "msedge.exe";
            }
            else if (OperatingSystem.IsMacOS())
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                var apps = new[]
                {
                    "Google Chrome.app/Contents/MacOS/Google Chrome",
                    "Chromium.app/Contents/MacOS/Chromium",
                    "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                    "Brave Browser.app/Contents/MacOS/Brave Browser",
                    "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
                };
                foreach (var app in apps)
                    yield return Path.Combine("/Applications", app);
                foreach (var app in apps)
                    yield return Path.Combine(home, "Applications", app);
                yield return "chromium";
                yield return "google-chrome";
            }
            else
            {
                var names = new[]
                {
                    "chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
                    "microsoft-edge", "microsoft-edge-stable", "brave-browser"
                };
                foreach (var name in names)
                    yield return name;
                foreach (var name in names)
                    yield return Path.Combine("/usr/bin", name);
                yield return "/usr/lib/chromium/chromium";
                yield return "/usr/lib/chromium-browser/chromium-browser";
                yield return "/opt/google/chrome/chrome";
                yield return "/opt/microsoft/msedge/msedge";
                yield return "/snap/bin/chromium";
                yield return "/usr/local/bin/chromium";
            }
        }

        private static string? FindOnPath(string name)
        {
            if (string.IsNullOrWhiteSpace(name) || name.Contains(Path.DirectorySeparatorChar) || name.Contains(Path.AltDirectorySeparatorChar))
                return null;
            var path = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(path))
                return null;
            foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    var full = Path.Combine(dir.Trim('"'), name);
                    if (File.Exists(full))
                        return full;
                    if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && !name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(full + ".exe"))
                        return full + ".exe";
                }
                catch
                {
                    //Ignore malformed PATH entries
                }
            }
            return null;
        }
    }
}
