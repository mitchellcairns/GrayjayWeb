// Watch later lives on the server (shared by all your devices, and synced with Grayjay Android/Desktop via Grayjay Sync).
import { createMemo, createRoot, createSignal } from "solid-js";
import { Content, watchLater as api } from "../api";
import { on } from "../api/socket";

export const watchLater = createRoot(() => {
  const [items, setItems] = createSignal<Content[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const urls = createMemo(() => new Set(items().map((i) => i.url)));
  const refresh = async () => { try { setItems(await api.all()); } catch { } setLoaded(true); };
  refresh();
  on("WatchLaterChanged", () => refresh());
  return {
    items, loaded, refresh,
    has: (url?: string) => !!url && urls().has(url),
    async toggle(c: Content) {
      if (urls().has(c.url)) { setItems(items().filter((i) => i.url !== c.url)); await api.remove(c.url); return false; }
      setItems([c, ...items()]); await api.add(c); return true;
    },
    async remove(url: string) { setItems(items().filter((i) => i.url !== url)); await api.remove(url); },
  };
});
