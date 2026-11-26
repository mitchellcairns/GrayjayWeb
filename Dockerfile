# [GrayjayWeb] Self-hosted Grayjay server + PWA in one container.
#
#   git clone --recurse-submodules https://github.com/mitchellcairns/GrayjayWeb.git   (Git LFS required)
#   docker compose up -d --build
#
# Data (plugins, subscriptions, history, paired devices) lives in /data — mount a volume there.
# Plugin sign-in (e.g. YouTube) uses the bundled Chromium, streamed to your phone.

# ---------- 1. PWA ----------
FROM node:22-bookworm-slim AS web
WORKDIR /src/Grayjay.Web.App
COPY Grayjay.Web.App/package.json Grayjay.Web.App/package-lock.json ./
RUN npm ci
COPY Grayjay.Web.App/ ./
RUN npm run build

# ---------- 2. Server (self-contained .NET publish) ----------
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS server
ARG TARGETARCH
WORKDIR /src
COPY . .
COPY --from=web /src/Grayjay.Web.App/dist Grayjay.Web.App/dist
RUN case "$TARGETARCH" in \
      arm64) RID=linux-arm64 ;; \
      *)     RID=linux-x64 ;; \
    esac \
 && dotnet publish Grayjay.Web.Host/Grayjay.Web.Host.csproj -c Release -r $RID --self-contained true -o /out \
 && test -f /out/app/index.html \
 && cp LICENSE.md /out/LICENSE.md

# ---------- 3. Runtime ----------
FROM mcr.microsoft.com/dotnet/runtime-deps:8.0-bookworm-slim
# Chromium + fonts for the remote login browser; tini reaps Chromium's child processes; curl for the health check.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji ca-certificates tini curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 grayjay \
 && mkdir -p /data && chown grayjay:grayjay /data

COPY --from=server --chown=grayjay:grayjay /out /opt/grayjay

ENV GRAYJAY_DATA_DIR=/data \
    GRAYJAY_PORT=11338 \
    GRAYJAY_BIND=0.0.0.0 \
    GRAYJAY_CHROME_PATH=/usr/bin/chromium \
    GRAYJAY_REMOTE_BROWSER_NO_SANDBOX=1 \
    DOTNET_gcServer=0

USER grayjay
WORKDIR /opt/grayjay
VOLUME ["/data"]
# 11338: web app + API.  12315: Grayjay Sync (direct connections from your Grayjay apps on the same network/VPN).
EXPOSE 11338 12315

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${GRAYJAY_PORT}/auth/Status" > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/grayjay/GrayjayWebServer"]
