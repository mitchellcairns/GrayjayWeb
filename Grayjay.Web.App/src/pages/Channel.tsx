import { Show, createEffect, createResource, createSignal, on } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { channel as channelApi, subscriptions } from "../api";
import { createPager } from "../lib/pager";
import { formatCount, joinDot } from "../lib/format";
import Feed from "../components/Feed";
import { Avatar } from "../components/ContentCard";
import RichText from "../components/RichText";
import { toast, toastError } from "../components/Toasts";
import PageHeader from "../shell/PageHeader";
import "./Channel.css";

export default function Channel() {
  const [params] = useSearchParams();
  const url = () => (typeof params.url === "string" ? params.url : "");
  const [tab, setTab] = createSignal<"videos" | "playlists" | "about">("videos");

  const [ch] = createResource(url, (u) => channelApi.load(u));
  const [subscribed, { mutate }] = createResource(url, (u) => subscriptions.isSubscribed(u).catch(() => false));
  const [canPlaylists] = createResource(url, (u) => channelApi.canGetPlaylists(u).catch(() => false));

  const videos = createPager(() => channelApi.contentLoad(url()), () => channelApi.contentNext());
  const playlists = createPager(() => channelApi.playlistsLoad(url()), () => channelApi.playlistsNext());
  createEffect(on(url, (u) => { if (u) { setTab("videos"); videos.reload(); } }));
  createEffect(on(tab, (t) => { if (t === "playlists" && !playlists.loaded()) playlists.reload(); }, { defer: true }));

  const toggle = async () => {
    try {
      if (subscribed()) { await subscriptions.unsubscribe(url()); mutate(false); toast("Unsubscribed"); }
      else { await subscriptions.subscribe(url()); mutate(true); toast(`Subscribed to ${ch()?.name ?? "channel"}`); }
    } catch (e) { toastError(e); }
  };

  return (
    <>
      <PageHeader back title={ch()?.name} />
      <main class="page channel-page">
        <Show when={ch()?.banner}>
          <div class="channel-banner"><img src={ch()!.banner} alt="" referrerpolicy="no-referrer" /></div>
        </Show>
        <div class="channel-head">
          <Avatar src={ch()?.thumbnail} name={ch()?.name} size={72} />
          <div class="channel-id">
            <h1>{ch()?.name ?? (ch.loading ? "" : "Channel")}</h1>
            <p class="muted">{joinDot(ch()?.subscribers && ch()!.subscribers! > 0 ? `${formatCount(ch()!.subscribers)} subscribers` : "", ch()?.id?.platform)}</p>
          </div>
        </div>
        <div class="row" style={{ margin: "14px 0 6px" }}>
          <button class={`btn ${subscribed() ? "" : "primary"}`} style={{ flex: 1, "max-width": "320px" }} onClick={toggle} disabled={subscribed.loading}>
            {subscribed() ? "Subscribed" : "Subscribe"}
          </button>
          <a class="btn" href={url()} target="_blank" rel="noreferrer">Open</a>
        </div>
        <Show when={ch.error}><div class="feed-status">{(ch.error as Error).message}</div></Show>

        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={tab() === "videos"} onClick={() => setTab("videos")}>Videos</button>
          <Show when={canPlaylists()}><button role="tab" aria-selected={tab() === "playlists"} onClick={() => setTab("playlists")}>Playlists</button></Show>
          <button role="tab" aria-selected={tab() === "about"} onClick={() => setTab("about")}>About</button>
        </div>

        <Show when={tab() === "videos"}><Feed pager={videos} hideAuthor /></Show>
        <Show when={tab() === "playlists"}><Feed pager={playlists} hideAuthor /></Show>
        <Show when={tab() === "about"}>
          <div class="card" style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere" }}>
            <RichText text={ch()?.description || "No description."} />
          </div>
        </Show>
      </main>
    </>
  );
}
