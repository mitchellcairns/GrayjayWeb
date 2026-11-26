import { For, Show, createSignal, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { Content } from "../api";
import { bestThumbnail, formatDuration, joinDot } from "../lib/format";
import { hidden } from "../lib/hidden";
import { channelHref } from "../lib/nav";
import { ui } from "../lib/ui";
import { queue } from "../player/queue";
import { player } from "../player/store";
import { skip } from "../player/skip";
import Icon from "./Icon";
import Sheet from "./Sheet";
import { toast, toastAction, toastError } from "./Toasts";
import "./GlobalSheets.css";
import { ContinueBar } from "./Handoff";
import { watchLater } from "../lib/watchLater";

/** Hide a creator everywhere, with Undo (it's easy to hit by accident). */
export async function hideCreator(item: Content) {
  const a = item.author;
  if (!a?.url) return;
  try {
    await hidden.hide(a);
    toastAction(`Hidden ${a.name || "this creator"}`, "Undo", () => hidden.unhide(hidden.fromAuthor(a)).catch(toastError));
  } catch (e) { toastError(e); }
}

function CardMenu() {
  const navigate = useNavigate();
  const item = ui.cardMenu;
  const close = () => ui.setCardMenu(null);
  const act = (f: (it: Content) => void) => () => { const it = item(); close(); if (it) f(it); };
  const inQueue = () => queue.has(item()?.url);

  return (
    <Sheet open={!!item()} onClose={close} title={<span class="card-menu-title">{item()?.name}</span>}>
      <div class="list card-menu">
        <button class="list-item" onClick={act((it) => { const added = queue.toggle(it); toast(added ? "Added to queue" : "Removed from queue", "info", 1800); })}>
          <Icon name={inQueue() ? "queued" : "queueAdd"} /> <div class="grow title">{inQueue() ? "Remove from queue" : "Add to queue"}</div>
        </button>
        <button class="list-item" onClick={act((it) => { queue.addNext(it); toast("Plays next", "info", 1800); })}>
          <Icon name="skip" /> <div class="grow title">Play next</div>
        </button>
        <button class="list-item" onClick={act((it) => { watchLater.toggle(it).then((added) => toast(added ? "Saved to Watch later" : "Removed from Watch later", "info", 1800)).catch(toastError); })}>
          <Icon name="later" /> <div class="grow title">{watchLater.has(item()?.url) ? "Remove from Watch later" : "Save to Watch later"}</div>
        </button>
        <Show when={item()?.author?.url}>
          <button class="list-item" onClick={act((it) => { const href = channelHref(it.author!.url); player.minimize(() => navigate(href)); })}>
            <Icon name="user" /> <div class="grow title">Go to {item()?.author?.name || "channel"}</div>
          </button>
          <button class="list-item danger-item" onClick={act((it) => hideCreator(it))}>
            <Icon name="hide" />
            <div class="grow"><div class="title">Hide {item()?.author?.name || "this creator"}</div><div class="sub wrap">Never show their videos in Discover, Subscriptions, search or Up next. Undo in Settings → Hidden creators.</div></div>
          </button>
        </Show>
        <a class="list-item" href={item()?.url} target="_blank" rel="noreferrer" onClick={() => close()}>
          <Icon name="external" /> <div class="grow title">Open original</div>
        </a>
      </div>
    </Sheet>
  );
}

interface DragState { from: number; over: number; dy: number }

function QueueRow(props: {
  item: Content; index: number; count: number; drag: DragState | null; shift: number; settling: boolean;
  onGrip: (e: PointerEvent, index: number) => void;
}) {
  const play = () => {
    const it = queue.take(props.item.url);
    if (!it) return;
    if (player.mode() !== "closed") skip.rememberCurrent(); // a jump is a skip too: Previous comes back here
    player.playNow(it.url, it, it.resumeAt);
  };
  const dragging = () => props.drag?.from === props.index;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp" && props.index > 0) { e.preventDefault(); queue.move(props.index, -1); }
    if (e.key === "ArrowDown" && props.index < props.count - 1) { e.preventDefault(); queue.move(props.index, 1); }
  };
  return (
    <div class="queue-row" data-queue-row classList={{ dragging: dragging(), settling: props.settling }}
      style={{ transform: dragging() ? `translateY(${props.drag!.dy}px)` : props.shift ? `translateY(${props.shift}px)` : undefined }}>
      <button class="queue-grip" aria-label={`Reorder ${props.item.name} (drag, or use the arrow keys)`} title="Drag to reorder"
        onPointerDown={(e) => props.onGrip(e, props.index)} onKeyDown={onKey}>
        <Icon name="grip" size={20} />
      </button>
      <button class="queue-open" onClick={play} aria-label={`Play ${props.item.name}`}>
        <div class="queue-thumb">
          <Show when={bestThumbnail(props.item.thumbnails, 320)}><img src={bestThumbnail(props.item.thumbnails, 320)} alt="" decoding="async" referrerpolicy="no-referrer" draggable={false} /></Show>
          <Show when={props.item.duration}><span class="badge">{formatDuration(props.item.duration)}</span></Show>
        </div>
        <div class="queue-text">
          <div class="title">{props.item.name}</div>
          <div class="sub">{props.item.author?.name}</div>
        </div>
      </button>
      <button class="icon-btn" aria-label="Remove from queue" onClick={() => queue.remove(props.item.url)}><Icon name="close" size={18} /></button>
    </div>
  );
}

/**
 * Queue with press-and-drag reordering on the grip handle (mouse and touch). The dragged row follows the pointer,
 * the others slide out of the way, and the list scrolls when you drag near its top or bottom edge.
 */
export function QueueList() {
  let list!: HTMLDivElement;
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [settling, setSettling] = createSignal(false);
  let mids: number[] = [], heights: number[] = [], gap = 6;
  let startY = 0, startScroll = 0, pointerY = 0, scroller: HTMLElement | null = null, raf = 0;

  const scrollParent = (el: HTMLElement | null): HTMLElement => {
    for (let n = el?.parentElement; n; n = n.parentElement) {
      const o = getComputedStyle(n).overflowY;
      if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement as HTMLElement;
  };
  const scrollTop = () => scroller?.scrollTop ?? 0;

  const update = () => {
    const d = drag(); if (!d) return;
    const dy = pointerY - startY + (scrollTop() - startScroll);
    const center = mids[d.from] + dy;
    let over = 0;
    for (let i = 0; i < mids.length; i++) if (i !== d.from && mids[i] < center) over++;
    setDrag({ from: d.from, over, dy });
  };

  // Auto-scroll while the pointer is near the top/bottom edge of the scrolling area.
  const autoScroll = () => {
    if (!drag() || !scroller) return;
    const isDoc = scroller === document.scrollingElement;
    const top = isDoc ? 0 : scroller.getBoundingClientRect().top;
    const bottom = isDoc ? innerHeight : scroller.getBoundingClientRect().bottom;
    const edge = 56;
    const v = pointerY < top + edge ? -Math.ceil((top + edge - pointerY) / 6) : pointerY > bottom - edge ? Math.ceil((pointerY - (bottom - edge)) / 6) : 0;
    if (v) { scroller.scrollTop += v; update(); }
    raf = requestAnimationFrame(autoScroll);
  };

  const onGrip = (e: PointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rows = [...list.querySelectorAll<HTMLElement>("[data-queue-row]")];
    const rects = rows.map((r) => r.getBoundingClientRect());
    scroller = scrollParent(list);
    startScroll = scrollTop();
    mids = rects.map((r) => r.top + r.height / 2);
    heights = rects.map((r) => r.height);
    gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 6;
    startY = pointerY = e.clientY;
    setDrag({ from: index, over: index, dy: 0 });
    navigator.vibrate?.(8);
    const target = e.currentTarget as HTMLElement;
    try { target.setPointerCapture(e.pointerId); } catch { }
    const move = (ev: PointerEvent) => { pointerY = ev.clientY; update(); };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      cancelAnimationFrame(raf);
      const d = drag();
      // Reorder and drop the transforms in the same frame, without transitions, so nothing jumps.
      setSettling(true);
      setDrag(null);
      if (d && d.over !== d.from) queue.moveTo(d.from, d.over);
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
    raf = requestAnimationFrame(autoScroll);
  };
  onCleanup(() => cancelAnimationFrame(raf));

  // How far each non-dragged row slides to make room.
  const shiftFor = (i: number) => {
    const d = drag(); if (!d || i === d.from) return 0;
    const space = (heights[d.from] ?? 0) + gap;
    if (d.from < d.over && i > d.from && i <= d.over) return -space;
    if (d.over < d.from && i >= d.over && i < d.from) return space;
    return 0;
  };

  return (
    <div class="queue-list" ref={list} classList={{ "is-dragging": !!drag() }}>
      <For each={queue.items()}>{(it, i) => (
        <QueueRow item={it} index={i()} count={queue.count()} drag={drag()} shift={shiftFor(i())} settling={settling()} onGrip={onGrip} />
      )}</For>
    </div>
  );
}

function QueueSheet() {
  const now = () => player.video() ?? player.preview();
  return (
    <Sheet open={ui.queueOpen()} onClose={() => ui.setQueueOpen(false)} title="Queue" size="tall">
      <Show when={player.mode() !== "closed" && now()}>
        <div class="queue-now">
          <span class="faint">Now playing</span>
          <div class="title">{now()?.name}</div>
          <div class="sub">{joinDot(now()?.author?.name)}</div>
        </div>
      </Show>
      <Show when={queue.previous() && queue.previous()!.url !== player.url()}>
        <div class="queue-prev">
          <span class="faint">Before this</span>
          <div class="queue-prev-title">{queue.previous()!.name}</div>
          <button class="btn small" onClick={() => skip.backToPreviousVideo()}><Icon name="previous" size={16} /> Back</button>
        </div>
      </Show>
      <Show when={queue.count() > 0} fallback={
        <div class="empty"><Icon name="queue" /><h3>Your queue is empty</h3><p>Tap <Icon name="queueAdd" size={16} style={{ "vertical-align": "-3px" }} /> on any video to add it. Queued videos play before Up next suggestions.</p></div>
      }>
        <QueueList />
        <div class="row" style={{ "justify-content": "space-between", "margin-top": "12px" }}>
          <span class="faint">{queue.count()} video{queue.count() === 1 ? "" : "s"}</span>
          <div class="row" style={{ gap: "8px" }}>
            <button class="btn small ghost" onClick={() => queue.clear()}>Clear</button>
            <button class="btn small accent" onClick={() => { const it = queue.shift(); if (it) { if (player.mode() !== "closed") skip.rememberCurrent(); player.playNow(it.url, it, it.resumeAt); } ui.setQueueOpen(false); }}>
              <Icon name="play" filled size={16} /> {player.mode() === "closed" ? "Play" : "Play next now"}
            </button>
          </div>
        </div>
      </Show>
    </Sheet>
  );
}

/** Queue button with a count badge: in every page header and in the player. */
export function QueueButton(props: { class?: string }) {
  return (
    <button class={props.class ?? "icon-btn"} classList={{ "queue-btn": true }} aria-label={`Queue (${queue.count()})`} title="Queue" onClick={() => ui.setQueueOpen(true)}>
      <Icon name="queue" />
      <Show when={queue.count() > 0}><span class="count-badge">{queue.count() > 99 ? "99+" : queue.count()}</span></Show>
    </button>
  );
}

export default function GlobalSheets() {
  return (<><CardMenu /><QueueSheet /><ContinueBar /></>);
}
