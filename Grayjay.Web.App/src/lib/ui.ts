// App-wide sheets opened from anywhere (cards, player, top bar).
import { createRoot, createSignal } from "solid-js";
import type { Content } from "../api";

export const ui = createRoot(() => {
  const [cardMenu, setCardMenu] = createSignal<Content | null>(null);
  const [queueOpen, setQueueOpen] = createSignal(false);
  /** The video the download sheet (quality choice) is open for. */
  const [downloadFor, setDownloadFor] = createSignal<Pick<Content, "url" | "name"> | null>(null);
  return { cardMenu, setCardMenu, queueOpen, setQueueOpen, downloadFor, setDownloadFor };
});
