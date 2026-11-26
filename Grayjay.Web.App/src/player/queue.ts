// Play queue: what plays after the current video (before any "Up next" recommendation). One queue shared by all your
// devices through the server; cached in localStorage so it shows instantly and survives a flaky connection.
import { createRoot } from "solid-js";
import { Content, deviceSync } from "../api";
import { on } from "../api/socket";
import { stored } from "../lib/stored";
import { self } from "../lib/self";

/** Only what the queue UI and the player's preview need. */
function slim(c: Content): Content {
  return {
    contentType: c.contentType, id: c.id, name: c.name ?? c.contentName, url: c.url, author: c.author,
    thumbnails: c.thumbnails ?? c.contentThumbnails, duration: c.duration, dateTime: c.dateTime, viewCount: c.viewCount, isLive: c.isLive,
    resumeAt: c.resumeAt,
  } as Content;
}

export const queue = createRoot(() => {
  const [items, setLocal] = stored<Content[]>("gj.queue", []);
  /**
   * The video you were on before the last Next (one step only): Previous goes back to it. Pressing Next again replaces
   * it, so an accidental skip is always undoable but the history doesn't pile up.
   */
  const [previous, setPreviousRaw] = stored<Content | null>("gj.queue.previous", null);
  let pushTimer: number | undefined;
  let pending = false;

  const push = () => {
    pending = true;
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(async () => {
      try { await deviceSync.saveQueue(items(), self.clientId); } catch { }
      pending = false;
    }, 250);
  };
  const setItems = (l: Content[]) => { setLocal(l); push(); };

  const pull = async () => {
    try {
      const s = await deviceSync.queue();
      if (pending) return; // our own newer change is on its way up
      if (!s.saved && items().length) { push(); return; } // first run with sync: upload this device's queue
      setLocal(s.items ?? []);
    } catch { }
  };
  pull();
  on("QueueChanged", () => pull());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pull(); });

  const has = (url?: string) => !!url && items().some((i) => i.url === url);
  const remove = (url: string) => { if (has(url)) setItems(items().filter((i) => i.url !== url)); };
  return {
    items,
    previous,
    setPrevious: (c: Content | null) => setPreviousRaw(c ? slim(c) : null),
    has,
    count: () => items().length,
    add(c: Content) { if (!has(c.url)) setItems([...items(), slim(c)]); },
    /** Put it at the front (plays right after the current video). */
    addNext(c: Content) { setItems([slim(c), ...items().filter((i) => i.url !== c.url)]); },
    remove,
    /** One-tap add/remove; returns true when it's now in the queue. */
    toggle(c: Content) {
      if (has(c.url)) { remove(c.url); return false; }
      setItems([...items(), slim(c)]); return true;
    },
    move(index: number, delta: number) {
      const l = [...items()], j = index + delta;
      if (j < 0 || j >= l.length) return;
      [l[index], l[j]] = [l[j], l[index]];
      setItems(l);
    },
    /** Drag-and-drop: take the item at `from` and put it at `to` (index in the list after removal). */
    moveTo(from: number, to: number) {
      const l = [...items()];
      if (from < 0 || from >= l.length) return;
      const [it] = l.splice(from, 1);
      const j = Math.max(0, Math.min(l.length, to));
      if (j === from) return;
      l.splice(j, 0, it);
      setItems(l);
    },
    clear() { setItems([]); },
    /** Removes and returns the next item. */
    shift(): Content | undefined {
      const [first, ...rest] = items();
      if (first) setItems(rest);
      return first;
    },
    take(url: string): Content | undefined {
      const it = items().find((i) => i.url === url);
      if (it) remove(url);
      return it;
    },
  };
});
