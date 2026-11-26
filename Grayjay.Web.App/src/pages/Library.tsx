import { For, Show, createSignal, onMount } from "solid-js";
import { history as historyApi } from "../api";
import { createPager } from "../lib/pager";
import { formatAgo } from "../lib/format";
import ContentCard, { SkeletonCard } from "../components/ContentCard";
import Icon from "../components/Icon";
import PageHeader from "../shell/PageHeader";

export default function Library() {
  const [query, setQuery] = createSignal("");
  const pager = createPager<any>(
    () => (query() ? historyApi.search(query()) : historyApi.load()),
    () => historyApi.next(),
  );
  onMount(() => pager.reload());

  let t: number | undefined;
  const onSearch = (v: string) => { setQuery(v); clearTimeout(t); t = window.setTimeout(() => pager.reload(), 250); };

  return (
    <>
      <PageHeader title="Library" />
      <main class="page">
        <h2 class="section-title" style={{ "margin-top": "4px" }}>History</h2>
        <input class="field" type="search" placeholder="Search history" value={query()} onInput={(e) => onSearch(e.currentTarget.value)} style={{ "margin-bottom": "14px" }} />
        <div class="feed-list">
          <For each={pager.items()}>
            {(h) => (
              <div>
                <ContentCard item={h.video} layout="row" progress={h.video?.duration ? h.position / h.video.duration : 0} />
                <div class="faint" style={{ "font-size": "11px", "margin-top": "4px" }}>Watched {formatAgo(h.date)}</div>
              </div>
            )}
          </For>
          <Show when={!pager.loaded() && pager.loading()}><For each={[1, 2, 3, 4]}>{() => <SkeletonCard layout="row" />}</For></Show>
        </div>
        <Show when={pager.loaded() && pager.items().length === 0}>
          <div class="empty"><Icon name="history" /><h3>Nothing watched yet</h3><p>Videos you watch appear here so you can pick up where you left off.</p></div>
        </Show>
        <Show when={pager.hasMore() && pager.loaded()}>
          <button class="btn block" style={{ "margin-top": "16px" }} disabled={pager.loading()} onClick={() => pager.next()}>Load more</button>
        </Show>
      </main>
    </>
  );
}
