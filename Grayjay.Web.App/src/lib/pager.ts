// Reactive wrapper around Grayjay's server-side pagers (load + next page), including "lazy" pagers whose
// placeholder items are filled in later via "PagerUpdated" socket packets.
import { createSignal, onCleanup } from "solid-js";
import type { PagerResult } from "../api";
import { on } from "../api/socket";

export interface Pager<T> {
  items: () => T[];
  loading: () => boolean;
  hasMore: () => boolean;
  error: () => Error | null;
  loaded: () => boolean;
  next: () => Promise<void>;
  reload: () => Promise<void>;
}

export function createPager<T>(
  load: () => Promise<PagerResult<T>>,
  next: () => Promise<PagerResult<T>>,
  opts: { eagerSecondPage?: boolean; filter?: (item: T) => boolean } = {},
): Pager<T> {
  const [items, setItems] = createSignal<T[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [hasMore, setHasMore] = createSignal(true);
  const [error, setError] = createSignal<Error | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  let pagerId: string | undefined;
  let generation = 0;
  let firstPageSize = 0;

  const keep = (list: T[]) => (opts.filter ? list.filter(opts.filter) : list);

  const off = on<PagerResult<T>>("PagerUpdated", (packet) => {
    if (!pagerId || packet.id !== pagerId) return;
    // Like the desktop client, an update carries the pager's full refreshed result set (placeholders resolved).
    const updated = keep(packet.payload?.results ?? []);
    setItems(updated);
    firstPageSize = updated.length;
    if (packet.payload && typeof packet.payload.hasMore === "boolean") setHasMore(packet.payload.hasMore);
  });
  onCleanup(off);

  async function run(fn: () => Promise<PagerResult<T>>, replace: boolean) {
    const gen = generation;
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      if (gen !== generation) return;
      if (result.exception) console.warn("pager exception", result.exception);
      const results = keep(result.results ?? []);
      if (replace) {
        pagerId = result.pagerID;
        firstPageSize = results.length;
        setItems(results);
      } else {
        setItems((cur) => [...cur, ...results]);
      }
      setHasMore(!!result.hasMore);
      setLoaded(true);
    } catch (e: any) {
      if (gen !== generation) return;
      setError(e);
      setHasMore(false);
    } finally {
      if (gen === generation) setLoading(false);
    }
  }

  const pager: Pager<T> = {
    items, loading, hasMore, error, loaded,
    async next() {
      if (loading() || !hasMore()) return;
      await run(next, false);
    },
    async reload() {
      generation++;
      setHasMore(true);
      setLoaded(false);
      await run(load, true);
      // Skip the eager second page while the first is still lazy placeholders (it would only add more placeholders).
      const allPlaceholders = items().length > 0 && items().every((x: any) => x?.contentType === 90);
      if (opts.eagerSecondPage && hasMore() && !error() && !allPlaceholders) await pager.next();
    },
  };
  return pager;
}
