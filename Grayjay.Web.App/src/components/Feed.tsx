import { For, JSX, Show, createEffect, onCleanup } from "solid-js";
import type { Content } from "../api";
import type { Pager } from "../lib/pager";
import ContentCard, { SkeletonCard } from "./ContentCard";
import Icon from "./Icon";

/** Infinite feed: grid on wide screens, edge-to-edge cards on phones. Loads more as the sentinel nears the viewport. */
export default function Feed(props: {
  pager: Pager<Content>;
  layout?: "grid" | "list";
  empty?: JSX.Element;
  hideAuthor?: boolean;
}) {
  let sentinel!: HTMLDivElement;
  const layout = () => props.layout ?? "grid";

  createEffect(() => {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) props.pager.next();
    }, { rootMargin: "1200px 0px" });
    io.observe(sentinel);
    onCleanup(() => io.disconnect());
  });

  // If the first page doesn't fill the screen, keep loading.
  createEffect(() => {
    const p = props.pager;
    if (p.loaded() && !p.loading() && p.hasMore() && sentinel) {
      const r = sentinel.getBoundingClientRect();
      if (r.top < innerHeight + 1200) queueMicrotask(() => p.next());
    }
  });

  return (
    <>
      <div class={layout() === "grid" ? "feed-grid" : "feed-list"}>
        <For each={props.pager.items()}>
          {(item) => <ContentCard item={item} layout={layout() === "grid" ? "grid" : "row"} hideAuthor={props.hideAuthor} />}
        </For>
        <Show when={!props.pager.loaded() && props.pager.loading()}>
          <For each={Array.from({ length: 8 })}>{() => <SkeletonCard layout={layout() === "grid" ? "grid" : "row"} />}</For>
        </Show>
      </div>
      <div ref={sentinel} class="feed-sentinel" />
      <Show when={props.pager.loaded() && props.pager.loading()}>
        <div class="feed-status"><div class="spinner" /></div>
      </Show>
      <Show when={props.pager.error()}>
        <div class="feed-status">
          <Icon name="alert" />
          <div>{props.pager.error()!.message}</div>
          <button class="btn small" onClick={() => props.pager.reload()}>Try again</button>
        </div>
      </Show>
      <Show when={props.pager.loaded() && !props.pager.loading() && !props.pager.error() && props.pager.items().length === 0}>
        {props.empty ?? <div class="empty"><h3>Nothing here yet</h3></div>}
      </Show>
    </>
  );
}
