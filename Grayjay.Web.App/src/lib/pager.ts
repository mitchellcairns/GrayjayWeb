// Reactive wrapper around Grayjay's server-side pagers (load + next page), including "lazy" pagers whose
// placeholder items are filled in later via "PagerUpdated" socket packets.
import { createSignal, onCleanup } from "solid-js";
import type { PagerResult } from "../api";
import { on } from "../api/socket";

// A lazy pager's real results can be pushed (PagerUpdated) before the HTTP reply that tells us its id arrives — the two
// travel on different connections. Remember recent updates so a pager can pick up one it would otherwise have missed.
const recentUpdates = new Map<string, { at: number; payload: any }>();
on<any>("PagerUpdated", (packet) => {
  if (!packet.id) return;
  const now = Date.now();
  for (const [id, u] of recentUpdates) if (now - u.at > 60_000) recentUpdates.delete(id);
  recentUpdates.set(packet.id, { at: now, payload: packet.payload });
});

const PLACEHOLDER = 90;
const isLoadingPlaceholder = (x: any) => x?.contentType === PLACEHOLDER && !x?.error;

export interface Pager<T> {
  items: () => T[];
  loading: () => boolean;
  hasMore: () => boolean;
  error: () => Error | null;
  loaded: () => boolean;
  /** True once the server pushed a PagerUpdated for this pager (lazy pagers: real results replaced placeholders). */
  updated: () => boolean;
  next: () => Promise<void>;
  reload: () => Promise<void>;
}

export function createPager<T>(
  load: () => Promise<PagerResult<T>>,
  next: () => Promise<PagerResult<T>>,
  opts: {
    eagerSecondPage?: boolean;
    filter?: (item: T) => boolean;
    /** Re-reads the current page without advancing. Polled while it still shows "loading" placeholders, in case the
     * WebSocket update with the real results never reaches us (e.g. the socket was reconnecting after the phone woke). */
    current?: () => Promise<PagerResult<T>>;
  } = {},
): Pager<T> {
  const [items, setItems] = createSignal<T[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [hasMore, setHasMore] = createSignal(true);
  const [error, setError] = createSignal<Error | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [updated, setUpdated] = createSignal(false);
  let pagerId: string | undefined;
  let generation = 0;
  let firstPageSize = 0;

  const keep = (list: T[]) => (opts.filter ? list.filter(opts.filter) : list);

  // Like the desktop client, an update carries the pager's full refreshed result set (placeholders resolved).
  const applyUpdate = (payload: PagerResult<T> | undefined) => {
    const results = keep(payload?.results ?? []);
    setItems(results);
    firstPageSize = results.length;
    setUpdated(true);
    if (payload && typeof payload.hasMore === "boolean") setHasMore(payload.hasMore);
  };
  const off = on<PagerResult<T>>("PagerUpdated", (packet) => {
    if (!pagerId || packet.id !== pagerId) return;
    applyUpdate(packet.payload);
  });
  let pollTimer: number | undefined;
  onCleanup(() => { off(); clearTimeout(pollTimer); });

  /** While the first page is still placeholders, re-read it now and then (gives up after ~40 s). */
  const pollWhileLoading = (gen: number, id: string | undefined, tries = 0) => {
    clearTimeout(pollTimer);
    if (!opts.current || tries >= 20) return;
    pollTimer = window.setTimeout(async () => {
      if (gen !== generation || id !== pagerId || !items().some(isLoadingPlaceholder)) return;
      try {
        const r = await opts.current!();
        if (gen !== generation || id !== pagerId) return;
        if (r.pagerID && r.pagerID !== id) return; // the server has moved on to another search
        if (!(r.results ?? []).some(isLoadingPlaceholder)) { applyUpdate(r); return; }
      } catch { }
      pollWhileLoading(gen, id, tries + 1);
    }, tries < 5 ? 1500 : 3000);
  };

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
        const early = pagerId ? recentUpdates.get(pagerId) : undefined;
        if (early) applyUpdate(early.payload); // the update beat the reply
        else if (results.some(isLoadingPlaceholder)) pollWhileLoading(gen, pagerId);
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
    items, loading, hasMore, error, loaded, updated,
    async next() {
      if (loading() || !hasMore()) return;
      await run(next, false);
    },
    async reload() {
      generation++;
      setHasMore(true);
      setLoaded(false);
      setUpdated(false);
      await run(load, true);
      // Skip the eager second page while the first is still lazy placeholders (it would only add more placeholders).
      const allPlaceholders = items().length > 0 && items().every((x: any) => x?.contentType === PLACEHOLDER);
      if (opts.eagerSecondPage && hasMore() && !error() && !allPlaceholders) await pager.next();
    },
  };
  return pager;
}
