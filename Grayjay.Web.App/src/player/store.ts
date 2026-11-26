// Global playback state. There is exactly one <video> in the app (inside WatchOverlay), so playback survives navigation.
import { batch, createRoot, createSignal } from "solid-js";
import { Content, SourceDescriptor, VideoDetails, details, history as historyApi } from "../api";

export type PlayerMode = "closed" | "full" | "mini";

interface NavBridge {
  setWatchParam: (url: string | null, replace: boolean) => void;
  back: () => void;
}

function createPlayerStore() {
  const [mode, setMode] = createSignal<PlayerMode>("closed");
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
      const src = await details.sourceAuto(target);
      if (token !== loadToken) return;
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

    /** Switch quality/audio track: asks the server for a new proxied source, keeps position. */
    async selectSource(videoIndex: number, audioIndex: number) {
      const u = url(); if (!u) return;
      const el = videoEl();
      setStartAt(el?.currentTime ?? 0);
      const src = await details.sourceProxy(u, videoIndex, audioIndex);
      setSource(src);
    },
  };
}

export const player = createRoot(createPlayerStore);
