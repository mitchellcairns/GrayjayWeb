# AGENTS.md — Grayjay Web

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot, …) helping someone **set up, run, troubleshoot or
develop** Grayjay Web. Read this before suggesting commands. Humans: see `README.md`.

Grayjay Web is an unofficial, modified build of FUTO's Grayjay Desktop: a **self-hosted server** (Grayjay's own .NET plugin
engine, run headless) plus a **mobile-first PWA** served by it, plus an optional **Rust tray app** that runs the server on a
desktop. Phones and browsers talk to the server; plugins (YouTube, PeerTube, …) run on the server.

## Ground rules for agents

- **A server is always required.** Browsers can't run Grayjay plugins themselves (CORS, forbidden headers, cross-site
  cookies). Don't propose a "static PWA only" or GitHub Pages deployment.
- **Never handle the user's Google/YouTube password or cookies.** Plugin sign-in happens in the app's own sign-in screen
  (Sources → YouTube → Sign in). Don't script logins, export cookies, or paste credentials anywhere.
- **Don't expose the server without authentication.** Never suggest `--no-auth` / `GRAYJAY_NO_AUTH=1` unless an
  authenticating reverse proxy is in front of it. Don't port-forward 11338 to the internet; prefer Tailscale or WireGuard.
- **License: Source First 1.1, non-commercial only.** Don't help set it up as a paid service, and don't remove the
  "Buy Grayjay"/license functionality.
- **Ask which environment** before giving instructions if it's unclear (see the decision guide). Confirm what the user
  already has: OS, Docker or not, how phones will reach the machine (same Wi-Fi, Tailscale, WireGuard, reverse proxy).
- **Verify with real checks** (the health check, logs) rather than assuming a step worked.

## Decision guide: which setup?

| The user has… | Recommend | Section |
|---|---|---|
| A Windows/macOS/Linux desktop they keep on, and wants it simple | **Tray app** (no Docker, no terminal) | [Desktop](#desktop-tray-app) |
| A home server, NAS (Synology, Unraid, TrueNAS, CasaOS, Umbrel) or Raspberry Pi with Docker | **Prebuilt Docker image** | [Docker](#docker) |
| A Linux server without Docker | **Self-contained binary** under systemd | [Bare Linux](#bare-linux-systemd) |
| They want to modify the code | **Development setup** | [Development](#development) |

Then pick **remote access** (see [Reaching it from phones](#reaching-it-from-phones-and-https)). **HTTPS is required to
*install* the PWA** on phones (Android "Install app", iOS "Add to Home Screen" as a real app with offline shell, wake lock).
Plain `http://192.168.x.x` works for browsing on the home network but can't be installed.

## Facts you'll need

| Thing | Value |
|---|---|
| Web app URL | `http(s)://<host>:11338/app/` (the API is at the root; `/` redirects to `/app/`) |
| Ports | **11338** web app + API (`GRAYJAY_PORT`); **12315** Grayjay Sync (optional, LAN/VPN direct connections) |
| Health check | `GET /auth/Status` → `200 {"authenticated":false,…}` without a session; anything else = not up |
| First-device pairing | The server prints `Pairing code (valid 10 minutes): XXXXXXXX` on startup when no device is paired and it wasn't started by the tray app. Enter it on the phone or open `/app/#pair=CODE`. Later devices: Settings → Pair a phone (QR code) |
| Data directory | Printed at startup as `data directory: …`. Defaults: Windows `%APPDATA%\GrayjayWeb`, Linux `~/.config/GrayjayWeb`, Docker `/data` (volume `grayjay-data`). Separate from Grayjay Desktop's data |
| Tray app logs | Windows `%LOCALAPPDATA%\GrayjayWeb\logs\server.log`; macOS `~/Library/Application Support/GrayjayWeb/logs/`; Linux `~/.local/state/grayjay-web/logs/` |
| Sign-in browser | Needs Chrome, Edge or Chromium on the server machine (bundled in the Docker image) |

### Server options (`GrayjayWebServer --help`)

| Env var | Flag | Purpose |
|---|---|---|
| `GRAYJAY_PORT` | `--port` | Listen port (default 11338) |
| `GRAYJAY_BIND` | `--bind` | Bind address (default `0.0.0.0`; use `127.0.0.1` behind Tailscale Serve or a local reverse proxy) |
| `GRAYJAY_DATA_DIR` | `--data-dir` | Data directory |
| `GRAYJAY_PUBLIC_URLS` | `--public-url` (repeatable) | Address(es) phones use, comma-separated; shown first in pairing QR codes. **Required in Docker** (the container only sees its own network) and recommended for WireGuard/reverse proxies |
| `GRAYJAY_PASSWORD` | `--password` | Optional password sign-in in addition to pairing codes |
| `GRAYJAY_APP_ROOT` | `--app-root` | Built PWA folder (default `./app` next to the binary) |
| `GRAYJAY_LOG_FILE` | `--log-file` | Also write the console output (startup lines, the first pairing code, warnings) to a file. For running as a background service / scheduled task with no console |
| `GRAYJAY_NO_AUTH=1` | `--no-auth` | Disables auth. **Only** behind an authenticating proxy |
| `GRAYJAY_CHROME_PATH` | | Browser used for plugin sign-in |
| `GRAYJAY_REMOTE_BROWSER_NO_SANDBOX=1` | | Needed when Chromium runs as root or in containers (set in the image) |
| `GRAYJAY_REMOTE_BROWSER_PROFILE_DIR` | | Temp profile location (e.g. if snap Chromium can't use `/tmp`) |
| `GRAYJAY_REMOTE_BROWSER_HEADFUL=1` | | Debug: show the sign-in browser as a real window on the server |
| `GRAYJAY_LOCAL_SECRET` | | Set by the tray app; lets the host machine sign in without pairing. Don't set by hand |
| `GRAYJAY_LOCAL_SECRET_FILE` | `--local-secret-file` | Same, for a server run as a service: the secret is kept in (or created in) this file so a shortcut on that machine can open `/auth/Local?secret=…&next=/app/settings%3Fpair%3D1` (signed in, straight to the pairing QR code). Keep the file private |

Tray app: `GRAYJAY_SERVER_PATH` (server binary), `GRAYJAY_PORT`, `GRAYJAY_DATA_DIR`, `GRAYJAY_TRAY_NO_OPEN=1` (don't open the browser on first run).

## Desktop (tray app)

There are no published release downloads yet; build the bundle once on the target OS:

```powershell
# Windows (PowerShell). Needs: .NET 8 SDK, Node 20+, Rust (rustup), Git + Git LFS
git clone --recurse-submodules https://github.com/mitchellcairns/GrayjayWeb.git
cd GrayjayWeb
./build-web.ps1 -Rid win-x64          # → out/GrayjayWeb-win-x64/grayjay-tray.exe
```

- Run `grayjay-tray.exe`. The first launch opens the browser on the pairing QR code; tray menu has *Open Grayjay*, *Pair a phone…*, *Remote access (Tailscale)*, *Start when I sign in*, *Show logs*, *Restart server*.
- macOS (`osx-arm64`/`osx-x64`) and Linux (`linux-x64`/`linux-arm64`) bundles build the same way with PowerShell 7 (`pwsh ./build-web.ps1 -Rid …`). Linux tray builds need `libgtk-3-dev libxdo-dev libayatana-appindicator3-dev`. **The tray app has only been tested on Windows**; on macOS/Linux prefer Docker or [bare Linux](#bare-linux-systemd) if it misbehaves.
- Windows Firewall may prompt the first time; allow *Private networks* so phones on Wi-Fi can connect.
- The tray kills the server when it exits and restarts it if it crashes.

## Docker

Prebuilt multi-arch image (`linux/amd64`, `linux/arm64`): `ghcr.io/mitchellcairns/grayjayweb:latest`, built by
`.github/workflows/docker.yml`. No clone needed:

```bash
mkdir grayjay && cd grayjay
curl -fsSLO https://raw.githubusercontent.com/mitchellcairns/GrayjayWeb/web/docker-compose.yml
mkdir docker && curl -fsSL -o docker/Caddyfile https://raw.githubusercontent.com/mitchellcairns/GrayjayWeb/web/docker/Caddyfile   # only for HTTPS
# edit docker-compose.yml → GRAYJAY_PUBLIC_URLS (see below)
docker compose up -d
docker compose logs grayjay | grep -i "pairing code"
curl -fsS http://127.0.0.1:11338/auth/Status          # health check
```

Update: `docker compose pull && docker compose up -d`. Data lives in the named volume `grayjay-data` (back it up, or use
Settings → *Download a backup*).

Platform notes:
- **Synology (Container Manager) / CasaOS / Portainer / Dockge:** create a "project/stack" from `docker-compose.yml`. Keep the named volume (bind-mounting a root-owned host folder breaks writes; the container runs as uid 1000 — if a bind mount is required, `chown -R 1000:1000` it first).
- **Unraid:** use the Docker Compose Manager plugin with the same file, or add a container from the image with port 11338, `/data` → `/mnt/user/appdata/grayjay`, env `GRAYJAY_PUBLIC_URLS`, and *Extra Parameters* `--shm-size=512m`. Set the appdata folder owner to uid 1000.
- **Raspberry Pi:** 64-bit OS required (arm64). 2 GB RAM minimum, 4 GB recommended.
- Keep `shm_size: 512m` (Chromium for sign-in crashes with Docker's 64 MB default).
- Building from source instead: clone with Git LFS, `git lfs pull --include "Grayjay.ClientServer/deps/linux-x64/**"`, then `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`. The build stops with a clear error if the LFS binaries are missing.

## Bare Linux (systemd)

```bash
# on any machine with the .NET 8 SDK + Node 20 (cross-publishing works from Windows/macOS too)
cd Grayjay.Web.App && npm ci && npm run build && cd ..
dotnet publish Grayjay.Web.Host/Grayjay.Web.Host.csproj -c Release -r linux-x64 --self-contained true -p:JustCefSkipRuntimeDownload=true -o out/linux
# copy out/linux to the server as /opt/grayjay; install chromium (apt install chromium) for plugin sign-in
```

`/etc/systemd/system/grayjay.service`:
```ini
[Unit]
Description=Grayjay Web
After=network-online.target
[Service]
User=grayjay
Environment=GRAYJAY_DATA_DIR=/var/lib/grayjay GRAYJAY_PUBLIC_URLS=http://10.8.0.1:11338
WorkingDirectory=/opt/grayjay
ExecStart=/opt/grayjay/GrayjayWebServer
Restart=on-failure
[Install]
WantedBy=multi-user.target
```
`sudo useradd -r -m grayjay && sudo mkdir -p /var/lib/grayjay && sudo chown grayjay /var/lib/grayjay && sudo systemctl enable --now grayjay`, then `journalctl -u grayjay | grep -i "pairing code"`.

## Reaching it from phones (and HTTPS)

| Situation | What to do |
|---|---|
| Same Wi-Fi only, just trying it | `http://<lan-ip>:11338/app/`. Works, but can't be installed as an app |
| **Tailscale** (recommended for desktops) | Install Tailscale on server + phone, same account; admin console → DNS → enable MagicDNS and **HTTPS Certificates**. Tray: *Remote access → Turn on*. Manually: `tailscale serve --bg --https=443 http://127.0.0.1:11338` → `https://<machine>.<tailnet>.ts.net/app/`. Add that URL to `GRAYJAY_PUBLIC_URLS` for Docker/bare installs |
| **WireGuard** | Phones reach the server's WireGuard IP (e.g. `10.8.0.1`). Set `GRAYJAY_PUBLIC_URLS=http://10.8.0.1:11338`. Make sure the peer's `AllowedIPs` include the server's tunnel IP and the server's firewall allows 11338 on the `wg0` interface. For HTTPS use the Caddy profile below |
| **Reverse proxy** (Caddy, nginx, Traefik, Nginx Proxy Manager) | Proxy everything (not just `/app`) to `:11338`, with WebSocket upgrade, no buffering and no read timeout (media + sign-in stream). Pass `Host` through and set `X-Forwarded-Proto: https`. Set `GRAYJAY_PUBLIC_URLS=https://<domain>` |
| Caddy via compose | `docker compose --profile https up -d` with `GRAYJAY_HOST` set; see `docker/Caddyfile` for real certs (public DNS / DNS-01 for VPN-only boxes) vs `tls internal` (self-signed; trust Caddy's root cert on each phone once) |
| Cloudflare Tunnel | Works (`cloudflared` → `http://localhost:11338`); keep Grayjay's auth on. Note Cloudflare's ToS on video streaming through tunnels. Cloudflare drops requests that take over 100 s to answer: the background-download request answers with a redirect to itself every 80 s while the server is still downloading |

nginx snippet for the proxy row:
```nginx
location / {
  proxy_pass http://127.0.0.1:11338;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_read_timeout 1d;
  client_max_body_size 512m;   # backup uploads
}
```

## After it's running

1. Pair the first device (code from logs / tray opens it), then **Add to Home Screen** (HTTPS) on phones.
2. The first-run setup offers: **Grayjay Sync** (Grayjay Android/Desktop → Settings → Sync → Link new device → scan),
   **Grayjay backup .zip** import (Android *Export*), **YouTube Takeout `subscriptions.csv` / NewPipe `.json`** import,
   source selection, and sign-in, plus *Subscribe to who you follow on …* for sources that can list an account's follows
   (Twitch, YouTube; signs in first if needed). Reopen later from Settings → *Import & sync*.
3. YouTube extras (SponsorBlock, Return YouTube Dislike, DeArrow): Sources → YouTube → Settings.
4. **Downloads / offline:** ⋮ → *Download* (or *Download* on the watch page), pick a quality. The server downloads it into
   `<data dir>/downloads` (Grayjay's own downloader, H.264/AAC preferred so iPhones can play it), joins video + audio
   with the bundled FFmpeg, then the phone copies the file into its own storage (IndexedDB). Downloads are in
   Library → Downloads and play with no connection. Opening the app with the server unreachable offers
   *Watch your downloads*; that needs the installed app over **HTTPS** (the service worker caches the app itself).
   Videos another device downloaded show under *On your server* with *Save here*.
   Downloads don't need the app open: on Chrome/Edge/Brave/Samsung Internet (installed app over HTTPS) the copy to the
   phone is a Background Fetch (`public/bg-fetch-sw.js`), started right away against `/web/downloads/File?wait=1`, which
   the server holds until its download is done. Elsewhere (iPhone, Firefox, plain HTTP) the copy runs while the app is open
   and continues from the last saved 8 MB piece when it's reopened. Server downloads continue from partial files
   (`<file>.partial` markers in the downloads folder) after a dropped connection or a restart.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Tray stuck on "Starting…" / "not responding" | Tray menu → *Show logs*. Usually a port conflict (another app on 11338; set `GRAYJAY_PORT`) or a missing file in a hand-copied bundle. Rebuild with `build-web.ps1` |
| Blank page on a phone | Old build (fixed; update), or the phone can't reach the host: check firewall / same network / VPN. `curl http://<host>:11338/auth/Status` from another machine |
| "This app cannot be installed" / no Install option | Not HTTPS. See [HTTPS](#reaching-it-from-phones-and-https) |
| Pairing code rejected | Codes are single-use and expire after 10 minutes; get a new one (Settings → Pair, or restart for a console code). Too many wrong tries → wait 5 minutes |
| QR code points to the wrong address (e.g. `172.x` in Docker) | Set `GRAYJAY_PUBLIC_URLS` |
| Sign-in screen says no browser found | Install Chrome/Edge/Chromium, or set `GRAYJAY_CHROME_PATH`. Docker image already has it |
| Sign-in crashes in Docker | `shm_size: 512m` missing |
| Google says "This browser or app may not be secure" | Known risk with automated browsers. Retry; or on a desktop server set `GRAYJAY_REMOTE_BROWSER_HEADFUL=1` and sign in in the real window |
| Videos don't play on iPhone | Needs iOS 17.1+ (Managed Media Source) for most YouTube formats |
| Docker build fails with "Git LFS pointer files" | `git lfs install && git lfs pull --include "Grayjay.ClientServer/deps/linux-x64/**"` |
| `docker compose pull` → `denied` | The GHCR package isn't public yet (owner: Package settings → Change visibility → Public), or build from source |
| A download fails or stops at "Downloading on your server" | Check the server log. Sources sometimes drop the connection mid-download; the app retries twice. "FFmpeg isn't available": run the server from its own folder (the bundled `ffmpeg` is found relative to the working directory; set `WorkingDirectory` in systemd) or install ffmpeg on Linux |
| "Not enough storage space on this device" | The phone's browser storage is full; remove downloads (Library → Downloads) or free space. Installed apps get more room than browser tabs, especially on iPhone |
| Import from backup shows problems for some items | Expand "Some items couldn't be imported"; usually videos/channels that no longer exist or a source that isn't enabled |

## Development

```powershell
dotnet run --project Grayjay.Web.Host -- --port 11400 --data-dir ./.devdata   # prints a pairing code
cd Grayjay.Web.App; npm install; npm run dev                                    # http://localhost:5173/app/ (proxies API to :11400; set GRAYJAY_BACKEND to change)
cd Grayjay.Web.Tray; cargo run                                                  # tray (set GRAYJAY_SERVER_PATH)
```

| Path | What |
|---|---|
| `Grayjay.Web.App/` | PWA — SolidJS + Vite + Shaka Player + vite-plugin-pwa. `src/api` typed client, `src/player` (store, VideoPlayer, WatchOverlay), `src/pages`, `src/shell` |
| `Grayjay.Web.Host/` | Headless server entry point (`GrayjayWebServer`) |
| `Grayjay.Web.Tray/` | Rust tray (`tray-icon`, `tao`) |
| `Grayjay.ClientServer/Web/` | Web mode: device auth/pairing, `/hp` media forwarder, setup/import endpoints, backup extras |
| `Grayjay.ClientServer/RemoteBrowser/` | Sign-in browser over CDP, streamed to the PWA; YouTube channel picker |
| everything else | Upstream Grayjay Desktop + submodules (`Grayjay.Engine`, `SyncServer`, `JustCef`, `FUTO.MDNS`) |

Conventions:
- Mark changes to upstream files with `[GrayjayWeb]` comments; keep upstream edits minimal so merges from FUTO stay easy.
- FUTO's submodules (`SyncServer`, `Grayjay.Engine`, …) can't be committed to. Small fixes to them live in
  `Grayjay.Web.Host/UpstreamPatches/` as exact find/replace pairs, applied to the submodule checkout before it compiles in
  every build (dotnet run, build-web.ps1, Docker). A build warning means upstream changed that code: check whether the
  patch is still needed and remove it if FUTO fixed it. A patched submodule shows as modified in `git status`; that's expected.
- Official plugin scripts (Twitch, YouTube, …) are downloaded from FUTO, so fixes to them live in
  `Grayjay.ClientServer/Web/WebPluginPatches.cs` (exact find/replace per plugin ID), applied each time a plugin starts, after
  the engine has checked the original script's signature. The server logs whether each patch applied or no longer matches.
- All media URLs must be same-origin and relative in web mode (`BaseUrl` is `""`; proxy entries are `/hp/{id}`).
- Every non-public route is behind `WebAuthMiddleware`; add new public paths to `WebAuth.IsPublicPath` only deliberately.
- Plain-HTTP LAN origins are not secure contexts: don't use `crypto.randomUUID`, Clipboard, etc. without fallbacks.
- When testing playback in an automated browser, **mute first** (`localStorage.setItem('gj.muted','true')`).
- Check: `npx tsc --noEmit -p Grayjay.Web.App` and `dotnet build Grayjay.Web.Host/Grayjay.Web.Host.csproj`.
