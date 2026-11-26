// Previous / Next that never lose your place.
// - Next remembers the exact time in the video you leave; Previous returns to it at that time, and the video you
//   leave then goes back to the front of the queue at *its* time.
// - Past 30 s, Previous restarts the current video instead; pressing Next right after that returns to where you were.
import { createEffect, createRoot, createSignal, on } from "solid-js";
import type { Content } from "../api";
import { queue } from "./queue";
import { player } from "./store";

export const RESTART_AFTER_SECONDS = 30;

export const skip = createRoot(() => {
  /** Where you were before Previous restarted this video (so Next can undo the restart). */
  const [restartedFrom, setRestartedFrom] = createSignal<{ url: string; time: number } | null>(null);
  createEffect(on(player.url, (u) => { if (restartedFrom() && restartedFrom()!.url !== u) setRestartedFrom(null); }));

  // Only trust the element's time when it holds the current video (not the previous one while this one loads).
  const pos = () => { const e = player.videoEl(); return e && isFinite(e.currentTime) && player.mediaUrl() === player.url() ? e.currentTime : 0; };
  const current = () => (player.video() ?? player.preview()) as Content | null;
  const seek = (t: number) => { const e = player.videoEl(); if (e) { e.currentTime = t; e.play().catch(() => { }); } };

  /** Before moving on to another video: remember this one and where you were in it. */
  function rememberCurrent() {
    const cur = current();
    if (cur?.url) queue.setPrevious({ ...cur, resumeAt: pos() });
  }

  /** Straight back to the video before the last Next, at the time you left it. */
  function backToPreviousVideo() {
    const prev = queue.previous();
    if (!prev) return;
    const cur = current();
    queue.setPrevious(null);
    if (cur?.url && cur.url !== prev.url) queue.addNext({ ...cur, resumeAt: pos() });
    setRestartedFrom(null);
    player.playNow(prev.url, prev, prev.resumeAt);
  }

  /** The Previous button (and lock-screen "previous"). */
  function previous() {
    const t = pos(), u = player.url();
    const hasPrevious = !!queue.previous() && queue.previous()!.url !== u;
    if (t > RESTART_AFTER_SECONDS || !hasPrevious) {
      if (u && t > 1) setRestartedFrom({ url: u, time: t });
      seek(0);
      return;
    }
    backToPreviousVideo();
  }

  /** The Next button (and lock-screen "next", and the end of a video): undo a restart first, else `advance`. */
  function next(advance: () => void) {
    const r = restartedFrom();
    if (r && r.url === player.url() && pos() < r.time) {
      setRestartedFrom(null);
      seek(r.time);
      return;
    }
    setRestartedFrom(null);
    advance();
  }

  return {
    previous, next, backToPreviousVideo, rememberCurrent,
    /** Next would take you back to where you were before a restart. */
    canUndoRestart: () => !!restartedFrom() && restartedFrom()!.url === player.url(),
  };
});
