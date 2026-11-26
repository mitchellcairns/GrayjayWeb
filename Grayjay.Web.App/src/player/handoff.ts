// Move playback between your devices.
// Each device reports what it's playing (on play/pause/seek/new video, and every 15 s while playing). Other devices
// show a "Continue here" button for it, extrapolating the position from the report time; continuing on another device
// pauses this one.
import { createEffect, createRoot, createSignal, on as watch } from "solid-js";
import { DeviceCommand, NowPlayingState, deviceSync } from "../api";
import { on } from "../api/socket";
import { bestThumbnail } from "../lib/format";
import { self } from "../lib/self";
import { toast } from "../components/Toasts";
import { player, prefs } from "./store";

export type RemotePlayback = NowPlayingState & { at: number };

const guessName = () => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Mac/.test(ua)) return "Mac";
  return "Browser";
};

export const handoff = createRoot(() => {
  const [others, setOthers] = createSignal<RemotePlayback[]>([]);

  // ---------- What other devices are playing ----------
  const refresh = async () => {
    try {
      await self.ready;
      const r = await deviceSync.nowPlaying();
      const serverNow = Date.parse(r.now);
      setOthers(r.devices
        .filter((d) => d.deviceId !== self.id() && d.deviceId !== self.clientId && d.url)
        // Convert the server timestamp to local time (no clock-skew issues between devices).
        .map((d) => ({ ...d, at: Date.now() - Math.max(0, serverNow - Date.parse(d.updatedAt)) })));
    } catch { }
  };
  refresh();
  on("NowPlayingChanged", () => refresh());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });

  const positionOf = (d: RemotePlayback) => {
    const p = d.playing ? d.position + (Date.now() - d.at) / 1000 : d.position;
    return d.duration > 0 ? Math.min(p, Math.max(0, d.duration - 1)) : p;
  };

  // ---------- Reporting this device ----------
  const payload = (heartbeat: boolean) => {
    const el = player.videoEl();
    const v = player.video() ?? player.preview();
    return {
      clientId: self.clientId, deviceName: guessName(), heartbeat,
      url: player.mode() === "closed" ? undefined : player.url() ?? undefined,
      name: v?.name, thumbnail: bestThumbnail(v?.thumbnails, 480), author: v?.author?.name,
      position: el && isFinite(el.currentTime) && player.mediaUrl() === player.url() ? el.currentTime : 0,
      duration: el && isFinite(el.duration) ? el.duration : v?.duration ?? 0,
      playing: player.playing(), audioOnly: prefs.audioOnly(),
    };
  };
  let reportedSomething = false;
  const report = (heartbeat = false) => {
    const p = payload(heartbeat);
    if (!p.url && !reportedSomething) return;
    reportedSomething = !!p.url;
    deviceSync.report(p).catch(() => { });
  };
  createEffect(watch([player.url, player.playing, player.mode, player.started], () => report(false), { defer: true }));
  setInterval(() => { if (player.playing()) report(true); }, 15000);
  let seekTimer: number | undefined;
  const onSeeked = () => { clearTimeout(seekTimer); seekTimer = window.setTimeout(() => report(false), 800); };
  createEffect(watch(player.videoEl, (el, prev) => {
    prev?.removeEventListener("seeked", onSeeked);
    el?.addEventListener("seeked", onSeeked);
  }));
  // Leaving the page (closing the tab, locking an iPhone): save the exact position so another device can continue.
  addEventListener("pagehide", () => {
    if (!player.url() || player.mode() === "closed") return;
    try { navigator.sendBeacon("/web/nowplaying", new Blob([JSON.stringify({ ...payload(false), playing: false })], { type: "application/json" })); } catch { }
  });

  // ---------- Commands from other devices ----------
  on("DeviceCommand", (p) => {
    const c = p.payload as DeviceCommand;
    if (!c || (c.targetId !== self.id() && c.targetId !== self.clientId)) return;
    if (c.kind === "pause") {
      const el = player.videoEl();
      if (el && !el.paused) { el.pause(); toast(`Continued on ${c.fromName ?? "your other device"}`); }
    }
  });

  return {
    others,
    positionOf,
    refresh,
    /** Pick up another device's video here, at its current position, and pause it there. */
    continueHere(d: RemotePlayback) {
      if (d.playing) deviceSync.command({ clientId: self.clientId, targetId: d.deviceId, kind: "pause" }).catch(() => { });
      player.open(d.url!, { contentType: 1, url: d.url!, name: d.name, thumbnails: d.thumbnail ? { sources: [{ url: d.thumbnail, quality: 480 }] } : undefined } as any, positionOf(d));
    },
  };
});
