// Play queue: what plays after the current video (before any "Up next" recommendation). Per device, survives reloads.
import { createRoot } from "solid-js";
import type { Content } from "../api";
import { stored } from "../lib/stored";

/** Only what the queue UI and the player's preview need, so localStorage stays small. */
function slim(c: Content): Content {
  return {
    contentType: c.contentType, id: c.id, name: c.name ?? c.contentName, url: c.url, author: c.author,
    thumbnails: c.thumbnails ?? c.contentThumbnails, duration: c.duration, dateTime: c.dateTime, viewCount: c.viewCount, isLive: c.isLive,
  } as Content;
}

export const queue = createRoot(() => {
  const [items, setItems] = stored<Content[]>("gj.queue", []);
  const has = (url?: string) => !!url && items().some((i) => i.url === url);
  return {
    items,
    has,
    count: () => items().length,
    add(c: Content) { if (!has(c.url)) setItems([...items(), slim(c)]); },
    /** Put it at the front (plays right after the current video). */
    addNext(c: Content) { setItems([slim(c), ...items().filter((i) => i.url !== c.url)]); },
    remove(url: string) { setItems(items().filter((i) => i.url !== url)); },
    /** One-tap add/remove; returns true when it's now in the queue. */
    toggle(c: Content) {
      if (has(c.url)) { this.remove(c.url); return false; }
      this.add(c); return true;
    },
    move(index: number, delta: number) {
      const l = [...items()], j = index + delta;
      if (j < 0 || j >= l.length) return;
      [l[index], l[j]] = [l[j], l[index]];
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
      if (it) this.remove(url);
      return it;
    },
  };
});
