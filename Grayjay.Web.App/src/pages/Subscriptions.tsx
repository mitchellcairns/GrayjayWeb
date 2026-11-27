import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { A } from "@solidjs/router";
import { Content, ContentType, subscriptions } from "../api";
import { on } from "../api/socket";
import { createPager } from "../lib/pager";
import { usePullToRefresh } from "../lib/pull";
import { channelHref } from "../lib/nav";
import Feed from "../components/Feed";
import Icon from "../components/Icon";
import Sheet from "../components/Sheet";
import { Avatar } from "../components/ContentCard";
import GroupManager from "../components/GroupManager";
import SourceChips, { createSourceFilter } from "../components/SourceFilter";
import PageHeader from "../shell/PageHeader";
import "./Subscriptions.css";

const isReal = (x: Content) => x.contentType !== ContentType.PLACEHOLDER;

export default function Subscriptions() {
  const [groups, { refetch: refetchGroups }] = createResource(() => subscriptions.groups().catch(() => []));
  const [subs, { refetch: refetchSubs }] = createResource(() => subscriptions.list().catch(() => []));
  const [group, setGroup] = createSignal<string | null>(null);
  const [channelsOpen, setChannelsOpen] = createSignal(false);
  const [groupsOpen, setGroupsOpen] = createSignal(false);
  const [progress, setProgress] = createSignal<{ progress: number; total: number } | null>(null);
  // Filtered here: the feed merges every subscription, so this just hides other sources' videos.
  const filter = createSourceFilter("subscriptions");
  const subSources = createMemo(() => {
    const ids = new Set((subs() ?? []).map((s) => s.channel.id?.pluginID).filter(Boolean));
    return (filter.enabled() ?? []).filter((c) => ids.has(c.id));
  });

  // Like the desktop app: show the cached feed instantly, and switch to the live feed once the server has refreshed it.
  const cache = createPager(subscriptions.cacheLoad, subscriptions.cacheNext);
  const live = createPager(
    () => (group() ? subscriptions.groupLoad(group()!, false) : subscriptions.loadLazy(false)),
    () => (group() ? subscriptions.groupNext(group()!) : subscriptions.next()),
  );
  const liveReady = () => group() !== null || live.updated() || (live.loaded() && live.items().some(isReal));
  const pager = createMemo(() => (liveReady() ? live : cache));

  const refresh = (updated = false) => {
    if (!group()) cache.reload();
    if (updated) {
      (group() ? subscriptions.groupLoad(group()!, true) : subscriptions.loadLazy(true)).then(() => live.reload()).catch(() => live.reload());
    } else live.reload();
  };
  onMount(() => refresh());
  usePullToRefresh(() => refresh(true));

  const offs = [
    on("SubscriptionsChanged", () => { refetchSubs(); }),
    on("SubscriptionGroupsChanged", () => refetchGroups()),
    on<{ progress: number; total: number }>("subProgress", (p) => {
      if ((p.id ?? "global") !== (group() ?? "global")) return;
      const v = p.payload;
      setProgress(v && v.total > 0 && v.progress < v.total ? v : null);
    }),
  ];
  onCleanup(() => offs.forEach((o) => o()));

  const pick = (id: string | null) => { setGroup(id); setProgress(null); refresh(); };
  const sortedGroups = () => [...(groups() ?? [])].sort((a, b) => a.priority - b.priority);

  return (
    <>
      <PageHeader logo actions={<>
        <button class="icon-btn" aria-label="Your channels" title="Your channels" onClick={() => setChannelsOpen(true)}><Icon name="users" /></button>
        <A href="/search" class="icon-btn" aria-label="Search"><Icon name="search" /></A>
        <A href="/settings" class="icon-btn" aria-label="Settings"><Icon name="settings" /></A>
      </>} />
      <Show when={progress()}>
        <div class="sub-progress" role="progressbar" aria-label="Refreshing subscriptions" aria-valuemin={0} aria-valuemax={progress()!.total} aria-valuenow={progress()!.progress}>
          <div style={{ width: `${(progress()!.progress / progress()!.total) * 100}%` }} />
        </div>
      </Show>
      <main class="page">
        <Show when={(subs()?.length ?? 0) > 0}>
          <div class="chips sub-chips">
            <button class="chip" aria-pressed={group() === null} onClick={() => pick(null)}>All</button>
            <For each={sortedGroups()}>{(g) => <button class="chip" aria-pressed={group() === g.id} onClick={() => pick(g.id)}>{g.name}</button>}</For>
            <button class="chip chip-edit" onClick={() => setGroupsOpen(true)} aria-label="Edit groups" title="Edit groups">
              <Icon name={(groups()?.length ?? 0) > 0 ? "settings" : "plus"} size={14} /> {(groups()?.length ?? 0) > 0 ? "Edit" : "New group"}
            </button>
          </div>
        </Show>
        <Show when={subs.state === "ready" && subs()!.length === 0} fallback={<>
          <SourceChips sources={subSources()} selected={filter.selected()} onPick={(id) => { filter.set(id); scrollTo({ top: 0 }); }} />
          <Feed pager={pager()} match={filter.matches} empty={filter.selected()
            ? <div class="empty"><Icon name="subs" /><h3>Nothing new from {subSources().find((c) => c.id === filter.selected())?.name ?? "this source"}</h3><p>Pull down to refresh, or pick All sources.</p></div>
            : undefined} />
        </>}>
          <div class="empty">
            <Icon name="subs" />
            <h3>No subscriptions yet</h3>
            <p>Subscribe to channels from any source and their new videos show up here, all in one place.</p>
            <div class="row" style={{ "flex-wrap": "wrap", "justify-content": "center" }}>
              <A href="/setup" class="btn accent">Import or sync subscriptions</A>
              <A href="/search" class="btn">Find channels</A>
            </div>
          </div>
        </Show>
      </main>

      <Sheet open={channelsOpen()} onClose={() => setChannelsOpen(false)} title={`Channels (${subs()?.length ?? 0})`} size="tall">
        <div class="list">
          <For each={subs()}>
            {(s) => (
              <A class="list-item" href={channelHref(s.channel.url)} onClick={() => setChannelsOpen(false)}>
                <Avatar src={s.channel.thumbnail} name={s.channel.name} size={40} />
                <div class="grow"><div class="title">{s.channel.name}</div><div class="sub">{s.channel.id?.platform}</div></div>
              </A>
            )}
          </For>
        </div>
      </Sheet>

      <Sheet open={groupsOpen()} onClose={() => setGroupsOpen(false)} title="Subscription groups" size="tall">
        <GroupManager groups={sortedGroups()} subscriptions={subs() ?? []} onChanged={() => refetchGroups()} />
      </Sheet>
    </>
  );
}
