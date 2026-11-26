using System.Net;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] Options for running the Grayjay server as a self-hosted web app (PWA backend).
    /// When <see cref="GrayjayServer.Web"/> is set the server listens on <see cref="ListenAddress"/>:<see cref="Port"/>,
    /// requires a paired-device session cookie on every non-public route, serves the PWA from <see cref="AppRoot"/> at /app,
    /// and emits same-origin relative URLs for all media so phones never need to reach a second port.
    /// </summary>
    public class WebHostOptions
    {
        public IPAddress ListenAddress { get; set; } = IPAddress.Any;
        public int Port { get; set; } = 11338;

        /// <summary>Directory containing the built PWA (index.html, sw.js, assets/...).</summary>
        public string? AppRoot { get; set; }

        /// <summary>Optional password that can be used instead of pairing. Null disables password login.</summary>
        public string? Password { get; set; }

        /// <summary>
        /// Secret shared with the local launcher (tray app). Exchanging it at /auth/Local creates a session on the host machine
        /// without pairing. Never derived from the client IP, because tunnels (Tailscale Serve, cloudflared) forward from loopback.
        /// </summary>
        public string? LocalSecret { get; set; }

        /// <summary>Disables authentication entirely. Only for setups where a reverse proxy already authenticates.</summary>
        public bool DisableAuth { get; set; } = false;

        /// <summary>
        /// Addresses phones should use to reach this server (e.g. "https://grayjay.example.com" or "http://10.8.0.1:11338"
        /// for a WireGuard peer). Shown first in pairing QR codes. Needed in Docker, where the server only sees its
        /// container network. When set, auto-detected network addresses are not offered.
        /// </summary>
        public List<string> PublicUrls { get; set; } = new List<string>();

        /// <summary>Path prefix the PWA is served under.</summary>
        public const string AppPath = "/app";
    }
}
