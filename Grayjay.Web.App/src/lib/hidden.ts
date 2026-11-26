// Creators you never want to see again: kept on the server (so every device agrees), filtered here in every feed.
import { createMemo, createRoot, createSignal } from "solid-js";
import { AuthorLink, HiddenCreator, hiddenCreators } from "../api";
import { on } from "../api/socket";

const keyOf = (platform?: string, id?: string) => (platform && id ? `${platform}:${id}` : "");

export const hidden = createRoot(() => {
  const [list, setList] = createSignal<HiddenCreator[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const idx = createMemo(() => {
    const urls = new Set<string>(), ids = new Set<string>();
    for (const c of list()) { urls.add(c.url.toLowerCase()); const k = keyOf(c.platform, c.id); if (k) ids.add(k); }
    return { urls, ids };
  });

  const refresh = async () => {
    try { const l = await hiddenCreators.list(); setList(l); } catch { }
    setLoaded(true);
  };
  refresh();
  on("HiddenCreatorsChanged", () => refresh());

  const fromAuthor = (a: AuthorLink): HiddenCreator => ({ url: a.url, name: a.name, thumbnail: a.thumbnail, platform: a.id?.platform, id: a.id?.value });

  return {
    list, loaded, refresh,
    /** Reactive: re-evaluates when the list changes. */
    isHidden(a?: AuthorLink | null) {
      const { urls, ids } = idx();
      if (!a?.url) return false;
      return urls.has(a.url.toLowerCase()) || ids.has(keyOf(a.id?.platform, a.id?.value));
    },
    async hide(a: AuthorLink) {
      const c = fromAuthor(a);
      setList((l) => [c, ...l.filter((x) => x.url !== c.url)]);
      try { await hiddenCreators.add(c); } catch (e) { await refresh(); throw e; }
    },
    async unhide(c: HiddenCreator) {
      setList((l) => l.filter((x) => x.url !== c.url && !(c.id && x.id === c.id && x.platform === c.platform)));
      try { await hiddenCreators.remove(c); } catch (e) { await refresh(); throw e; }
    },
    fromAuthor,
  };
});
