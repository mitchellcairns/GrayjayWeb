import { For, JSX, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import type { SourceDescriptor, VideoDetails } from "../api";
import { details as detailsApi } from "../api";
import { bestThumbnail, formatDuration } from "../lib/format";
import Icon from "../components/Icon";
import { player, prefs } from "./store";
import { QueueButton } from "../components/GlobalSheets";
import { consumeSuppressedTap } from "./gesture";
import { toast } from "../components/Toasts";
import "./VideoPlayer.css";

// Shaka (~900 KB) is only fetched the first time something plays.
let shakaModule: Promise<any> | null = null;
function loadShaka() {
  shakaModule ??= import("shaka-player/dist/shaka-player.compiled.js").then((m) => {
    const shaka = m.default;
    shaka.polyfill.installAll();
    return shaka;
  });
  return shakaModule;
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const canElementFullscreen = !!(document.fullscreenEnabled || (document as any).webkitFullscreenEnabled) && !/iPhone|iPod/.test(navigator.userAgent);
const finePointer = matchMedia("(pointer: fine)").matches;
/**
 * Installed app on Android: Chrome's Fullscreen API shows an "<address> is now full screen. Drag from top and swipe…"
 * message that can get stuck in installed web apps. There the player fills the app window itself instead (the app is
 * already chrome-less), and turning the phone sideways enters/leaves it automatically, like a native player.
 */
const appFullscreenMode = /Android/.test(navigator.userAgent) &&
  (matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches || matchMedia("(display-mode: minimal-ui)").matches);
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function isStreamType(type?: string) {
  return !!type && (type.includes("dash") || type.includes("mpegurl") || type.includes("m3u8"));
}

const languageNames = (() => { try { return new Intl.DisplayNames(undefined, { type: "language" }); } catch { return null; } })();
function languageName(code?: string) {
  if (!code || code === "Unknown") return "";
  try { return languageNames?.of(code) ?? code; } catch { return code; }
}
function codecName(codec?: string, container?: string) {
  const c = (codec ?? "").toLowerCase();
  if (c.startsWith("mp4a")) return "AAC";
  if (c.includes("opus")) return "Opus";
  if (c.includes("ac-3") || c.includes("ac3")) return "Dolby";
  if (c.includes("ec-3")) return "Dolby+";
  return codec || container || "Audio";
}

type Menu = "captions" | "audio" | "speed" | "quality" | null;

/** Grayjay chapter types: 0 normal, 5 skippable (offer a button), 6 skip (always), 7 skip once. SponsorBlock uses 5–7. */
interface Chapter { name: string; type: number; timeStart: number; timeEnd: number }
const SEGMENT_COLORS: Record<string, string> = {
  sponsor: "#00d400", selfpromo: "#ffff00", "self-promo": "#ffff00", "self promotion": "#ffff00", intro: "#00ffff", intermission: "#00ffff",
  outro: "#0202ed", endcards: "#0202ed", interaction: "#cc00ff", preview: "#008fd6", recap: "#008fd6", "music": "#ff9900", offtopic: "#ff9900", filler: "#7300ff",
};
const SEGMENT_NAMES: Record<string, string> = {
  sponsor: "sponsor", selfpromo: "self-promotion", intro: "intro", outro: "outro", interaction: "reminder", preview: "preview",
  music_offtopic: "non-music section", filler: "filler", poi_highlight: "highlight", exclusive_access: "exclusive access",
};
export function segmentName(name: string) {
  const n = (name ?? "").toLowerCase().trim();
  return SEGMENT_NAMES[n] ?? (n || "segment");
}
function segmentColor(name: string) {
  const n = name.toLowerCase();
  const key = Object.keys(SEGMENT_COLORS).find((k) => n.includes(k));
  return key ? SEGMENT_COLORS[key] : "#00d400";
}

export default function VideoPlayer(props: {
  source: SourceDescriptor | null;
  video: VideoDetails | null;
  startAt: number;
  poster?: string;
  mini: boolean;
  loading: boolean;
  error: string | null;
  onEnded?: () => void;
  /** Skip to the next queued / Up next video (also the lock-screen "next" button). */
  onNext?: () => void;
  nextTitle?: string;
  /** Back to the video before the last Next. */
  onPrevious?: () => void;
  previousTitle?: string;
}) {
  let container!: HTMLDivElement;
  let el!: HTMLVideoElement;
  let bar!: HTMLDivElement;
  let shakaPlayer: any = null;

  const [playing, setPlaying] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [buffered, setBuffered] = createSignal(0);
  const [controls, setControls] = createSignal(true);
  const [needsTap, setNeedsTap] = createSignal(false);
  const [playError, setPlayError] = createSignal<string | null>(null);
  const [scrub, setScrub] = createSignal<number | null>(null);
  // After releasing the seek bar, hold the playhead at the target until the seek lands (no snapping back).
  const [seekTarget, setSeekTarget] = createSignal<number | null>(null);
  const [hover, setHover] = createSignal<{ x: number; t: number } | null>(null);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [menu, setMenu] = createSignal<Menu>(null);
  const [rate, setRate] = createSignal(prefs.rate());
  const [volume, setVolume] = createSignal(prefs.volume());
  const [muted, setMuted] = createSignal(prefs.muted());
  const [seekHint, setSeekHint] = createSignal<{ side: "left" | "right"; n: number } | null>(null);

  onMount(() => {
    // Volume and mute are remembered between videos and sessions.
    el.volume = Math.max(0, Math.min(1, prefs.volume()));
    el.muted = prefs.muted();
    player.setVideoEl(el);
  });
  onCleanup(() => { player.setVideoEl(null); shakaPlayer?.destroy(); });

  // ---------- Loading sources ----------
  async function ensureShaka() {
    const shaka = await loadShaka();
    if (!shakaPlayer) {
      shakaPlayer = new shaka.Player();
      await shakaPlayer.attach(el);
      shakaPlayer.configure({
        streaming: { bufferingGoal: 40, rebufferingGoal: 1.5, bufferBehind: 30, retryParameters: { maxAttempts: 4, baseDelay: 500, timeout: 30000 } },
        manifest: { retryParameters: { maxAttempts: 3, timeout: 30000 } },
        abr: { enabled: true },
      });
      shakaPlayer.addEventListener("error", (e: any) => {
        console.error("shaka", e.detail);
        setPlayError(`Playback error (${e.detail?.code ?? "unknown"})`);
      });
    }
    return shakaPlayer;
  }

  const [usingShaka, setUsingShaka] = createSignal(false);
  createEffect(on(() => props.source, (src) => {
    const wasPaused = el.currentTime > 0 && el.paused && !el.ended;
    loadSource(src, props.startAt || 0, !wasPaused);
  }));

  async function loadSource(src: SourceDescriptor | null, start: number, autoplay: boolean) {
    setPlayError(null);
    setNeedsTap(false);
    setSeekTarget(null);
    if (!src) return;
    try {
      if (isStreamType(src.type)) {
        const nativeHls = src.type.includes("mpegurl") && el.canPlayType("application/vnd.apple.mpegurl") && isIOS;
        if (nativeHls) {
          setUsingShaka(false);
          await shakaPlayer?.unload();
          el.src = src.url;
          el.currentTime = start;
        } else {
          const shaka = await loadShaka();
          if (!shaka.Player.isBrowserSupported()) {
            setPlayError("This browser can't play adaptive streams. On iPhone, update to iOS 17.1 or later.");
            return;
          }
          // Managed Media Source (iOS 17.1+) requires remote playback to be disabled or an AirPlay alternative.
          if ((window as any).ManagedMediaSource && !(window as any).MediaSource) el.disableRemotePlayback = true;
          const p = await ensureShaka();
          // Audio only: Shaka skips the video streams entirely (no video data fetched). Audio is small, so buffer
          // minutes ahead: browsers may throttle network for a page whose screen is off.
          const audioOnly = prefs.audioOnly();
          p.configure({ manifest: { disableVideo: audioOnly }, streaming: { bufferingGoal: audioOnly ? 300 : 40 } });
          setUsingShaka(true);
          await p.load(src.url, start, src.type);
          // Captions arrive as a text track inside the server's DASH manifest.
          const hasCaptions = (src.subtitleIndex ?? -1) >= 0;
          const tracks = p.getTextTracks?.() ?? [];
          if (hasCaptions && tracks.length) p.selectTextTrack(tracks[0]);
          p.setTextTrackVisibility?.(hasCaptions);
        }
      } else {
        setUsingShaka(false);
        await shakaPlayer?.unload();
        el.src = src.url;
        el.addEventListener("loadedmetadata", () => { if (start) el.currentTime = start; }, { once: true });
      }
      el.playbackRate = rate();
      if (autoplay) await play();
    } catch (e: any) {
      console.error("load", e);
      setPlayError(e?.message ? `Couldn't start playback: ${e.message}` : `Couldn't start playback (${e?.code ?? "error"})`);
    }
  }

  // ---------- Audio only ----------
  // Switching reloads the same stream with or without video at the current position (a second or so of rebuffering).
  const toggleAudioOnly = async () => {
    const next = !prefs.audioOnly();
    prefs.setAudioOnly(next);
    toast(next ? "Audio only: the screen can turn off" : "Video on", "info", 2000);
    if (!usingShaka() || !props.source) return; // direct files: video can't be dropped, only hidden
    const t = seekTarget() ?? el.currentTime;
    const resume = !el.paused || waiting();
    await loadSource(props.source, t, resume);
  };

  async function play() {
    try {
      await el.play();
      setNeedsTap(false);
    } catch (e: any) {
      if (e?.name === "NotAllowedError") setNeedsTap(true);
    }
  }
  const toggle = () => (el.paused ? play() : el.pause());

  // ---------- Smooth time (rAF while playing; timeupdate only fires ~4×/s) ----------
  let raf = 0;
  const tick = () => {
    setTime(el.currentTime);
    raf = requestAnimationFrame(tick);
  };
  createEffect(on(playing, (p) => {
    cancelAnimationFrame(raf);
    if (p) raf = requestAnimationFrame(tick);
  }));
  onCleanup(() => cancelAnimationFrame(raf));

  const updateBuffered = () => {
    const b = el.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= el.currentTime + 0.5 && b.end(i) >= el.currentTime) { setBuffered(b.end(i)); return; }
  };

  // ---------- Controls visibility ----------
  let hideTimer: number | undefined;
  const poke = () => {
    setControls(true);
    clearTimeout(hideTimer);
    if (!el.paused) hideTimer = window.setTimeout(() => { if (!menu() && scrub() == null) setControls(false); }, 3000);
  };
  createEffect(on(playing, (p) => { if (p) poke(); else { clearTimeout(hideTimer); setControls(true); } }));
  createEffect(on(menu, (m) => { if (!m) poke(); }));

  // ---------- Tap / double-tap ----------
  let lastTap = 0, lastSide: "left" | "right" | "center" = "center", singleTapTimer: number | undefined, hintTimer: number | undefined;
  const onSurfaceTap = (e: PointerEvent) => {
    if (consumeSuppressedTap()) return;
    if (menu()) { setMenu(null); return; }
    if (e.pointerType === "mouse") { toggle(); poke(); return; }
    const rect = container.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const side = x < 0.35 ? "left" : x > 0.65 ? "right" : "center";
    const now = performance.now();
    if (now - lastTap < 300 && side === lastSide && side !== "center") {
      clearTimeout(singleTapTimer);
      seekBy(side === "left" ? -10 : 10);
      const prev = seekHint();
      setSeekHint({ side, n: prev?.side === side ? prev.n + 10 : 10 });
      clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => setSeekHint(null), 650);
      lastTap = now;
      return;
    }
    lastTap = now; lastSide = side;
    clearTimeout(singleTapTimer);
    singleTapTimer = window.setTimeout(() => { if (controls()) setControls(false); else poke(); }, side === "center" ? 0 : 260);
  };
  const seekTo = (t: number) => {
    const d = el.duration || duration() || 0;
    const target = Math.max(0, Math.min(d > 0 ? d - 0.25 : t, t));
    setSeekTarget(target);
    el.currentTime = target;
    setTime(target);
  };
  const seekBy = (d: number) => { seekTo((seekTarget() ?? el.currentTime) + d); poke(); };

  // ---------- Chapters & SponsorBlock segments ----------
  const [chapters] = createResource(() => (props.video ? player.url() : null), async (u) => {
    try {
      const list = await detailsApi.chapters(u!);
      return (list ?? []).map((c: any) => ({ name: c.name ?? "", type: Number(c.type) || 0, timeStart: Number(c.timeStart) || 0, timeEnd: Number(c.timeEnd) || 0 }))
        .filter((c: Chapter) => c.timeEnd > c.timeStart) as Chapter[];
    } catch { return [] as Chapter[]; }
  });
  const segments = () => (chapters() ?? []).filter((c) => c.type >= 5);
  const skippedOnce = new Set<string>();
  createEffect(on(() => player.url(), () => skippedOnce.clear()));
  const activeSegment = createMemo(() => {
    const t = time();
    return segments().find((c) => t >= c.timeStart && t < c.timeEnd - 0.3) ?? null;
  });
  createEffect(on(activeSegment, (seg) => {
    if (!seg || scrub() != null) return;
    const key = `${seg.timeStart}-${seg.name}`;
    if (seg.type === 6 || (seg.type === 7 && !skippedOnce.has(key))) {
      skippedOnce.add(key);
      seekTo(seg.timeEnd);
      toast(`Skipped ${segmentName(seg.name)}`);
    }
  }));
  const chapterAt = (t: number) => (chapters() ?? []).find((c) => c.type === 0 && t >= c.timeStart && t < c.timeEnd)?.name;

  // ---------- Seek bar ----------
  const posFromX = (clientX: number) => {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (duration() || 0);
  };
  const onBarDown = (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try { bar.setPointerCapture(e.pointerId); } catch { }
    setScrub(posFromX(e.clientX));
    setMenu(null);
    poke();
  };
  const onBarMove = (e: PointerEvent) => {
    const t = posFromX(e.clientX);
    if (scrub() != null) { setScrub(t); poke(); }
    if (e.pointerType === "mouse" || scrub() != null) {
      const r = bar.getBoundingClientRect();
      setHover({ x: Math.max(24, Math.min(r.width - 24, e.clientX - r.left)), t });
    }
  };
  const onBarUp = (e: PointerEvent) => {
    if (scrub() == null) return;
    seekTo(posFromX(e.clientX));
    setScrub(null);
    if (e.pointerType !== "mouse") setHover(null);
    poke();
  };
  const onBarKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); seekBy(-5); }
    if (e.key === "ArrowRight") { e.preventDefault(); seekBy(5); }
  };

  // ---------- Fullscreen / PiP ----------
  const inNativeFs = () => !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
  const [appFs, setAppFs] = createSignal(false);
  let appFsByRotation = false;
  // Full-window mode adds a history entry, so Android's Back gesture leaves fullscreen instead of shrinking the player.
  let fsHistory = false;
  const setAppFullscreen = async (on: boolean, byRotation = false) => {
    if (on === appFs()) return;
    appFsByRotation = on && byRotation;
    setAppFs(on);
    setFullscreen(on || inNativeFs());
    poke();
    if (on && !fsHistory) { history.pushState({ ...(history.state ?? {}), gjFullscreen: true }, ""); fsHistory = true; }
    else if (!on && fsHistory) { fsHistory = false; if (history.state?.gjFullscreen) history.back(); }
    try {
      if (on && !byRotation && el.videoWidth >= el.videoHeight) await (screen.orientation as any)?.lock?.("landscape");
      else if (!on) (screen.orientation as any)?.unlock?.();
    } catch { } // not allowed outside the Fullscreen API on some versions: rotating the phone still works
  };
  const onPopState = () => {
    if (appFs() && !history.state?.gjFullscreen) { fsHistory = false; setAppFullscreen(false); }
  };
  addEventListener("popstate", onPopState);
  onCleanup(() => removeEventListener("popstate", onPopState));
  if (appFullscreenMode) {
    const landscape = matchMedia("(orientation: landscape)");
    const onRotate = () => {
      // Real fullscreen rotates the screen itself: that must not also switch on the full-window mode.
      if (props.mini || player.mode() !== "full" || inNativeFs()) return;
      if (landscape.matches && !appFs() && el.videoWidth >= el.videoHeight) setAppFullscreen(true, true);
      else if (!landscape.matches && appFs() && appFsByRotation) setAppFullscreen(false);
    };
    landscape.addEventListener("change", onRotate);
    onCleanup(() => landscape.removeEventListener("change", onRotate));
  }
  createEffect(on(() => props.mini, (m) => { if (m && appFs()) setAppFullscreen(false); }));

  const toggleFullscreen = async () => {
    const d = document as any;
    // Leaving: whichever kind is on (both, if something left them stacked).
    if (inNativeFs()) {
      if (appFs()) await setAppFullscreen(false);
      await (document.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
      return;
    }
    if (appFs()) { await setAppFullscreen(false); return; }
    // Entering. Installed Android app: full-window, unless "Pop out when leaving the app" is on (Android only pops out
    // a video that's in real fullscreen).
    if (appFullscreenMode && !prefs.popOut()) { await setAppFullscreen(true); return; }
    if (canElementFullscreen) {
      await (container.requestFullscreen?.({ navigationUI: "hide" }) ?? (container as any).webkitRequestFullscreen?.());
      try {
        if (el.videoWidth >= el.videoHeight) await (screen.orientation as any)?.lock?.("landscape");
      } catch { }
    } else {
      (el as any).webkitEnterFullscreen?.(); // iPhone: native fullscreen player
    }
  };
  const onFsChange = () => setFullscreen(inNativeFs() || appFs());
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  onCleanup(() => {
    document.removeEventListener("fullscreenchange", onFsChange);
    document.removeEventListener("webkitfullscreenchange", onFsChange);
  });

  const pipSupported = () => !!(document.pictureInPictureEnabled || (el as any)?.webkitSupportsPresentationMode?.("picture-in-picture"));
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (el.requestPictureInPicture) await el.requestPictureInPicture();
      else (el as any).webkitSetPresentationMode?.((el as any).webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
    } catch (e) { console.warn("pip", e); }
  };

  // ---------- Media Session (lock screen / notification / headset controls) ----------
  createEffect(() => {
    const v = props.video;
    if (!("mediaSession" in navigator) || !v) return;
    const art = bestThumbnail(v.thumbnails, 480);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: v.name,
      artist: v.author?.name ?? "",
      album: v.id?.platform ?? "Grayjay",
      artwork: art ? [{ src: art, sizes: "480x360", type: "image/jpeg" }] : [],
    });
    const ms = navigator.mediaSession;
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, h); } catch { } };
    set("play", () => play());
    set("pause", () => el.pause());
    set("seekbackward", (d) => seekBy(-(d.seekOffset ?? 10)));
    set("seekforward", (d) => seekBy(d.seekOffset ?? 10));
    set("seekto", (d) => { if (d.seekTime != null) seekTo(d.seekTime); });
    set("stop", () => player.close());
    set("nexttrack", props.onNext ? () => props.onNext!() : null);
    // Automatic picture-in-picture when you switch away (Chrome/Edge desktop call this; others ignore it).
    set("enterpictureinpicture" as MediaSessionAction, prefs.popOut() && !prefs.audioOnly()
      ? async () => { try { await el.requestPictureInPicture(); } catch { } } : null);
    // Like a music player: restart this video, or (in its first seconds) go back to the previous one.
    set("previoustrack", () => { if (props.onPrevious && el.currentTime < 5) props.onPrevious(); else seekTo(0); });
  });
  const updatePositionState = () => {
    if (!("mediaSession" in navigator) || !isFinite(el.duration) || el.duration <= 0) return;
    try { navigator.mediaSession.setPositionState({ duration: el.duration, position: Math.min(el.currentTime, el.duration), playbackRate: el.playbackRate }); } catch { }
  };

  // Safari (iPhone/iPad/Mac) and installed Chrome apps: pop out on their own when you leave while it plays.
  createEffect(() => {
    const on = prefs.popOut() && !prefs.audioOnly();
    (el as any).autoPictureInPicture = on;
    el.toggleAttribute("autopictureinpicture", on);
  });

  // ---------- Screen Wake Lock while playing ----------
  let wakeLock: any = null;
  const syncWakeLock = async () => {
    // Audio only: no screen wake lock, so the screen can turn off while it keeps playing.
    const want = playing() && document.visibilityState === "visible" && !prefs.audioOnly();
    try {
      if (want && !wakeLock && (navigator as any).wakeLock) {
        wakeLock = await (navigator as any).wakeLock.request("screen");
        wakeLock.addEventListener?.("release", () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release(); wakeLock = null;
      }
    } catch { wakeLock = null; }
  };
  createEffect(on([playing, prefs.audioOnly], syncWakeLock));
  document.addEventListener("visibilitychange", syncWakeLock);
  onCleanup(() => { document.removeEventListener("visibilitychange", syncWakeLock); wakeLock?.release?.(); });

  // ---------- Watch progress (history / resume) ----------
  let lastReport = 0;
  const reportProgress = (force = false) => {
    const u = player.url();
    if (!u || !isFinite(el.currentTime) || el.currentTime < 1) return;
    const now = Date.now();
    if (!force && now - lastReport < 10000) return;
    lastReport = now;
    detailsApi.watchProgress(u, el.currentTime).catch(() => { });
  };
  const onPageHide = () => reportProgress(true);
  addEventListener("pagehide", onPageHide);
  onCleanup(() => removeEventListener("pagehide", onPageHide));

  // ---------- Keyboard ----------
  const onKey = (e: KeyboardEvent) => {
    if (player.mode() !== "full" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    switch (e.key) {
      case " ": case "k": e.preventDefault(); toggle(); poke(); break;
      case "ArrowLeft": case "j": e.preventDefault(); seekBy(e.key === "j" ? -10 : -5); break;
      case "ArrowRight": case "l": e.preventDefault(); seekBy(e.key === "l" ? 10 : 5); break;
      case "f": e.preventDefault(); toggleFullscreen(); break;
      case "m": el.muted = !el.muted; poke(); break;
      case "c": toggleCaptions(); break;
      case "i": togglePip(); break;
      case "a": toggleAudioOnly(); break;
      case "N": props.onNext?.(); break;
      case "P": props.onPrevious?.(); break;
      case ">": setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(rate()) + 1)] ?? 1); break;
      case "<": setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(rate()) - 1)] ?? 1); break;
      case "Escape": if (menu()) setMenu(null); break;
    }
  };
  addEventListener("keydown", onKey);
  onCleanup(() => removeEventListener("keydown", onKey));

  // ---------- Tracks: quality, audio, captions, speed ----------
  const currentVideoIndex = () => props.source?.videoIndex ?? -1;
  const currentAudioIndex = () => props.source?.audioIndex ?? -1;
  const currentSubtitleIndex = () => props.source?.subtitleIndex ?? -1;

  const qualities = createMemo(() => {
    const sources = (props.video?.video?.videoSources ?? []).map((s: any, i: number) => ({ ...s, index: i }));
    const seen = new Set<string>();
    return sources
      .filter((s: any) => s.height || s.name)
      .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0) || (a.container?.includes("mp4") ? -1 : 1))
      .filter((s: any) => { const k = `${s.height}-${s.fps ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
  });
  const qualityLabel = (s: any) => (s?.height ? `${s.height}p${s.fps && s.fps > 30 ? s.fps : ""}` : s?.name ?? "Auto");
  const currentQuality = () => {
    const vi = currentVideoIndex();
    return vi >= 0 ? qualityLabel(props.video?.video?.videoSources?.[vi]) : "Auto";
  };

  const audioTracks = createMemo(() => {
    const list = (props.video?.video?.audioSources ?? []).map((s: any, i: number) => ({ ...s, index: i }));
    const multiLanguage = new Set(list.map((s: any) => s.language).filter((l: string) => l && l !== "Unknown")).size > 1;
    return list
      .map((s: any) => ({
        index: s.index,
        label: multiLanguage
          ? `${languageName(s.language) || s.name}${s.original ? " (original)" : ""}`
          : `${codecName(s.codec, s.container)}${s.bitrate ? ` · ${Math.round(s.bitrate / 1000)} kbps` : ""}`,
        sub: multiLanguage ? `${codecName(s.codec, s.container)}${s.bitrate ? ` · ${Math.round(s.bitrate / 1000)} kbps` : ""}` : "",
        bitrate: s.bitrate ?? 0,
        language: s.language,
      }))
      .sort((a: any, b: any) => (a.language ?? "").localeCompare(b.language ?? "") || b.bitrate - a.bitrate);
  });

  const captionTracks = createMemo(() => (props.video?.subtitles ?? []).map((s: any, i: number) => ({
    index: i,
    label: s.name || languageName(s.language) || `Track ${i + 1}`,
    language: s.language as string | undefined,
    // Every YouTube caption URL carries caps=asr, so only the track name tells auto-generated ones apart.
    auto: /auto-generated|\(auto\)/i.test(s.name ?? ""),
  })));

  const selectQuality = (vi: number) => { setMenu(null); player.selectSource(vi, currentAudioIndex(), currentSubtitleIndex()); };
  const selectAudio = (ai: number) => { setMenu(null); player.selectSource(currentVideoIndex(), ai, currentSubtitleIndex()); };
  const selectCaptions = (si: number) => {
    setMenu(null);
    const track = captionTracks().find((t) => t.index === si);
    prefs.setCaptions(track?.language ?? (si >= 0 ? "on" : "off"));
    player.selectSource(currentVideoIndex(), currentAudioIndex(), si);
  };
  const toggleCaptions = () => {
    if (currentSubtitleIndex() >= 0) selectCaptions(-1);
    else if (captionTracks().length) {
      const pref = prefs.captions();
      selectCaptions((captionTracks().find((t) => t.language && t.language === pref) ?? captionTracks().find((t) => !t.auto) ?? captionTracks()[0]).index);
    }
  };
  const setSpeed = (r: number) => { el.playbackRate = r; prefs.setRate(r); setMenu(null); };

  const shownTime = () => scrub() ?? seekTarget() ?? time();
  const pct = (t: number) => (duration() > 0 ? `${Math.min(100, (t / duration()) * 100)}%` : "0%");

  const MenuPanel = (p: { title: string; children: JSX.Element }) => (
    <div class="vp-menu" role="menu" onPointerUp={(e) => e.stopPropagation()}>
      <div class="vp-menu-title">{p.title}</div>
      <div class="vp-menu-list">{p.children}</div>
    </div>
  );
  const MenuItem = (p: { selected: boolean; label: string; sub?: string; onSelect: () => void }) => (
    <button class="vp-menu-item" role="menuitemradio" aria-checked={p.selected} onClick={p.onSelect}>
      <span class="vp-check">{p.selected ? <Icon name="check" size={18} /> : null}</span>
      <span class="vp-menu-label">{p.label}<Show when={p.sub}><small>{p.sub}</small></Show></span>
    </button>
  );
  const openMenu = (m: Menu) => { setMenu(menu() === m ? null : m); poke(); };

  return (
    <div
      ref={container}
      class="vp"
      classList={{ mini: props.mini, "app-fullscreen": appFs(), "controls-on": controls() || !playing() || !!menu(), fullscreen: fullscreen(), "fine-pointer": finePointer }}
      onPointerMove={(e) => { if (e.pointerType === "mouse" && !props.mini) poke(); }}
      onMouseLeave={() => { if (playing() && !menu()) setControls(false); }}
    >
      <video
        ref={el}
        playsinline
        webkit-playsinline=""
        x-webkit-airplay="allow"
        preload="auto"
        poster={props.poster}
        onPlay={() => { setPlaying(true); player.setPlaying(true); }}
        onPause={() => { setPlaying(false); player.setPlaying(false); setTime(el.currentTime); reportProgress(true); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => { setWaiting(false); player.setStarted(true); }}
        onCanPlay={() => setWaiting(false)}
        onSeeking={() => setWaiting(true)}
        onSeeked={() => { setWaiting(false); setSeekTarget(null); setTime(el.currentTime); updatePositionState(); }}
        onTimeUpdate={() => { if (!playing()) setTime(el.currentTime); updateBuffered(); reportProgress(); }}
        onDurationChange={() => { setDuration(isFinite(el.duration) ? el.duration : 0); updatePositionState(); }}
        onRateChange={() => { setRate(el.playbackRate); updatePositionState(); }}
        onVolumeChange={() => { setVolume(el.volume); setMuted(el.muted); prefs.setVolume(el.volume); prefs.setMuted(el.muted); }}
        onProgress={updateBuffered}
        onEnded={() => { setPlaying(false); reportProgress(true); props.onEnded?.(); }}
        onError={() => { if (!shakaPlayer?.getLoadMode?.()) setPlayError("This video couldn't be played."); }}
      />

      <Show when={prefs.audioOnly() && props.source}>
        <div class="vp-audio-cover" aria-hidden="true">
          <Show when={props.poster}><img class="vp-audio-bg" src={props.poster} alt="" referrerpolicy="no-referrer" /></Show>
          <div class="vp-audio-art">
            <Show when={props.poster}><img src={props.poster} alt="" referrerpolicy="no-referrer" /></Show>
          </div>
          <Show when={!props.mini}><span class="vp-audio-label"><Icon name="headphones" size={16} /> Audio only</span></Show>
        </div>
      </Show>

      <div class="vp-surface" onPointerUp={onSurfaceTap} />

      <Show when={seekHint()}>
        <div class={`vp-seek-hint ${seekHint()!.side}`}><Icon name={seekHint()!.side === "left" ? "rewind" : "ffwd"} filled /> {seekHint()!.n}s</div>
      </Show>

      <Show when={(props.loading || waiting()) && !props.error && !playError()}>
        <div class="vp-center"><div class="spinner vp-spinner" /></div>
      </Show>

      <Show when={props.error || playError()}>
        <div class="vp-error">
          <Icon name="alert" />
          <p>{props.error || playError()}</p>
          <button class="btn small" onClick={() => player.retry()}>Retry</button>
        </div>
      </Show>

      <Show when={!props.mini && activeSegment() && activeSegment()!.type === 5}>
        <button class="vp-skip-segment" onPointerUp={(e) => e.stopPropagation()} onClick={() => { seekTo(activeSegment()!.timeEnd); poke(); }}>
          Skip {segmentName(activeSegment()!.name)} <Icon name="skip" size={18} />
        </button>
      </Show>

      <Show when={!props.mini && !props.error && !playError()}>
        <div class="vp-controls" aria-hidden={!controls() && !menu()}>
          <div class="vp-top">
            <button class="icon-btn vp-exit" aria-label={fullscreen() ? "Exit full screen" : "Minimize"} title={fullscreen() ? "Exit full screen" : "Minimize"} onClick={() => (fullscreen() ? toggleFullscreen() : player.minimize())}><Icon name="down" /></button>
            <div class="vp-title">{fullscreen() ? props.video?.name : ""}</div>
            <button class="vp-btn vp-audio-btn" classList={{ on: prefs.audioOnly() }} aria-pressed={prefs.audioOnly()}
              aria-label={prefs.audioOnly() ? "Switch back to video" : "Audio only"} title={prefs.audioOnly() ? "Back to video (a)" : "Audio only — screen can turn off (a)"} onClick={() => { toggleAudioOnly(); poke(); }}>
              <Icon name={prefs.audioOnly() ? "video" : "headphones"} /><span class="vp-btn-label">{prefs.audioOnly() ? "Video" : "Audio"}</span>
            </button>
            <QueueButton />
            <Show when={pipSupported() && !prefs.audioOnly()}>
              <button class="icon-btn" aria-label="Picture in picture" title="Picture in picture (i)" onClick={togglePip}><Icon name="pip" /></button>
            </Show>
          </div>

          <div class="vp-middle">
            <button class="icon-btn vp-skip" aria-label="Back 10 seconds" onClick={() => seekBy(-10)}><Icon name="replay10" /></button>
            <Show when={!(props.loading || waiting()) || needsTap()}>
              <button class="vp-play" aria-label={playing() ? "Pause" : "Play"} onClick={() => { toggle(); poke(); }}>
                <Icon name={playing() ? "pause" : "play"} filled size={34} />
              </button>
            </Show>
            <button class="icon-btn vp-skip" aria-label="Forward 10 seconds" onClick={() => seekBy(10)}><Icon name="forward10" /></button>
          </div>

          <div class="vp-bottom">
            <div
              ref={bar}
              class="vp-bar"
              classList={{ scrubbing: scrub() != null }}
              onPointerDown={onBarDown}
              onPointerMove={onBarMove}
              onPointerUp={onBarUp}
              onPointerCancel={() => { setScrub(null); setHover(null); }}
              onPointerLeave={(e) => { if (e.pointerType === "mouse" && scrub() == null) setHover(null); }}
              onKeyDown={onBarKey}
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.floor(duration())}
              aria-valuenow={Math.floor(shownTime())}
              aria-valuetext={formatDuration(shownTime())}
              tabindex="0"
            >
              <div class="vp-bar-track">
                <div class="vp-bar-buffer" style={{ width: pct(buffered()) }} />
                <div class="vp-bar-fill" style={{ width: pct(shownTime()) }} />
                <For each={segments()}>{(c) => (
                  <div class="vp-bar-segment" title={segmentName(c.name)} style={{ left: pct(c.timeStart), width: `calc(${pct(c.timeEnd)} - ${pct(c.timeStart)})`, background: segmentColor(c.name) }} />
                )}</For>
                <For each={(chapters() ?? []).filter((c) => c.type === 0 && c.timeStart > 0)}>{(c) => <div class="vp-bar-tick" style={{ left: pct(c.timeStart) }} />}</For>
              </div>
              <div class="vp-bar-thumb" style={{ left: pct(shownTime()) }} />
              <Show when={hover() && duration() > 0}>
                <div class="vp-bar-tip" style={{ left: `${hover()!.x}px` }}>
                  <Show when={chapterAt(hover()!.t)}><span class="vp-bar-tip-chapter">{chapterAt(hover()!.t)}</span></Show>
                  {formatDuration(hover()!.t) || "0:00"}
                </div>
              </Show>
            </div>

            <div class="vp-row">
              <button class="icon-btn vp-only-fine" aria-label={playing() ? "Pause" : "Play"} title={playing() ? "Pause (k)" : "Play (k)"} onClick={() => { toggle(); poke(); }}>
                <Icon name={playing() ? "pause" : "play"} filled />
              </button>
              <div class="vp-volume vp-only-fine">
                <button class="icon-btn" aria-label={muted() ? "Unmute" : "Mute"} title="Mute (m)" onClick={() => { el.muted = !el.muted; }}>
                  <Icon name={muted() || volume() === 0 ? "mute" : "volume"} />
                </button>
                <input type="range" min="0" max="1" step="0.02" aria-label="Volume" value={muted() ? 0 : volume()}
                  onInput={(e) => { el.volume = Number(e.currentTarget.value); el.muted = el.volume === 0; }} />
              </div>
              <span class="vp-time">
                {formatDuration(shownTime()) || "0:00"}
                <span class="faint"> / {formatDuration(duration()) || (props.video?.isLive ? "LIVE" : "0:00")}</span>
              </span>
              <div class="spacer" />

              <Show when={props.onPrevious}>
                <button class="icon-btn" aria-label="Previous video" title={props.previousTitle ? `Back to: ${props.previousTitle} (Shift+P)` : "Previous (Shift+P)"} onClick={() => { props.onPrevious!(); poke(); }}>
                  <Icon name="previous" />
                </button>
              </Show>
              <Show when={props.onNext}>
                <button class="icon-btn" aria-label="Next video" title={props.nextTitle ? `Next: ${props.nextTitle} (Shift+N)` : "Next (Shift+N)"} onClick={() => { props.onNext!(); poke(); }}>
                  <Icon name="skip" />
                </button>
              </Show>
              <Show when={captionTracks().length > 0}>
                <button class="vp-btn" classList={{ on: currentSubtitleIndex() >= 0 }} aria-label="Captions" title="Captions (c)" aria-expanded={menu() === "captions"} onClick={() => openMenu("captions")}>
                  <Icon name="captions" />
                </button>
              </Show>
              <Show when={audioTracks().length > 1}>
                <button class="vp-btn" aria-label="Audio track" title="Audio track" aria-expanded={menu() === "audio"} onClick={() => openMenu("audio")}>
                  <Icon name="volume" /><span class="vp-btn-label">Audio</span>
                </button>
              </Show>
              <button class="vp-btn" aria-label="Playback speed" title="Speed (< >)" aria-expanded={menu() === "speed"} onClick={() => openMenu("speed")}>
                <Icon name="gauge" /><span class="vp-btn-label">{rate()}×</span>
              </button>
              <Show when={qualities().length > 0}>
                <button class="vp-btn" aria-label="Quality" title="Quality" aria-expanded={menu() === "quality"} onClick={() => openMenu("quality")}>
                  <span class="vp-btn-label strong">{currentQuality()}</span>
                </button>
              </Show>
              <button class="icon-btn" aria-label="Full screen" title="Full screen (f)" onClick={toggleFullscreen}><Icon name={fullscreen() ? "exitFullscreen" : "fullscreen"} /></button>
            </div>
          </div>

          <Show when={menu() === "captions"}>
            <MenuPanel title="Captions">
              <MenuItem selected={currentSubtitleIndex() < 0} label="Off" onSelect={() => selectCaptions(-1)} />
              <For each={captionTracks()}>{(t) => <MenuItem selected={currentSubtitleIndex() === t.index} label={t.label} sub={t.auto ? "Auto-generated" : undefined} onSelect={() => selectCaptions(t.index)} />}</For>
            </MenuPanel>
          </Show>
          <Show when={menu() === "audio"}>
            <MenuPanel title="Audio track">
              <For each={audioTracks()}>{(t) => <MenuItem selected={currentAudioIndex() === t.index} label={t.label} sub={t.sub} onSelect={() => selectAudio(t.index)} />}</For>
            </MenuPanel>
          </Show>
          <Show when={menu() === "speed"}>
            <MenuPanel title="Playback speed">
              <For each={SPEEDS}>{(r) => <MenuItem selected={rate() === r} label={r === 1 ? "Normal" : `${r}×`} onSelect={() => setSpeed(r)} />}</For>
            </MenuPanel>
          </Show>
          <Show when={menu() === "quality"}>
            <MenuPanel title="Quality">
              <For each={qualities()}>{(q: any) => <MenuItem selected={currentVideoIndex() === q.index} label={qualityLabel(q)} sub={[q.container?.replace("video/", ""), q.codec].filter(Boolean).join(" · ")} onSelect={() => selectQuality(q.index)} />}</For>
            </MenuPanel>
          </Show>
        </div>
      </Show>
    </div>
  );
}
