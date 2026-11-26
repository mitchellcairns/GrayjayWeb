import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";

// The Grayjay server (Grayjay.Web.Host) serves this app at /app and its API at the root.
// In dev, Vite serves /app and proxies everything else (API, /ws, /hp media) to the server.
const backend = process.env.GRAYJAY_BACKEND ?? "http://127.0.0.1:11400";

export default defineConfig({
  base: "/app/",
  plugins: [
    solid(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["favicon.ico", "apple-touch-icon-180x180.png", "logo.svg"],
      manifest: {
        id: "/app/",
        name: "Grayjay Web",
        short_name: "Grayjay",
        description: "Watch content from YouTube, PeerTube, Twitch and more in one app, from your own Grayjay server.",
        start_url: "/app/",
        scope: "/app/",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone"],
        orientation: "any",
        background_color: "#0b0b0d",
        theme_color: "#0b0b0d",
        categories: ["entertainment", "video"],
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // Android: "Share → Grayjay" from the YouTube app or a browser opens the link here.
        share_target: {
          action: "/app/share",
          method: "GET",
          params: { title: "title", text: "text", url: "url" },
        },
        shortcuts: [
          { name: "Subscriptions", url: "/app/subscriptions", icons: [{ src: "pwa-192x192.png", sizes: "192x192" }] },
          { name: "Search", url: "/app/search", icons: [{ src: "pwa-192x192.png", sizes: "192x192" }] },
        ],
      },
      workbox: {
        // App shell only. API responses and media are never cached by the service worker.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        navigateFallback: "/app/index.html",
        navigateFallbackAllowlist: [/^\/app(\/|$)/],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Thumbnails and avatars from content platforms.
            urlPattern: ({ request, sameOrigin }) => !sameOrigin && request.destination === "image",
            handler: "CacheFirst",
            options: {
              cacheName: "images",
              expiration: { maxEntries: 600, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "^/(?!app(/|$)|@|node_modules|src/).*": { target: backend, ws: true, changeOrigin: false },
    },
  },
  build: {
    target: ["es2022", "safari16"],
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
