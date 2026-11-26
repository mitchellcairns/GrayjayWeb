// Global playback state. There is exactly one <video> in the app (inside WatchOverlay), so playback survives navigation.
import { batch, createRoot, createSignal } from "solid-js";
import { Content, SourceDescriptor, VideoDetails, details, history as historyApi } from "../api";
import { pickVideoIndex, targetHeight } from "../lib/quality";
import { stored } from "../lib/stored";
import { queue } from "./queue";
export { stored };

export type PlayerMode = "closed" | "full" | "mini";

// ---------- Remembered preferences ----------

export interface MiniRect { x: number; y: number; w: number }

function createPrefs() {
  const [rate, setRate] = stored("gj.rate", 1);
  /** "off", "on" (any track) or a language code. */
  const [captions, setCaptions] = stored("gj.captions", "off");
  /** Floating mini-player geometry; null = default position. */
  const [mini, setMini] = stored<MiniRect | null>("gj.mini", null);
  const [volume, setVolume] = stored("gj.volume", 1);
  const [muted, setMuted] = stored("gj.muted", false);
  /** Audio only: fetch no video (saves data, lets the screen turn off). Remembered, so a podcast queue stays audio. */
  const [audioOnly, setAudioOnly] = stored("gj.audioOnly", false);
  /** Picture-in-picture automatically when you leave the app (or tab) while a video plays. */
  const [popOut, setPopOut] = stored("gj.popOutOnLeave", true);
  return { rate, setRate, captions, setCaptions, mini, setMini, volume, setVolume, muted, setMuted, audioOnly, setAudioOnly, popOut, setPopOut };
}
export const prefs = createRoot(createPrefs);

/**
 * FLIP animation for the player box: measure before a layout change, then animate from the old rect to the new one
 * so full ↔ mini morphs smoothly while the video keeps playing (no snapshot, unlike view transitions).
 */
let playerBox: HTMLElement | null = null;
export function registerPlayerBox(el: HTMLElement | null) { playerBox = el; }
function animateLayoutChange(change: () => void) {
  const el = playerBox;
  const first = el?.getBoundingClientRect();
  change();
  if (!el || !first || first.width === 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Measure after Solid has applied the change (it may be deferred inside effects) but before the next paint.
  requestAnimationFrame(() => {
  const last = el.getBoundingClientRect();
  if (last.width === 0 || last.height === 0) return;
  const dx = first.left - last.left, dy = first.top - last.top;
  const sx = first.width / last.width, sy = first.height / last.height;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01) return;
  el.animate(
    [
      { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: "12px" },
      { transformOrigin: "top left", transform: "none" },
    ],
    { duration: 340, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  );
  });
}

interface NavBridge {
  setWatchParam: (url: string | null, replace: boolean) => void;
  back: () => void;
}

function createPlayerStore() {
  const [mode, setModeRaw] = createSignal<PlayerMode>("closed");
  const setMode = (m: PlayerMode) => { if (m !== mode()) animateLayoutChange(() => setModeRaw(m)); };
  const [url, setUrl] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<Content | null>(null);
  const [video, setVideo] = createSignal<VideoDetails | null>(null);
  const [source, setSource] = createSignal<SourceDescriptor | null>(null);
  const [startAt, setStartAt] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [videoEl, setVideoEl] = createSignal<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = createSignal(false);
  /** True once the current video actually started playing (frames moving), so lower-priority loads can begin. */
  const [started, setStarted] = createSignal(false);
  /**
   * Which video the <video> element's media actually belongs to. While the next video loads, the element still holds
   * the old one: its position must not be saved (or reported to other devices) as the new video's.
   */
  const [mediaUrl, setMediaUrl] = createSignal<string | null>(null);

  let nav: NavBridge | null = null;
  let openedViaPush = false;
  let loadToken = 0;

  async function load(target: string, startOverride?: number) {
    const token = ++loadToken;
    queue.remove(target); // playing something you'd queued takes it off the queue
    batch(() => {
      setLoading(true);
      setError(null);
      setVideo(null);
      setSource(null);
      setStarted(false);
    });
    try {
      const [{ video: v, superseded }, position] = await Promise.all([
        details.videoLoad(target),
        historyApi.position(target).catch(() => 0),
      ]);
      if (token !== loadToken || superseded) return;
      if (!v) throw new Error("This video couldn't be loaded. Its source may need you to sign in (Sources).");
      setVideo(v);
      const duration = v.duration ?? 0;
      // Resume where you left off unless you'd finished it.
      setStartAt(startOverride ?? (position && duration && position < duration - 15 ? position : 0));
      let [src, maxHeight] = await Promise.all([details.sourceAuto(target), targetHeight().catch(() => 0)]);
      if (token !== loadToken) return;
      const vi0 = src.videoIndex ?? -1;
      // Default quality for this device/connection (Settings → Playback quality).
      let vi = vi0 >= 0 && maxHeight > 0 ? pickVideoIndex(v.video?.videoSources ?? [], vi0, maxHeight) : vi0;
      // Turn captions on automatically if you had them on last time (preferring your language).
      let si = src.subtitleIndex ?? -1;
      const pref = prefs.captions();
      const subs = v.subtitles ?? [];
      if (pref !== "off" && subs.length && si < 0 && vi0 >= 0) {
        si = subs.findIndex((s: any) => s.language && s.language === pref);
        if (si < 0 && pref === "on") si = 0;
      }
      if (vi0 >= 0 && (vi !== vi0 || si !== (src.subtitleIndex ?? -1))) {
        try { src = await details.sourceProxy(target, vi, src.audioIndex ?? -1, si); } catch { }
        if (token !== loadToken) return;
      }
      setSource(src);
    } catch (e: any) {
      if (token !== loadToken) return;
      setError(e?.message ?? "Couldn't load this video");
    } finally {
      if (token === loadToken) setLoading(false);
    }
  }

  // iOS only lets media start from a user gesture; poking the element synchronously inside the tap "unlocks" it.
  function unlock() {
    const el = videoEl();
    if (el && el.paused) el.play().then(() => el.pause()).catch(() => { });
  }

  return {
    mode, url, preview, video, source, startAt, loading, error, videoEl, setVideoEl, playing, setPlaying, started, setStarted, mediaUrl, setMediaUrl,

    bindNavigation(bridge: NavBridge) { nav = bridge; },

    /** Open a video full screen (adds ?watch= to the URL so Back minimizes it, like native apps). */
    open(target: string, previewItem?: Content, startAt?: number) {
      if (target !== url()) {
        unlock();
        batch(() => {
          setPreview(previewItem ?? null);
          setUrl(target);
        });
        load(target, startAt);
      } else if (startAt != null) {
        // Already loaded here: jump to the handed-over position.
        const el = videoEl();
        if (el) { el.currentTime = startAt; el.play().catch(() => { }); }
      }
      setMode("full");
      openedViaPush = true;
      nav?.setWatchParam(target, false);
    },

    /**
     * Switch to another video without changing full/mini (queue, autoplay, lock-screen "next"). Opens full screen if
     * nothing is playing. Replaces the ?watch= entry rather than stacking history.
     */
    playNow(target: string, previewItem?: Content, startAt?: number) {
      if (mode() === "closed") { this.open(target, previewItem, startAt); return; }
      if (target !== url()) {
        unlock();
        batch(() => { setPreview(previewItem ?? null); setUrl(target); });
        load(target, startAt);
      } else if (startAt != null) {
        const el = videoEl();
        if (el) { el.currentTime = startAt; el.play().catch(() => { }); }
      }
      if (mode() === "full") nav?.setWatchParam(target, true);
    },

    /** Called when the URL's ?watch= param changes (deep link, back/forward). */
    syncFromUrl(target: string | null) {
      if (target) {
        if (target !== url()) {
          setPreview(null);
          setUrl(target);
          load(target);
        }
        setMode("full");
      } else if (mode() === "full") {
        setMode("mini");
      }
    },

    /**
     * Shrink to the mini-player. `then` runs once the URL no longer has ?watch= (e.g. navigate to a channel): going
     * Back is asynchronous, so navigating straight away would be undone by it.
     */
    minimize(then?: () => void) {
      if (mode() !== "full") { then?.(); return; }
      if (openedViaPush) {
        openedViaPush = false;
        if (then) addEventListener("popstate", () => setTimeout(then, 0), { once: true });
        nav?.back();
      } else {
        nav?.setWatchParam(null, true);
        then?.();
      }
      setMode("mini");
    },

    expand() {
      const u = url();
      if (!u) return;
      setMode("full");
      openedViaPush = true;
      nav?.setWatchParam(u, false);
    },

    close() {
      const el = videoEl();
      el?.pause();
      if (mode() === "full") {
        if (openedViaPush) { openedViaPush = false; nav?.back(); } else nav?.setWatchParam(null, true);
      }
      loadToken++;
      batch(() => {
        setMode("closed");
        setUrl(null);
        setVideo(null);
        setSource(null);
        setPreview(null);
      });
      details.videoClose().catch(() => { });
    },

    retry() { const u = url(); if (u) load(u); },

    /** Switch quality, audio track or captions: asks the server for a new proxied source, keeps position. */
    async selectSource(videoIndex: number, audioIndex: number, subtitleIndex = -1) {
      const u = url(); if (!u) return;
      const el = videoEl();
      setStartAt(el?.currentTime ?? 0);
      try {
        const src = await details.sourceProxy(u, videoIndex, audioIndex, subtitleIndex);
        setSource(src);
      } catch (e: any) {
        setError(e?.message ?? "Couldn't switch tracks");
      }
    },
  };
}

export const player = createRoot(createPlayerStore);
