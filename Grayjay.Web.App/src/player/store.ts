// Global playback state. There is exactly one <video> in the app (inside WatchOverlay), so playback survives navigation.
import { batch, createRoot, createSignal } from "solid-js";
import { Content, SourceDescriptor, VideoDetails, details, history as historyApi } from "../api";

export type PlayerMode = "closed" | "full" | "mini";

// ---------- Remembered preferences ----------
function stored<T>(key: string, fallback: T) {
  let initial = fallback;
  try { const v = localStorage.getItem(key); if (v != null) initial = JSON.parse(v); } catch { }
  const [get, set] = createSignal<T>(initial);
  return [get, (v: T) => { set(() => v); try { localStorage.setItem(key, JSON.stringify(v)); } catch { } }] as const;
}

export interface MiniRect { x: number; y: number; w: number }

function createPrefs() {
  const [rate, setRate] = stored("gj.rate", 1);
  /** "off", "on" (any track) or a language code. */
  const [captions, setCaptions] = stored("gj.captions", "off");
  /** Floating mini-player geometry; null = default position. */
  const [mini, setMini] = stored<MiniRect | null>("gj.mini", null);
  const [volume, setVolume] = stored("gj.volume", 1);
  const [muted, setMuted] = stored("gj.muted", false);
  return { rate, setRate, captions, setCaptions, mini, setMini, volume, setVolume, muted, setMuted };
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

  let nav: NavBridge | null = null;
  let openedViaPush = false;
  let loadToken = 0;

  async function load(target: string) {
    const token = ++loadToken;
    batch(() => {
      setLoading(true);
      setError(null);
      setVideo(null);
      setSource(null);
    });
    try {
      const [{ video: v, superseded }, position] = await Promise.all([
        details.videoLoad(target),
        historyApi.position(target).catch(() => 0),
      ]);
      if (token !== loadToken || superseded) return;
      setVideo(v);
      const duration = v.duration ?? 0;
      // Resume where you left off unless you'd finished it.
      setStartAt(position && duration && position < duration - 15 ? position : 0);
      let src = await details.sourceAuto(target);
      if (token !== loadToken) return;
      // Turn captions on automatically if you had them on last time (preferring your language).
      const pref = prefs.captions();
      const subs = v.subtitles ?? [];
      if (pref !== "off" && subs.length && (src.subtitleIndex ?? -1) < 0 && (src.videoIndex ?? -1) >= 0) {
        let si = subs.findIndex((s: any) => s.language && s.language === pref);
        if (si < 0 && pref === "on") si = 0;
        if (si >= 0) {
          try { src = await details.sourceProxy(target, src.videoIndex!, src.audioIndex ?? -1, si); } catch { }
          if (token !== loadToken) return;
        }
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
    mode, url, preview, video, source, startAt, loading, error, videoEl, setVideoEl, playing, setPlaying,

    bindNavigation(bridge: NavBridge) { nav = bridge; },

    /** Open a video full screen (adds ?watch= to the URL so Back minimizes it, like native apps). */
    open(target: string, previewItem?: Content) {
      if (target !== url()) {
        unlock();
        batch(() => {
          setPreview(previewItem ?? null);
          setUrl(target);
        });
        load(target);
      }
      setMode("full");
      openedViaPush = true;
      nav?.setWatchParam(target, false);
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

    minimize() {
      if (mode() !== "full") return;
      if (openedViaPush) {
        openedViaPush = false;
        nav?.back();
      } else {
        nav?.setWatchParam(null, true);
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
