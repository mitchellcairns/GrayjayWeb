import { Show, createMemo, createSignal, onCleanup } from "solid-js";
import { formatDuration } from "../lib/format";
import { handoff, RemotePlayback } from "../player/handoff";
import { player } from "../player/store";
import Icon from "./Icon";
import "./Handoff.css";

const RECENT_MS = 6 * 60 * 60 * 1000;

/**
 * Small "Continue here" pill above the tab bar when another of your devices is playing (or recently paused) something:
 * one tap picks it up here at the same position and pauses it there. Works in both directions.
 */
export function ContinueBar() {
  const [dismissed, setDismissed] = createSignal(new Set<string>());
  const [tick, setTick] = createSignal(0);
  const timer = setInterval(() => setTick((t) => t + 1), 1000);
  onCleanup(() => clearInterval(timer));
  const key = (d: RemotePlayback) => `${d.deviceId}|${d.url}`;

  const candidate = createMemo(() => {
    if (player.playing() || player.mode() === "full") return null; // out of the way while you watch here
    return handoff.others().find((d) =>
      d.url && d.url !== player.url() && !dismissed().has(key(d)) && (d.playing || Date.now() - d.at < RECENT_MS)) ?? null;
  });
  const pos = (d: RemotePlayback) => { tick(); return handoff.positionOf(d); };

  return (
    <Show when={candidate()}>{(d) => (
      <div class="continue-pill" role="region" aria-label="Continue from another device">
        <button class="continue-main" onClick={() => handoff.continueHere(d())} title={`Continue “${d().name ?? ""}” here`}>
          <span class="continue-play"><Icon name="play" filled size={14} /></span>
          <span class="continue-text">
            <span class="continue-kicker">Continue here · {formatDuration(pos(d())) || "0:00"}</span>
            <span class="continue-title">{d().name} <span class="faint">· {d().playing ? "playing" : "paused"} on {d().deviceName || "another device"}</span></span>
          </span>
        </button>
        <button class="continue-x" aria-label="Dismiss" onClick={() => setDismissed((s) => new Set(s).add(key(d())))}><Icon name="close" size={16} /></button>
      </div>
    )}</Show>
  );
}
