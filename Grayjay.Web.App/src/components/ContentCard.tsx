import { Match, Show, Switch, createMemo, createSignal, onCleanup } from "solid-js";
import { A } from "@solidjs/router";
import { Content, ContentType } from "../api";
import { bestThumbnail, formatAgo, formatCount, formatDuration, formatViews, joinDot } from "../lib/format";
import { channelHref } from "../lib/nav";
import { player } from "../player/store";
import { queue } from "../player/queue";
import { display, frameUrls } from "../lib/display";
import { ui } from "../lib/ui";
import { toast } from "./Toasts";
import Icon from "./Icon";
import "./ContentCard.css";

export function Avatar(props: { src?: string; name?: string; size?: number }) {
  const size = () => props.size ?? 36;
  return (
    <div class="avatar" style={{ width: `${size()}px`, height: `${size()}px`, "font-size": `${size() * 0.42}px` }}>
      <Show when={props.src} fallback={<span>{(props.name ?? "?").trim().charAt(0).toUpperCase()}</span>}>
        <img src={props.src} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
      </Show>
    </div>
  );
}

const finePointer = matchMedia("(pointer: fine)").matches;

/**
 * Preview image. With "Video frames" (default) YouTube videos show a still from inside the video instead of the
 * creator's thumbnail, and on hover (mouse) it steps through stills from ~25/50/75%. Falls back to the thumbnail.
 */
function Thumb(props: { src?: string; videoUrl?: string; duration?: number; live?: boolean; progress?: number; queueItem?: Content }) {
  const [failed, setFailed] = createSignal(false);
  const [frame, setFrame] = createSignal(0);
  const frames = createMemo(() => (display.preview() === "frames" && !props.live && !failed() ? frameUrls(props.videoUrl) : null));
  let timer: number | undefined;
  const startCycle = () => {
    const f = frames(); if (!f || !finePointer) return;
    f.forEach((u) => { const i = new Image(); i.referrerPolicy = "no-referrer"; i.src = u; });
    clearInterval(timer);
    timer = window.setInterval(() => setFrame((n) => (n + 1) % f.length), 750);
  };
  const stopCycle = () => { clearInterval(timer); setFrame(0); };
  onCleanup(() => clearInterval(timer));
  const src = () => frames()?.[frame()] ?? props.src;

  const inQueue = () => !!props.queueItem && queue.has(props.queueItem.url);
  const toggleQueue = (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const added = queue.toggle(props.queueItem!);
    toast(added ? "Added to queue" : "Removed from queue", "info", 1800);
  };

  return (
    <div class="thumb" onMouseEnter={startCycle} onMouseLeave={stopCycle}>
      <Show when={src()}>
        <img src={src()} alt="" loading="lazy" decoding="async" fetchpriority="low" referrerpolicy="no-referrer"
          onError={() => { if (frames()) setFailed(true); }} />
      </Show>
      <Show when={props.queueItem}>
        <button class="thumb-queue" classList={{ on: inQueue() }} aria-pressed={inQueue()}
          aria-label={inQueue() ? "Remove from queue" : "Add to queue"} title={inQueue() ? "Remove from queue" : "Add to queue"}
          onClick={toggleQueue} onPointerUp={(e) => e.stopPropagation()}>
          <Icon name={inQueue() ? "queued" : "queueAdd"} size={18} />
        </button>
      </Show>
      <Show when={props.live}>
        <span class="badge live">LIVE</span>
      </Show>
      <Show when={!props.live && props.duration}>
        <span class="badge">{formatDuration(props.duration)}</span>
      </Show>
      <Show when={props.progress && props.progress > 0}>
        <div class="progress"><div style={{ width: `${Math.min(100, props.progress! * 100)}%` }} /></div>
      </Show>
    </div>
  );
}

export function SkeletonCard(props: { layout?: "grid" | "row" }) {
  return (
    <div class={`card-item ${props.layout ?? "grid"}`} aria-hidden="true">
      <div class="thumb skeleton" />
      <div class="meta">
        <Show when={(props.layout ?? "grid") === "grid"}><div class="skeleton sk-avatar" style={{ width: "36px", height: "36px", "border-radius": "50%", flex: "none" }} /></Show>
        <div style={{ flex: 1 }}>
          <div class="skeleton" style={{ height: "14px", width: "90%", "margin-bottom": "8px" }} />
          <div class="skeleton" style={{ height: "12px", width: "55%" }} />
        </div>
      </div>
    </div>
  );
}

/** One piece of content from any source. Layout "grid" for feeds, "row" for compact lists (recommendations, search on mobile). */
export default function ContentCard(props: { item: Content; layout?: "grid" | "row"; progress?: number; hideAuthor?: boolean; noQueue?: boolean; noMenu?: boolean }) {
  const layout = () => props.layout ?? "grid";
  const item = () => props.item;
  const open = (e: MouseEvent) => {
    e.preventDefault();
    player.open(item().url, item());
  };

  return (
    <Switch fallback={<SkeletonCard layout={layout()} />}>
      <Match when={item().contentType === ContentType.MEDIA || item().contentType === ContentType.NESTED_VIDEO}>
        <a class={`card-item ${layout()}`} href={`?watch=${encodeURIComponent(item().url)}`} onClick={open}>
          <Thumb src={bestThumbnail(item().thumbnails ?? item().contentThumbnails, layout() === "row" ? 320 : 640)} videoUrl={item().url}
            duration={item().duration} live={item().isLive} progress={props.progress} queueItem={props.noQueue ? undefined : item()} />
          <div class="meta">
            <Show when={layout() === "grid" && !props.hideAuthor}>
              <A href={channelHref(item().author?.url)} onClick={(e) => e.stopPropagation()} class="avatar-link" aria-label={item().author?.name}>
                <Avatar src={item().author?.thumbnail} name={item().author?.name} />
              </A>
            </Show>
            <div class="text">
              <h3 class="title">{item().name || item().contentName}</h3>
              <p class="sub">
                {joinDot(!props.hideAuthor && item().author?.name, item().isLive ? (item().viewCount ? `${formatCount(item().viewCount)} watching` : "Live") : formatViews(item().viewCount), !item().isLive && formatAgo(item().dateTime))}
              </p>
            </div>
            <Show when={!props.noMenu}>
              <button class="card-more" aria-label="More options" title="More"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); ui.setCardMenu(item()); }}>
                <Icon name="more" size={18} />
              </button>
            </Show>
          </div>
        </a>
      </Match>
      <Match when={item().contentType === ContentType.CHANNEL}>
        <A class="channel-row" href={channelHref(item().url)}>
          <Avatar src={item().thumbnail} name={item().name} size={56} />
          <div class="text">
            <h3 class="title">{item().name}</h3>
            <p class="sub">{joinDot(item().subscribers ? `${formatCount(item().subscribers)} subscribers` : "", item().id?.platform)}</p>
          </div>
          <Icon name="forward" />
        </A>
      </Match>
      <Match when={item().contentType === ContentType.PLAYLIST}>
        <a class={`card-item ${layout()}`} href={item().url} target="_blank" rel="noreferrer">
          <div class="thumb">
            <Show when={bestThumbnail(item().thumbnails)}><img src={bestThumbnail(item().thumbnails)} alt="" loading="lazy" referrerpolicy="no-referrer" /></Show>
            <span class="badge"><Icon name="list" size={12} /> {item().videoCount && item().videoCount! > 0 ? item().videoCount : ""}</span>
          </div>
          <div class="meta"><div class="text">
            <h3 class="title">{item().name}</h3>
            <p class="sub">{joinDot(item().author?.name, "Playlist")}</p>
          </div></div>
        </a>
      </Match>
      <Match when={item().contentType === ContentType.POST}>
        <article class="post-card card">
          <div class="row">
            <Avatar src={item().author?.thumbnail} name={item().author?.name} size={32} />
            <div><div class="title">{item().author?.name}</div><div class="sub">{formatAgo(item().dateTime)}</div></div>
          </div>
          <p class="post-text">{item().description ?? item().name}</p>
          <Show when={item().images?.length}><img class="post-image" src={item().images![0]} alt="" loading="lazy" referrerpolicy="no-referrer" /></Show>
        </article>
      </Match>
      <Match when={item().contentType === ContentType.LOCKED}>
        <div class={`card-item ${layout()} locked`}>
          <div class="thumb"><div class="locked-overlay"><Icon name="lock" /></div></div>
          <div class="meta"><div class="text"><h3 class="title">{item().name}</h3><p class="sub">Locked content</p></div></div>
        </div>
      </Match>
      <Match when={item().contentType === ContentType.PLACEHOLDER && item().error}>
        <div class={`card-item ${layout()} errored`}>
          <div class="thumb"><div class="locked-overlay"><Icon name="alert" /></div></div>
          <div class="meta"><div class="text"><p class="sub">Couldn't load from {item().id?.platform ?? "a source"}</p></div></div>
        </div>
      </Match>
    </Switch>
  );
}
