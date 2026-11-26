import { For, Show, createEffect, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Content, ContentType, details, subscriptions } from "../api";
import { bestThumbnail, formatAgo, formatCount, formatViews, joinDot } from "../lib/format";
import { createPager } from "../lib/pager";
import { channelHref } from "../lib/nav";
import ContentCard, { Avatar, SkeletonCard } from "../components/ContentCard";
import Icon from "../components/Icon";
import RichText from "../components/RichText";
import Sheet from "../components/Sheet";
import { toast, toastError } from "../components/Toasts";
import VideoPlayer from "./VideoPlayer";
import { queue } from "./queue";
import { hidden } from "../lib/hidden";
import { ui } from "../lib/ui";
import { watchLater } from "../lib/watchLater";
import { QueueList } from "../components/GlobalSheets";
import { suppressNextTap } from "./gesture";
import { MiniRect, player, prefs, registerPlayerBox } from "./store";
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
  });

  // ---------- Floating mini-player: drag anywhere, resize from the corner, geometry remembered ----------
  const [viewport, setViewport] = createSignal({ w: innerWidth, h: innerHeight });
  const onResize = () => setViewport({ w: innerWidth, h: innerHeight });
  addEventListener("resize", onResize);
  onCleanup(() => removeEventListener("resize", onResize));
  const [live, setLive] = createSignal<MiniRect | null>(null); // while dragging/resizing (not persisted yet)
  const [miniControls, setMiniControls] = createSignal(false);
  const insets = () => {
    const cs = getComputedStyle(document.documentElement);
    const px = (v: string) => parseFloat(cs.getPropertyValue(v)) || 0;
    return { top: px("--safe-top") + 8, bottom: px("--tabbar-h") + px("--safe-bottom") + 8, left: px("--rail-w") + px("--safe-left") + 8, right: px("--safe-right") + 8 };
  };
  const clampRect = (r: MiniRect): MiniRect => {
    const vp = viewport(), ins = insets();
    const maxW = Math.max(180, Math.min(960, vp.w - ins.left - ins.right));
    const w = Math.max(180, Math.min(maxW, r.w));
    const h = w * 9 / 16;
    const x = Math.max(ins.left, Math.min(vp.w - ins.right - w, r.x));
    const y = Math.max(ins.top, Math.min(vp.h - ins.bottom - h, r.y));
    return { x, y, w };
  };
  const defaultRect = (): MiniRect => {
    const vp = viewport(), ins = insets();
    const w = vp.w < 600 ? Math.min(vp.w * 0.62, 300) : 420;
    return { x: vp.w - ins.right - w, y: vp.h - ins.bottom - w * 9 / 16, w };
  };
  const miniRect = () => clampRect(live() ?? prefs.mini() ?? defaultRect());
  const miniStyle = () => {
    if (mode() !== "mini") return {};
    const r = miniRect();
    return { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.w * 9 / 16}px` };
  };

  let gesture: { kind: "drag" | "resize"; startX: number; startY: number; start: MiniRect; moved: boolean; anchorRight: boolean } | null = null;
  let lastMiniTap = 0, hideMini: number | undefined;
  // A tap on the mini-player first only shows its controls; its buttons react only once they're visible (so the tap
  // that reveals them can't also pause, expand or close).
  let miniShownAt = 0;
  createEffect(on(miniControls, (on) => { if (on) miniShownAt = performance.now(); }));
  const miniTapOk = () => miniControls() && performance.now() - miniShownAt > 350;
  const showMiniControls = () => { setMiniControls(true); clearTimeout(hideMini); hideMini = window.setTimeout(() => setMiniControls(false), 2800); };
  const onMiniDown = (kind: "drag" | "resize") => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { }
    const start = miniRect();
    gesture = { kind, startX: e.clientX, startY: e.clientY, start, moved: false, anchorRight: start.x + start.w / 2 > viewport().w / 2 };
  };
  const onMiniMove = (e: PointerEvent) => {
    if (!gesture) return;
    const dx = e.clientX - gesture.startX, dy = e.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
    gesture.moved = true;
    const s = gesture.start;
    if (gesture.kind === "drag") {
      setLive({ x: s.x + dx, y: s.y + dy, w: s.w });
    } else {
      // Resize from the inner top corner, keeping the opposite (outer bottom) corner fixed.
      const w = gesture.anchorRight ? s.w - dx : s.w + dx;
      const clamped = clampRect({ x: s.x, y: s.y, w });
      const h = clamped.w * 9 / 16, bottom = s.y + s.w * 9 / 16;
      setLive({ x: gesture.anchorRight ? s.x + s.w - clamped.w : s.x, y: bottom - h, w: clamped.w });
    }
  };
  const onMiniUp = () => {
    const g = gesture;
    gesture = null;
    if (!g) return;
    if (g.moved) {
      prefs.setMini(miniRect());
      setLive(null);
      return;
    }
    if (g.kind === "resize") return;
    const now = performance.now();
    if (now - lastMiniTap < 300) { lastMiniTap = 0; player.expand(); return; }
    lastMiniTap = now;
    if (miniControls()) setMiniControls(false); else showMiniControls();
  };

  // Morph between full and mini (FLIP on the player box).
  let playerBoxEl!: HTMLDivElement;
  onMount(() => registerPlayerBox(playerBoxEl));
  onCleanup(() => registerPlayerBox(null));

  // Recommendations for the current video. They're the lowest priority on the page: the server runs the source plugin
  // for them, which competes with resolving and starting the video itself. So they load once playback has actually
  // started (or after 8 s, or if the video fails), never at the same moment as the video.
  const recs = createPager(
    () => details.recommendationsLoad(player.url()!),
    () => details.recommendationsNext(player.url()!),
    { filter: (x) => x.contentType === ContentType.MEDIA },
  );
  const [recsFor, setRecsFor] = createSignal<string | null>(null);
  const startRecs = () => {
    const u = v()?.url;
    if (!u || recsFor() === u) return;
    setRecsFor(u);
    recs.reload();
  };
  createEffect(on(() => v()?.url, (u) => {
    setDescOpen(false);
    if (!u) return;
    const t = setTimeout(startRecs, 8000);
    onCleanup(() => clearTimeout(t));
  }));
  createEffect(on(() => player.started() || !!player.error(), (go) => {
    if (!go) return;
    const t = setTimeout(startRecs, 1200); // let the first seconds buffer before anything else
    onCleanup(() => clearTimeout(t));
  }));
  const shownRecs = () => (recsFor() === v()?.url ? recs.items().filter((i) => !hidden.isHidden(i.author) && i.url !== player.url()) : []);

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

  // Queue first, then the top Up next suggestion.
  const nextItem = () => queue.items()[0] ?? shownRecs()[0];
  const current = () => (v() ?? player.preview()) as Content | null;
  const playNext = () => {
    const q = queue.shift();
    const next = q ?? shownRecs()[0];
    if (!next) return;
    const cur = current();
    if (cur?.url) queue.setPrevious(cur); // one step back stays possible
    player.playNow(next.url, next);
  };
  // Back to the video before the last Next; the one you skipped goes back to the front of the queue.
  const playPrevious = () => {
    const prev = queue.previous();
    if (!prev) return;
    const cur = current();
    queue.setPrevious(null);
    if (cur?.url && cur.url !== prev.url) queue.addNext(cur);
    player.playNow(prev.url, prev);
  };

  // Swipe the player down to minimize (touch).
  let startY = 0, startX = 0, dy = 0, tracking = false, panel!: HTMLDivElement;
  const onTouchStart = (e: TouchEvent) => {
    if (mode() !== "full" || e.touches.length !== 1) return;
    // In fullscreen the player's own swipe-down leaves fullscreen; don't also minimize.
    if (document.fullscreenElement || (e.target as Element).closest?.(".vp.fullscreen, .vp.app-fullscreen")) return;
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


  return (
    <div class="watch" data-mode={mode()} aria-hidden={mode() === "closed"} style={miniStyle()} classList={{ dragging: !!live() }}>
      <div class="watch-panel" ref={panel}>
        <div class="watch-player" ref={playerBoxEl} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          <VideoPlayer
            source={player.source()}
            video={v()}
            startAt={player.startAt()}
            poster={bestThumbnail(meta()?.thumbnails, 1280)}
            mini={mode() === "mini"}
            loading={player.loading()}
            error={player.error()}
            onEnded={playNext}
            onNext={nextItem() ? playNext : undefined}
            onPrevious={queue.previous() && queue.previous()!.url !== player.url() ? playPrevious : undefined}
            previousTitle={queue.previous()?.name}
            nextTitle={nextItem()?.name}
          />
        </div>

        {/* Floating mini-player: drag to move, corner handle to resize, tap for controls, double-tap to expand */}
        <Show when={mode() === "mini"}>
          <div class="mini-surface" classList={{ on: miniControls() }}
            onPointerDown={onMiniDown("drag")} onPointerMove={onMiniMove} onPointerUp={onMiniUp} onPointerCancel={onMiniUp}
            onPointerEnter={(e) => { if (e.pointerType === "mouse") setMiniControls(true); }}
            onPointerLeave={(e) => { if (e.pointerType === "mouse" && !gesture) setMiniControls(false); }}>
            <div class="mini-controls">
              <button class="mini-btn" aria-label="Expand player" title="Expand" onPointerDown={(e) => e.stopPropagation()} onClick={() => { if (miniTapOk()) player.expand(); }}><Icon name="up" /></button>
              <div class="spacer" />
              <button class="mini-btn" aria-label="Close player" title="Close" onPointerDown={(e) => e.stopPropagation()} onClick={() => { if (miniTapOk()) player.close(); }}><Icon name="close" /></button>
            </div>
            <button class="mini-play" aria-label={player.playing() ? "Pause" : "Play"} onPointerDown={(e) => e.stopPropagation()}
              onClick={() => { if (!miniTapOk()) { showMiniControls(); return; } const el = player.videoEl(); el && (el.paused ? el.play() : el.pause()); showMiniControls(); }}>
              <Icon name={player.playing() ? "pause" : "play"} filled size={28} />
            </button>
            <div class="mini-title-bar">{meta()?.name}</div>
          </div>
          <div class={`mini-resize ${miniRect().x + miniRect().w / 2 > viewport().w / 2 ? "left" : "right"}`} aria-label="Resize player"
            onPointerDown={onMiniDown("resize")} onPointerMove={onMiniMove} onPointerUp={onMiniUp} onPointerCancel={onMiniUp} />
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
                <a href={channelHref(meta()?.author?.url)} onClick={(e) => { e.preventDefault(); const href = channelHref(meta()?.author?.url); player.minimize(() => navigate(href)); }} class="row" style={{ gap: "10px", "min-width": 0, flex: 1 }}>
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
                <button class="btn small" classList={{ "is-on": watchLater.has(v()?.url) }} disabled={!v()}
                  onClick={() => watchLater.toggle(v()!).then((added) => toast(added ? "Saved to Watch later" : "Removed from Watch later", "info", 1800)).catch(toastError)}>
                  <Icon name={watchLater.has(v()?.url) ? "check" : "later"} size={18} /> {watchLater.has(v()?.url) ? "Saved" : "Save"}
                </button>
                <button class="btn small" onClick={share}><Icon name="share" size={18} /> Share</button>
                <button class="btn small" onClick={() => setCommentsOpen(true)}><Icon name="comment" size={18} /> Comments</button>
                <a class="btn small" href={v()?.shareUrl || v()?.url} target="_blank" rel="noreferrer"><Icon name="external" size={18} /> Open</a>
              </div>

              <Show when={descOpen() && v()?.description}>
                <div class="watch-desc"><RichText text={v()!.description} onTimestamp={seekTo} /></div>
              </Show>
            </div>

            <aside class="watch-recs">
              <Show when={queue.count() > 0}>
                <h2 class="section-title">Queue <span class="faint" style={{ "font-weight": 500, "font-size": "14px" }}>{queue.count()}</span>
                  <button class="btn small ghost" onClick={() => ui.setQueueOpen(true)}>Edit</button>
                </h2>
                <QueueList />
              </Show>
              <h2 class="section-title">{queue.count() > 0 ? "Then, recommended" : "Up next"}</h2>
              <div class="feed-list">
                <For each={shownRecs()}>{(item) => <ContentCard item={item} layout="row" />}</For>
                <Show when={recsFor() !== v()?.url || (!recs.loaded() && recs.loading())}>
                  <For each={[1, 2, 3, 4, 5]}>{() => <SkeletonCard layout="row" />}</For>
                </Show>
              </div>
              <Show when={recsFor() === v()?.url && recs.hasMore() && recs.loaded()}>
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
