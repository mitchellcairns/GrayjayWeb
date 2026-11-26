# Grayjay Web

**Grayjay, as an app on your phone, from a server on your own computer.**

Grayjay Web is an **unofficial, modified version** of [Grayjay Desktop](https://gitlab.futo.org/videostreaming/Grayjay.Desktop) by [FUTO](https://futo.org). It turns Grayjay into a self-hosted web app (a PWA) that you can install on iPhone, iPad, Android or any desktop browser. It is not affiliated with or endorsed by FUTO. See [What was modified](#what-was-modified) and [License](#license).

| | |
|---|---|
| **Server** | Grayjay's own engine (all regular Grayjay plugins work unchanged) running headless on your PC, Mac or Linux box |
| **App** | A new mobile-first PWA: installs to your home screen, keeps playing while you browse, works on iOS and Android Safari/Chrome |
| **Tray app** | A small taskbar icon (Rust) that runs the server, pairs phones with a QR code and turns on remote access. No Docker, no terminal |

## Why a server?

A web page can't run Grayjay by itself. Browsers block pages from reading other sites (CORS) and from setting the headers and cookies that platforms like YouTube require, and a page can never read another site's login cookies. So the plugins run on your computer and the app talks to it. As a bonus, your logins never leave your machine, and YouTube treats your home connection far better than a cloud server.

## Getting started

1. Download a release for your computer and run **Grayjay Web** (the tray app). A Grayjay icon appears in your taskbar or menu bar.
2. Your browser opens with a **pairing QR code**. Scan it with your phone's camera.
3. On iPhone, tap **Share → Add to Home Screen**. On Android, tap **Install app**. Done.

**Away from home:** in the tray menu, choose **Remote access → Turn on (Tailscale)**. With free [Tailscale](https://tailscale.com) on both devices you get a private `https://your-pc.your-tailnet.ts.net/app/` address that works anywhere. It also gives you HTTPS, which the full PWA experience (offline shell, wake lock, install prompts) needs.

### Docker (home servers, NAS, WireGuard)

Needs Docker with Compose, Git and Git LFS (`sudo apt install git git-lfs` on Debian/Ubuntu). About 2 GB of RAM to build.

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --recurse-submodules --shallow-submodules https://github.com/mitchellcairns/GrayjayWeb.git
cd GrayjayWeb
git lfs install
git lfs pull --include "Grayjay.ClientServer/deps/linux-x64/**"     # ARM (e.g. Raspberry Pi 5): linux-arm64
# edit docker-compose.yml: set GRAYJAY_PUBLIC_URLS to the address your phones use (e.g. your WireGuard IP)
docker compose up -d --build                                       # first build takes ~5-10 minutes
docker compose logs grayjay | grep -i "pairing code"               # enter this code on your first device
```

To update later: `git pull --recurse-submodules && git lfs pull --include "Grayjay.ClientServer/deps/linux-x64/**" && docker compose up -d --build`.

- The image bundles Chromium for plugin sign-in, ffmpeg, and the PWA; data lives in the `grayjay-data` volume.
- **WireGuard:** phones on the tunnel reach the server at its WireGuard IP, e.g. `http://10.8.0.1:11338/app/`. Set `GRAYJAY_PUBLIC_URLS=http://10.8.0.1:11338` so pairing QR codes use that address.
- **HTTPS (needed to install the PWA on phones):** `docker compose --profile https up -d` adds Caddy. Either point a DNS name at the WireGuard IP and get a real certificate (Let's Encrypt, or a DNS challenge if the box isn't public), or use `tls internal` with the IP and trust Caddy's root certificate once on each phone. See `docker/Caddyfile`.
- Grayjay Sync listens on port 12315 if you want your Grayjay apps to connect directly over the LAN/VPN (it also works through FUTO's relay without it).

### Bringing your data over

The first time you open the app, a short setup offers to:
- **Sync with Grayjay on another device.** Grayjay Android/Desktop: *Settings → Sync → Link new device*, then scan the QR code. Subscriptions, playlists, watch later and history stay in sync.
- **Import a Grayjay backup** (the `.zip` from Grayjay Android's *Export*), with a choice of what to import.
- **Import subscriptions** from YouTube (Google Takeout `subscriptions.csv`) or NewPipe (`.json`).
- Pick your sources and sign in.

You can come back to it from *Settings → Import & sync*. *Settings* can also download a backup of this server.

### Signing in to YouTube (including accounts with several channels)

In **Sources → YouTube → Sign in**, Grayjay opens the real Google sign-in page:
- **On the computer running Grayjay**, it opens in its own browser window.
- **On a phone or another device**, a browser running on the server is streamed to you. You type and tap as normal, and phone keyboards and password managers work.

When YouTube asks which channel to use, Grayjay shows a native list of all your channels and brand accounts, so you just tap one. The sign-in browser remembers your Google account, so signing in again or switching channel later takes a single tap. (A "Sign in with Google" button isn't possible here: Grayjay needs a real YouTube web session, which Google's OAuth doesn't provide.)

## Features

- Home, Subscriptions (with groups), Search (paste any link to open it), Channels, History
- Subscriptions is the home screen. Recommendations live under *Discover*.
- One persistent player: swipe down or press Back to minimize into a floating mini-player. You can drag it anywhere and resize it from the corner, and its size and position are remembered. It morphs smoothly between full and mini, and playback never stops while you browse.
- Player controls in the bar: captions, audio track, speed and quality. The playhead seeks smoothly with a time and chapter preview. Speed, volume and caption language are remembered.
- **SponsorBlock** (enable it in *Sources → YouTube → Settings*): segments are coloured on the seek bar. Each category is skipped automatically or gets a Skip button, per your settings. Return YouTube Dislike and DeArrow are in the same settings.
- DASH and HLS via Shaka Player, including **ManagedMediaSource on iOS 17.1+**; quality and speed controls; resumes where you left off
- Native web APIs:
  - Media Session (lock screen and headphone controls)
  - Picture-in-Picture
  - Screen Wake Lock
  - Fullscreen with orientation lock
  - Web Share
  - Share Target (Android: "Share → Grayjay" from the YouTube app)
  - View-transition-ready routing, pull-to-refresh, safe-area insets
- Device pairing with one-time QR codes, a per-device session list, and revoking any device
- Server-pushed dialogs and toasts from plugins, plugin install, enable and disable
- Support/purchase of Grayjay (FUTO's payment portal and license activation) is kept, as the license requires

## Repository layout

| Path | What |
|---|---|
| `Grayjay.Web.App/` | The PWA (SolidJS + Vite + Shaka Player + vite-plugin-pwa) |
| `Grayjay.Web.Host/` | Headless server entry point (`GrayjayWebServer`) |
| `Grayjay.Web.Tray/` | Tray app (Rust: `tray-icon`, `tao`) |
| `Grayjay.ClientServer/Web/` | Web mode: device pairing and auth, single-origin media proxy, PWA hosting |
| `Grayjay.ClientServer/RemoteBrowser/` | Remote login browser (Chromium over CDP, streamed to the app) |
| everything else | Upstream Grayjay Desktop (see `README.Desktop.md`) |

## Building

Requirements: .NET 8 SDK (or newer, targeting net8.0), Node 20+, Rust stable, Git LFS. You also need Chrome, Edge or Chromium on the server machine for plugin sign-in.

```powershell
git clone --recurse-submodules https://github.com/mitchellcairns/GrayjayWeb.git
cd GrayjayWeb
./build-web.ps1 -Rid win-x64          # or linux-x64, linux-arm64, osx-arm64, osx-x64
# → out/GrayjayWeb-win-x64/grayjay-tray.exe
```

Development:

```powershell
dotnet run --project Grayjay.Web.Host -- --port 11400   # prints a pairing code on first run
cd Grayjay.Web.App; npm install; npm run dev             # http://localhost:5173/app/ (proxies to :11400)
```

Server options: `--port`, `--bind`, `--data-dir`, `--app-root`, `--password` (optional password sign-in in addition to pairing), `--no-auth` (only behind an authenticating reverse proxy). Matching `GRAYJAY_*` environment variables are listed in `GrayjayWebServer --help`. The remote login browser honours `GRAYJAY_CHROME_PATH` and `GRAYJAY_REMOTE_BROWSER_HEADFUL=1`.

The server keeps its data in `<AppData>/GrayjayWeb`, separate from Grayjay Desktop's, so both can be installed side by side.

## Security model

- Every route except the app shell and the pairing endpoints needs a device session: an HttpOnly, `SameSite=Strict` cookie whose hash is stored server-side. This includes the API, `/ws`, media and the remote browser.
- New devices join with a one-time, 10-minute, rate-limited pairing code (or an optional password). The tray app signs in the host computer with a per-launch secret. Loopback is never trusted, because tunnels such as Tailscale Serve connect from loopback.
- All media goes through the authenticated main origin (`/hp/<id>`). The internal proxy only listens on loopback.
- Plugins run code on your server: only install sources you trust.

## What was modified

Modified from FUTO's Grayjay Desktop by Mitchell Cairns (2026):

- **Web mode.** Added a headless web mode to `GrayjayServer`: configurable bind address and port, device-pairing auth middleware instead of the CEF window token, PWA hosting, and relative same-origin URLs (`BaseUrl`). `HttpProxy` URLs now route through the main server.
- **Data directory.** Added `Directories.SetBase` so the data directory can be overridden.
- **Additions.** Added `Grayjay.Web.Host`, `Grayjay.Web.App`, `Grayjay.Web.Tray`, `Grayjay.ClientServer/Web` and `Grayjay.ClientServer/RemoteBrowser`.
- **Submodules.** Submodule URLs now point at FUTO's public mirrors.

Modified files are marked with `[GrayjayWeb]` comments.

## License

Grayjay is © FUTO Holdings, Inc., licensed under the **Source First License 1.1** (see [LICENSE.md](LICENSE.md)). This fork is distributed under the same terms: free of charge, **non-commercial use only**, with all licensing, copyright and payment functionality of the original preserved.
