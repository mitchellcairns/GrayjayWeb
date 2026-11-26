import { For, Show } from "solid-js";
import { A } from "@solidjs/router";
import { display, Density, PreviewStyle } from "../lib/display";
import { hidden } from "../lib/hidden";
import { channelHref } from "../lib/nav";
import { formatAgo } from "../lib/format";
import { Avatar } from "./ContentCard";
import Icon from "./Icon";
import { toast, toastError } from "./Toasts";

/** Settings → Feeds: card size and preview style (this device). */
export function FeedLookSettings() {
  return (
    <div class="list">
      <label class="list-item">
        <Icon name="list" />
        <div class="grow"><div class="title">Video size in feeds</div><div class="sub wrap">Compact fits two per row on phones</div></div>
        <select class="settings-select" value={display.density()} onChange={(e) => display.setDensity(e.currentTarget.value as Density)}>
          <option value="compact">Compact (default)</option>
          <option value="large">Large</option>
          <option value="list">List</option>
        </select>
      </label>
      <label class="list-item">
        <Icon name="video" />
        <div class="grow"><div class="title">Video previews</div><div class="sub wrap">Frames from inside the video instead of the creator's thumbnail (YouTube). Hover with a mouse to step through them.</div></div>
        <select class="settings-select" value={display.preview()} onChange={(e) => display.setPreview(e.currentTarget.value as PreviewStyle)}>
          <option value="frames">Video frames (default)</option>
          <option value="thumbnails">Creator thumbnails</option>
        </select>
      </label>
    </div>
  );
}

/** Settings → Hidden creators (shared by all your devices). */
export function HiddenCreatorsSettings() {
  return (
    <Show when={hidden.list().length > 0} fallback={
      <div class="card muted" style={{ "font-size": "14px" }}>No hidden creators. Use <Icon name="more" size={14} style={{ "vertical-align": "-2px" }} /> on any video → <b>Hide creator</b> to stop seeing someone in Discover, Subscriptions, search and Up next.</div>
    }>
      <div class="list">
        <For each={hidden.list()}>{(c) => (
          <div class="list-item">
            <Avatar src={c.thumbnail} name={c.name} size={36} />
            <A class="grow" href={channelHref(c.url)} style={{ "min-width": 0 }}>
              <div class="title">{c.name || c.url}</div>
              <div class="sub">{[c.platform, c.hiddenAt ? `hidden ${formatAgo(new Date(c.hiddenAt).getTime() / 1000)}` : ""].filter(Boolean).join(" · ")}</div>
            </A>
            <button class="btn small" onClick={async () => { try { await hidden.unhide(c); toast(`${c.name || "Creator"} is visible again`); } catch (e) { toastError(e); } }}>
              <Icon name="show" size={16} /> Unhide
            </button>
          </div>
        )}</For>
      </div>
    </Show>
  );
}
