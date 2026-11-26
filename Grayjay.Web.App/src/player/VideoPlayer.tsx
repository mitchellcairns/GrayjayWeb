import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { SourceDescriptor, VideoDetails } from "../api";
import { details as detailsApi } from "../api";
import { bestThumbnail, formatDuration } from "../lib/format";
import Icon from "../components/Icon";
import Sheet from "../components/Sheet";
import { player } from "./store";
import { consumeSuppressedTap } from "./gesture";
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

function isStreamType(type?: string) {
  return !!type && (type.includes("dash") || type.includes("mpegurl") || type.includes("m3u8"));
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
}) {
  let container!: HTMLDivElement;
  let el!: HTMLVideoElement;
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
  const [fullscreen, setFullscreen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [rate, setRate] = createSignal(1);
  const [seekHint, setSeekHint] = createSignal<{ side: "left" | "right"; n: number } | null>(null);

  onMount(() => player.setVideoEl(el));
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

  createEffect(on(() => props.source, async (src) => {
    setPlayError(null);
    setNeedsTap(false);
    if (!src) return;
    const start = props.startAt || 0;
    try {
      if (isStreamType(src.type)) {
        const nativeHls = src.type.includes("mpegurl") && el.canPlayType("application/vnd.apple.mpegurl") && isIOS;
        if (nativeHls) {
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
          await p.load(src.url, start, src.type);
        }
      } else {
        await shakaPlayer?.unload();
        el.src = src.url;
        el.addEventListener("loadedmetadata", () => { if (start) el.currentTime = start; }, { once: true });
      }
      el.playbackRate = rate();
      await play();
    } catch (e: any) {
      console.error("load", e);
      setPlayError(e?.message ? `Couldn't start playback: ${e.message}` : `Couldn't start playback (${e?.code ?? "error"})`);
    }
  }));

  async function play() {
    try {
      await el.play();
      setNeedsTap(false);
    } catch (e: any) {
      if (e?.name === "NotAllowedError") setNeedsTap(true);
    }
  }
  const toggle = () => (el.paused ? play() : el.pause());

  // ---------- Element events ----------
  const updateBuffered = () => {
    const b = el.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= el.currentTime + 0.5 && b.end(i) >= el.currentTime) { setBuffered(b.end(i)); return; }
  };

  // ---------- Controls visibility ----------
  let hideTimer: number | undefined;
  const poke = () => {
    setControls(true);
    clearTimeout(hideTimer);
    if (!el.paused) hideTimer = window.setTimeout(() => { if (!settingsOpen() && scrub() == null) setControls(false); }, 3000);
  };
  createEffect(on(playing, (p) => { if (p) poke(); else { clearTimeout(hideTimer); setControls(true); } }));

  // ---------- Tap / double-tap ----------
  let lastTap = 0, lastSide: "left" | "right" | "center" = "center", singleTapTimer: number | undefined, hintTimer: number | undefined;
  const onSurfaceTap = (e: PointerEvent) => {
    if (consumeSuppressedTap()) return;
    if (props.mini) { player.expand(); return; }
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
  const seekBy = (d: number) => { el.currentTime = Math.max(0, Math.min((el.duration || Infinity) - 0.5, el.currentTime + d)); poke(); };

  // ---------- Scrubbing ----------
  let bar!: HTMLDivElement;
  const posFromEvent = (e: PointerEvent) => {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (duration() || 0);
  };
  const onBarDown = (e: PointerEvent) => { e.stopPropagation(); bar.setPointerCapture(e.pointerId); setScrub(posFromEvent(e)); poke(); };
  const onBarMove = (e: PointerEvent) => { if (scrub() != null) setScrub(posFromEvent(e)); };
  const onBarUp = (e: PointerEvent) => {
    if (scrub() == null) return;
    el.currentTime = posFromEvent(e);
    setScrub(null);
    poke();
  };

  // ---------- Fullscreen / PiP ----------
  const toggleFullscreen = async () => {
    const d = document as any;
    if (document.fullscreenElement || d.webkitFullscreenElement) {
      await (document.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
      return;
    }
    if (canElementFullscreen) {
      await (container.requestFullscreen?.({ navigationUI: "hide" }) ?? (container as any).webkitRequestFullscreen?.());
      try {
        if (el.videoWidth >= el.videoHeight) await (screen.orientation as any)?.lock?.("landscape");
      } catch { }
    } else {
      (el as any).webkitEnterFullscreen?.(); // iPhone: native fullscreen player
    }
  };
  const onFsChange = () => setFullscreen(!!(document.fullscreenElement || (document as any).webkitFullscreenElement));
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
    set("seekto", (d) => { if (d.seekTime != null) el.currentTime = d.seekTime; });
    set("stop", () => player.close());
  });
  const updatePositionState = () => {
    if (!("mediaSession" in navigator) || !isFinite(el.duration) || el.duration <= 0) return;
    try { navigator.mediaSession.setPositionState({ duration: el.duration, position: Math.min(el.currentTime, el.duration), playbackRate: el.playbackRate }); } catch { }
  };

  // ---------- Screen Wake Lock while playing ----------
  let wakeLock: any = null;
  const syncWakeLock = async () => {
    const want = playing() && document.visibilityState === "visible";
    try {
      if (want && !wakeLock && (navigator as any).wakeLock) {
        wakeLock = await (navigator as any).wakeLock.request("screen");
        wakeLock.addEventListener?.("release", () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release(); wakeLock = null;
      }
    } catch { wakeLock = null; }
  };
  createEffect(on(playing, syncWakeLock));
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
      case "i": togglePip(); break;
    }
  };
  addEventListener("keydown", onKey);
  onCleanup(() => removeEventListener("keydown", onKey));

  // ---------- Quality ----------
  const qualities = createMemo(() => {
    const sources = (props.video?.video?.videoSources ?? []).map((s: any, i: number) => ({ ...s, index: i }));
    const seen = new Set<string>();
    return sources
      .filter((s: any) => s.height || s.name)
      .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0) || (a.container?.includes("mp4") ? -1 : 1))
      .filter((s: any) => { const k = `${s.height}-${s.fps ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
  });
  const currentQuality = createMemo(() => {
    const vi = props.source?.videoIndex;
    const s: any = vi != null && vi >= 0 ? props.video?.video?.videoSources?.[vi] : null;
    return s?.height ? `${s.height}p` : "Auto";
  });

  const shownTime = () => scrub() ?? time();
  const pct = (t: number) => (duration() > 0 ? `${(t / duration()) * 100}%` : "0%");

  return (
    <div
      ref={container}
      class="vp"
      classList={{ mini: props.mini, "controls-on": controls() || !playing(), fullscreen: fullscreen() }}
      onPointerMove={(e) => { if (e.pointerType === "mouse" && !props.mini) poke(); }}
    >
      <video
        ref={el}
        playsinline
        webkit-playsinline=""
        x-webkit-airplay="allow"
        preload="auto"
        poster={props.poster}
        onPlay={() => { setPlaying(true); player.setPlaying(true); }}
        onPause={() => { setPlaying(false); player.setPlaying(false); reportProgress(true); }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onTimeUpdate={() => { setTime(el.currentTime); updateBuffered(); reportProgress(); }}
        onDurationChange={() => { setDuration(isFinite(el.duration) ? el.duration : 0); updatePositionState(); }}
        onRateChange={() => { setRate(el.playbackRate); updatePositionState(); }}
        onSeeked={updatePositionState}
        onProgress={updateBuffered}
        onEnded={() => { setPlaying(false); reportProgress(true); props.onEnded?.(); }}
        onError={() => { if (!shakaPlayer?.getLoadMode?.()) setPlayError("This video couldn't be played."); }}
      />

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

      <Show when={!props.mini && !props.error && !playError()}>
        <div class="vp-controls" aria-hidden={!controls()}>
          <div class="vp-top">
            <button class="icon-btn" aria-label="Minimize" onClick={() => (fullscreen() ? toggleFullscreen() : player.minimize())}><Icon name="down" /></button>
            <div class="spacer" />
            <Show when={pipSupported()}>
              <button class="icon-btn" aria-label="Picture in picture" onClick={togglePip}><Icon name="pip" /></button>
            </Show>
            <button class="icon-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>
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
            <div class="vp-time">
              <span>{formatDuration(shownTime()) || "0:00"}</span>
              <span class="faint"> / {formatDuration(duration()) || (props.video?.isLive ? "LIVE" : "0:00")}</span>
              <div class="spacer" />
              <button class="vp-pill" onClick={() => setSettingsOpen(true)}>{currentQuality()}{rate() !== 1 ? ` · ${rate()}×` : ""}</button>
              <button class="icon-btn" aria-label="Full screen" onClick={toggleFullscreen}><Icon name={fullscreen() ? "exitFullscreen" : "fullscreen"} /></button>
            </div>
            <div
              ref={bar}
              class="vp-bar"
              classList={{ scrubbing: scrub() != null }}
              onPointerDown={onBarDown}
              onPointerMove={onBarMove}
              onPointerUp={onBarUp}
              onPointerCancel={() => setScrub(null)}
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.floor(duration())}
              aria-valuenow={Math.floor(shownTime())}
              tabindex="0"
            >
              <div class="vp-bar-track">
                <div class="vp-bar-buffer" style={{ width: pct(buffered()) }} />
                <div class="vp-bar-fill" style={{ width: pct(shownTime()) }} />
              </div>
              <div class="vp-bar-thumb" style={{ left: pct(shownTime()) }} />
            </div>
          </div>
        </div>
      </Show>

      <Sheet open={settingsOpen()} onClose={() => { setSettingsOpen(false); poke(); }} title="Playback">
        <div class="section-title" style={{ "margin-top": "4px" }}>Quality</div>
        <div class="list">
          <For each={qualities()}>
            {(q: any) => (
              <button class="list-item" onClick={() => { setSettingsOpen(false); player.selectSource(q.index, props.source?.audioIndex ?? -1); }}>
                <div class="grow"><div class="title">{q.height ? `${q.height}p${q.fps && q.fps > 30 ? q.fps : ""}` : q.name}</div><div class="sub">{q.container}{q.codec ? ` · ${q.codec}` : ""}</div></div>
                <Show when={props.source?.videoIndex === q.index}><Icon name="check" /></Show>
              </button>
            )}
          </For>
        </div>
        <div class="section-title">Speed</div>
        <div class="chips" style={{ "flex-wrap": "wrap", overflow: "visible", margin: 0, padding: 0 }}>
          <For each={[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3]}>
            {(r) => <button class="chip" aria-pressed={rate() === r} onClick={() => { el.playbackRate = r; }}>{r}×</button>}
          </For>
        </div>
      </Sheet>
    </div>
  );
}
