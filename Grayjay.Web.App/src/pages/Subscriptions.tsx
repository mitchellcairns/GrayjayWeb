import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { A } from "@solidjs/router";
import { subscriptions } from "../api";
import { on } from "../api/socket";
import { createPager } from "../lib/pager";
import { usePullToRefresh } from "../lib/pull";
import { channelHref } from "../lib/nav";
import Feed from "../components/Feed";
import Icon from "../components/Icon";
import Sheet from "../components/Sheet";
import { Avatar } from "../components/ContentCard";
import PageHeader from "../shell/PageHeader";

export default function Subscriptions() {
  const [groups] = createResource(() => subscriptions.groups().catch(() => []));
  const [subs, { refetch: refetchSubs }] = createResource(() => subscriptions.list().catch(() => []));
  const [group, setGroup] = createSignal<string | null>(null);
  const [channelsOpen, setChannelsOpen] = createSignal(false);

  const pager = createPager(
    () => (group() ? subscriptions.groupLoad(group()!, false) : subscriptions.loadLazy(false)),
    () => (group() ? subscriptions.groupNext(group()!) : subscriptions.next()),
  );
  const refresh = () => pager.reload();
  onMount(refresh);
  usePullToRefresh(async () => {
    await (group() ? subscriptions.groupLoad(group()!, true) : subscriptions.loadLazy(true));
    await pager.reload();
  });
  const off = on("SubscriptionsChanged", () => { refetchSubs(); refresh(); });
  onCleanup(off);

  const pick = (id: string | null) => { setGroup(id); refresh(); };

  return (
    <>
      <PageHeader title="Subscriptions" actions={
        <button class="icon-btn" aria-label="Channels" onClick={() => setChannelsOpen(true)}><Icon name="users" /></button>
      } />
      <main class="page">
        <Show when={(groups()?.length ?? 0) > 0}>
          <div class="chips" style={{ "margin-bottom": "14px" }}>
            <button class="chip" aria-pressed={group() === null} onClick={() => pick(null)}>All</button>
            <For each={groups()}>{(g) => <button class="chip" aria-pressed={group() === g.id} onClick={() => pick(g.id)}>{g.name}</button>}</For>
          </div>
        </Show>
        <Show when={subs.state === "ready" && subs()!.length === 0} fallback={<Feed pager={pager} />}>
          <div class="empty">
            <Icon name="subs" />
            <h3>No subscriptions yet</h3>
            <p>Subscribe to channels from any source and their new videos show up here, all in one place.</p>
            <A href="/search" class="btn accent">Find channels</A>
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
    </>
  );
}
