import { Show, createResource, onCleanup, onMount } from "solid-js";
import { A } from "@solidjs/router";
import { home, sources } from "../api";
import { on } from "../api/socket";
import { createPager } from "../lib/pager";
import Feed from "../components/Feed";
import Icon from "../components/Icon";
import PageHeader from "../shell/PageHeader";
import { usePullToRefresh } from "../lib/pull";

export default function Home() {
  const [enabled, { refetch }] = createResource(() => sources.enabled().catch(() => []));
  const pager = createPager(home.loadLazy, home.next, { eagerSecondPage: true });

  onMount(() => pager.reload());
  const off = on("EnabledClientsChanged", () => { refetch(); pager.reload(); });
  onCleanup(off);
  usePullToRefresh(() => pager.reload());

  return (
    <>
      <PageHeader title="Discover" actions={<>
        <A href="/search" class="icon-btn" aria-label="Search"><Icon name="search" /></A>
        <A href="/settings" class="icon-btn" aria-label="Settings"><Icon name="settings" /></A>
      </>} />
      <main class="page">
        <Show when={enabled.state === "ready" && enabled()!.length === 0} fallback={
          <Feed pager={pager} empty={<div class="empty"><Icon name="discover" /><h3>Nothing to discover yet</h3><p>Pull down to refresh, or check your sources.</p></div>} />
        }>
          <div class="empty">
            <img src="/app/logo.svg" alt="" width="64" height="64" />
            <h3>Welcome to Grayjay</h3>
            <p>Grayjay brings YouTube, PeerTube, Twitch and many more into one app. Pick the sources you want to start.</p>
            <A href="/sources" class="btn accent">Choose sources</A>
          </div>
        </Show>
      </main>
    </>
  );
}
