// App-wide sheets opened from anywhere (cards, player, top bar).
import { createRoot, createSignal } from "solid-js";
import type { Content } from "../api";

export const ui = createRoot(() => {
  const [cardMenu, setCardMenu] = createSignal<Content | null>(null);
  const [queueOpen, setQueueOpen] = createSignal(false);
  return { cardMenu, setCardMenu, queueOpen, setQueueOpen };
});
