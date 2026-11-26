import { Match, Show, Switch } from "solid-js";
import { A } from "@solidjs/router";
import { Content, ContentType } from "../api";
import { bestThumbnail, formatAgo, formatCount, formatDuration, formatViews, joinDot } from "../lib/format";
import { channelHref } from "../lib/nav";
import { player } from "../player/store";
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

function Thumb(props: { src?: string; duration?: number; live?: boolean; progress?: number }) {
  return (
    <div class="thumb">
      <Show when={props.src}>
        <img src={props.src} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
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
        <Show when={(props.layout ?? "grid") === "grid"}><div class="skeleton" style={{ width: "36px", height: "36px", "border-radius": "50%", flex: "none" }} /></Show>
        <div style={{ flex: 1 }}>
          <div class="skeleton" style={{ height: "14px", width: "90%", "margin-bottom": "8px" }} />
          <div class="skeleton" style={{ height: "12px", width: "55%" }} />
        </div>
      </div>
    </div>
  );
}

/** One piece of content from any source. Layout "grid" for feeds, "row" for compact lists (recommendations, search on mobile). */
export default function ContentCard(props: { item: Content; layout?: "grid" | "row"; progress?: number; hideAuthor?: boolean }) {
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
          <Thumb src={bestThumbnail(item().thumbnails ?? item().contentThumbnails, layout() === "row" ? 320 : 640)} duration={item().duration} live={item().isLive} progress={props.progress} />
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
