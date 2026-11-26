import { For, Show, createEffect, createResource, createSignal, on, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ContentType, details, subscriptions } from "../api";
import { bestThumbnail, formatAgo, formatCount, formatViews, joinDot } from "../lib/format";
import { createPager } from "../lib/pager";
import { channelHref } from "../lib/nav";
import ContentCard, { Avatar, SkeletonCard } from "../components/ContentCard";
import Icon from "../components/Icon";
import RichText from "../components/RichText";
import Sheet from "../components/Sheet";
import { toast, toastError } from "../components/Toasts";
import VideoPlayer from "./VideoPlayer";
import { suppressNextTap } from "./gesture";
import { player } from "./store";
import "./WatchOverlay.css";

export default function WatchOverlay() {
  const navigate = useNavigate();
  const mode = player.mode;
  const v = () => player.video();
  const meta = () => v() ?? player.preview();
  const [descOpen, setDescOpen] = createSignal(false);
  const [commentsOpen, setCommentsOpen] = createSignal(false);

  // Lock page scroll behind the full-screen watch view.
  createEffect(() => {
    document.documentElement.style.overflow = mode() === "full" ? "hidden" : "";
    document.documentElement.style.setProperty("--mini-h", mode() === "mini" ? "72px" : "0px");
  });

  // Recommendations for the current video.
  const recs = createPager(
    () => details.recommendationsLoad(player.url()!),
    () => details.recommendationsNext(player.url()!),
    { filter: (x) => x.contentType === ContentType.MEDIA },
  );
  createEffect(on(() => v()?.url, (u) => { if (u) recs.reload(); setDescOpen(false); }));

  // Subscribe state for the author.
  const authorUrl = () => v()?.author?.url;
  const [subscribed, { mutate: setSubscribed }] = createResource(authorUrl, (u) => subscriptions.isSubscribed(u).catch(() => false));
  const toggleSubscribe = async () => {
    const u = authorUrl(); if (!u) return;
    try {
      if (subscribed()) { await subscriptions.unsubscribe(u); setSubscribed(false); toast("Unsubscribed"); }
      else { await subscriptions.subscribe(u); setSubscribed(true); toast(`Subscribed to ${v()?.author?.name}`); }
    } catch (e) { toastError(e); }
  };

  const share = async () => {
    const url = v()?.shareUrl || v()?.url;
    if (!url) return;
    try {
      if (navigator.share) await navigator.share({ title: v()?.name, url });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(url); toast("Link copied"); }
      else window.prompt("Copy this link", url); // no clipboard API on plain-HTTP addresses
    } catch { }
  };

  const seekTo = (s: number) => { const el = player.videoEl(); if (el) { el.currentTime = s; el.play().catch(() => { }); } };

  const playNext = () => {
    const next = recs.items()[0];
    if (next) player.open(next.url, next);
  };

  // Swipe the player down to minimize (touch).
  let startY = 0, startX = 0, dy = 0, tracking = false, panel!: HTMLDivElement;
  const onTouchStart = (e: TouchEvent) => {
    if (mode() !== "full" || e.touches.length !== 1) return;
    tracking = true; dy = 0; startY = e.touches[0].clientY; startX = e.touches[0].clientX;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!tracking) return;
    const ddy = e.touches[0].clientY - startY, ddx = e.touches[0].clientX - startX;
    if (Math.abs(ddx) > Math.abs(ddy) && Math.abs(ddx) > 12) { tracking = false; return; }
    dy = Math.max(0, ddy);
    if (dy > 8) {
      panel.style.transition = "none";
      panel.style.transform = `translateY(${dy * 0.9}px)`;
      panel.style.opacity = String(Math.max(0.5, 1 - dy / 900));
    }
  };
  const onTouchEnd = () => {
    if (!tracking) return;
    tracking = false;
    panel.style.transition = ""; panel.style.transform = ""; panel.style.opacity = "";
    if (dy > 8) suppressNextTap();
    if (dy > 110) player.minimize();
  };

  const ratingText = () => {
    const r = v()?.rating;
    if (!r) return "";
    if (r.likes != null && r.likes >= 0) return formatCount(r.likes);
    if (r.value != null) return `${Math.round(r.value * 100)}%`;
    return "";
  };

  onCleanup(() => document.documentElement.style.removeProperty("--mini-h"));

  return (
    <div class="watch" data-mode={mode()} aria-hidden={mode() === "closed"}>
      <div class="watch-panel" ref={panel}>
        <div class="watch-player" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          <VideoPlayer
            source={player.source()}
            video={v()}
            startAt={player.startAt()}
            poster={bestThumbnail(meta()?.thumbnails, 1280)}
            mini={mode() === "mini"}
            loading={player.loading()}
            error={player.error()}
            onEnded={playNext}
          />
        </div>

        {/* Mini player bar */}
        <Show when={mode() === "mini"}>
          <div class="mini-info" onClick={() => player.expand()}>
            <div class="mini-title">{meta()?.name}</div>
            <div class="mini-sub">{meta()?.author?.name}</div>
          </div>
          <button class="icon-btn" aria-label="Play or pause" onClick={(e) => { e.stopPropagation(); const el = player.videoEl(); el && (el.paused ? el.play() : el.pause()); }}>
            <Icon name={player.playing() ? "pause" : "play"} filled />
          </button>
          <button class="icon-btn" aria-label="Close player" onClick={(e) => { e.stopPropagation(); player.close(); }}><Icon name="close" /></button>
        </Show>

        <Show when={mode() === "full"}>
          <div class="watch-body">
            <div class="watch-main">
              <h1 class="watch-title">{meta()?.name}</h1>
              <button class="watch-meta" onClick={() => setDescOpen(!descOpen())}>
                {joinDot(v()?.isLive ? "Live now" : formatViews(meta()?.viewCount), formatAgo(meta()?.dateTime), meta()?.id?.platform)}
                <span class="more-link">{descOpen() ? "less" : "…more"}</span>
              </button>

              <div class="watch-author">
                <a href={channelHref(meta()?.author?.url)} onClick={(e) => { e.preventDefault(); player.minimize(); navigate(channelHref(meta()?.author?.url)); }} class="row" style={{ gap: "10px", "min-width": 0, flex: 1 }}>
                  <Avatar src={meta()?.author?.thumbnail} name={meta()?.author?.name} size={40} />
                  <div style={{ "min-width": 0 }}>
                    <div class="author-name">{meta()?.author?.name}</div>
                    <Show when={meta()?.author?.subscribers}><div class="faint" style={{ "font-size": "12px" }}>{formatCount(meta()?.author?.subscribers)} subscribers</div></Show>
                  </div>
                </a>
                <button class={`btn ${subscribed() ? "" : "primary"}`} onClick={toggleSubscribe} disabled={!authorUrl() || subscribed.loading}>
                  {subscribed() ? "Subscribed" : "Subscribe"}
                </button>
              </div>

              <div class="watch-actions">
                <Show when={ratingText()}>
                  <span class="btn small" aria-label="Likes"><Icon name="like" size={18} /> {ratingText()}</span>
                </Show>
                <button class="btn small" onClick={share}><Icon name="share" size={18} /> Share</button>
                <button class="btn small" onClick={() => setCommentsOpen(true)}><Icon name="comment" size={18} /> Comments</button>
                <a class="btn small" href={v()?.shareUrl || v()?.url} target="_blank" rel="noreferrer"><Icon name="external" size={18} /> Open</a>
              </div>

              <Show when={descOpen() && v()?.description}>
                <div class="watch-desc"><RichText text={v()!.description} onTimestamp={seekTo} /></div>
              </Show>
            </div>

            <aside class="watch-recs">
              <h2 class="section-title">Up next</h2>
              <div class="feed-list">
                <For each={recs.items()}>{(item) => <ContentCard item={item} layout="row" />}</For>
                <Show when={!recs.loaded() && recs.loading()}>
                  <For each={[1, 2, 3, 4, 5]}>{() => <SkeletonCard layout="row" />}</For>
                </Show>
              </div>
              <Show when={recs.hasMore() && recs.loaded()}>
                <button class="btn block" style={{ "margin-top": "12px" }} onClick={() => recs.next()} disabled={recs.loading()}>Show more</button>
              </Show>
            </aside>
          </div>
        </Show>
      </div>

      <Sheet open={commentsOpen()} onClose={() => setCommentsOpen(false)} title="Comments" size="tall">
        <Comments url={player.url()!} />
      </Sheet>
    </div>
  );
}

function Comments(props: { url: string }) {
  const pager = createPager<any>(
    async () => { const r = await details.commentsLoad(); return { ...r, results: r.results.map((x: any) => x.object ?? x) }; },
    async () => { const r = await details.commentsNext(); return { ...r, results: r.results.map((x: any) => x.object ?? x) }; },
  );
  pager.reload();
  return (
    <div class="comments">
      <For each={pager.items()}>
        {(c) => (
          <div class="comment">
            <Avatar src={c.author?.thumbnail} name={c.author?.name} size={32} />
            <div class="comment-body">
              <div class="comment-head">{joinDot(c.author?.name, formatAgo(c.date))}</div>
              <div class="comment-text"><RichText text={c.message} /></div>
              <div class="comment-foot faint">
                <Show when={c.rating?.likes > 0}><span><Icon name="like" size={14} /> {formatCount(c.rating.likes)}</span></Show>
                <Show when={c.replyCount > 0}><span>{c.replyCount} repl{c.replyCount === 1 ? "y" : "ies"}</span></Show>
              </div>
            </div>
          </div>
        )}
      </For>
      <Show when={pager.loading()}><div class="feed-status"><div class="spinner" /></div></Show>
      <Show when={pager.error()}><div class="feed-status">{pager.error()!.message}</div></Show>
      <Show when={pager.loaded() && !pager.loading() && pager.items().length === 0}><div class="empty"><h3>No comments</h3></div></Show>
      <Show when={pager.hasMore() && pager.loaded() && !pager.loading()}>
        <button class="btn block" onClick={() => pager.next()}>More comments</button>
      </Show>
    </div>
  );
}
