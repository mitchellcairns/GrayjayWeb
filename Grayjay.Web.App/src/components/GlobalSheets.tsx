import { For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { Content } from "../api";
import { bestThumbnail, formatDuration, joinDot } from "../lib/format";
import { hidden } from "../lib/hidden";
import { channelHref } from "../lib/nav";
import { ui } from "../lib/ui";
import { queue } from "../player/queue";
import { player } from "../player/store";
import Icon from "./Icon";
import Sheet from "./Sheet";
import { toast, toastAction, toastError } from "./Toasts";
import "./GlobalSheets.css";

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
        <Show when={item()?.author?.url}>
          <button class="list-item" onClick={act((it) => navigate(channelHref(it.author!.url)))}>
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

function QueueRow(props: { item: Content; index: number; count: number }) {
  const play = () => { const it = queue.take(props.item.url); if (it) player.playNow(it.url, it); };
  return (
    <div class="queue-row">
      <button class="queue-open" onClick={play} aria-label={`Play ${props.item.name}`}>
        <div class="queue-thumb">
          <Show when={bestThumbnail(props.item.thumbnails, 320)}><img src={bestThumbnail(props.item.thumbnails, 320)} alt="" loading="lazy" referrerpolicy="no-referrer" /></Show>
          <Show when={props.item.duration}><span class="badge">{formatDuration(props.item.duration)}</span></Show>
        </div>
        <div class="queue-text">
          <div class="title">{props.item.name}</div>
          <div class="sub">{props.item.author?.name}</div>
        </div>
      </button>
      <div class="queue-ctl">
        <button class="icon-btn" aria-label="Move up" disabled={props.index === 0} onClick={() => queue.move(props.index, -1)}><Icon name="up" size={18} /></button>
        <button class="icon-btn" aria-label="Move down" disabled={props.index === props.count - 1} onClick={() => queue.move(props.index, 1)}><Icon name="down" size={18} /></button>
      </div>
      <button class="icon-btn" aria-label="Remove from queue" onClick={() => queue.remove(props.item.url)}><Icon name="close" size={18} /></button>
    </div>
  );
}

export function QueueList() {
  return (
    <div class="queue-list">
      <For each={queue.items()}>{(it, i) => <QueueRow item={it} index={i()} count={queue.count()} />}</For>
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
      <Show when={queue.count() > 0} fallback={
        <div class="empty"><Icon name="queue" /><h3>Your queue is empty</h3><p>Tap <Icon name="queueAdd" size={16} style={{ "vertical-align": "-3px" }} /> on any video to add it. Queued videos play before Up next suggestions.</p></div>
      }>
        <QueueList />
        <div class="row" style={{ "justify-content": "space-between", "margin-top": "12px" }}>
          <span class="faint">{queue.count()} video{queue.count() === 1 ? "" : "s"}</span>
          <div class="row" style={{ gap: "8px" }}>
            <button class="btn small ghost" onClick={() => queue.clear()}>Clear</button>
            <button class="btn small accent" onClick={() => { const it = queue.shift(); if (it) player.playNow(it.url, it); ui.setQueueOpen(false); }}>
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
  return (<><CardMenu /><QueueSheet /></>);
}
