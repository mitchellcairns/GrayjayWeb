import { For, Show, createEffect, createResource, createSignal, on } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { channel as channelApi, subscriptions } from "../api";
import { createPager } from "../lib/pager";
import { formatCount, joinDot } from "../lib/format";
import Feed from "../components/Feed";
import { Avatar } from "../components/ContentCard";
import RichText from "../components/RichText";
import Sheet from "../components/Sheet";
import { toast, toastError } from "../components/Toasts";
import PageHeader from "../shell/PageHeader";
import Icon from "../components/Icon";
import { hidden } from "../lib/hidden";
import "./Channel.css";

const TYPE_LABELS: Record<string, string> = { VIDEOS: "Videos", STREAMS: "Live", LIVE: "Live now", SHORTS: "Shorts", POSTS: "Posts" };

/**
 * A channel is its videos: newest first, filling the page. Everything else (search, playlists, about, hide) is a small
 * button. Type chips (Videos / Live / Shorts) appear only when the source offers more than one. (No "Popular" sort:
 * YouTube's plugin advertises it but ignores it.)
 */
export default function Channel() {
  const [params] = useSearchParams();
  const url = () => (typeof params.url === "string" ? params.url : "");

  const [ch] = createResource(url, (u) => channelApi.load(u));
  // Subscriptions are stored under the channel's canonical URL (e.g. /channel/UC…), not the handle URL you may have opened.
  const canonicalUrl = () => ch()?.url || url();
  const [subscribed, { mutate }] = createResource(() => (ch.loading ? undefined : canonicalUrl()), (u) => subscriptions.isSubscribed(u).catch(() => false));
  const [caps] = createResource(url, (u) => channelApi.capabilities(u).catch(() => ({ types: [], sorts: [], search: false, playlists: false })));

  // What the video list shows.
  const [type, setType] = createSignal<string | null>(null); // null = everything (videos + streams, newest first)
  const [order] = createSignal("CHRONOLOGICAL");
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchText, setSearchText] = createSignal("");
  const [query, setQuery] = createSignal("");
  const types = () => (caps()?.types ?? []).filter((t) => TYPE_LABELS[t]);

  const videos = createPager(
    () => {
      if (query()) return channelApi.search(url(), query());
      if (type() || order() !== "CHRONOLOGICAL") return channelApi.contentLoadTyped(url(), type() ?? undefined, order());
      return channelApi.contentLoad(url());
    },
    () => channelApi.contentNext(),
  );
  createEffect(on([url, type, order, query], ([u]) => { if (u) videos.reload(); }));
  createEffect(on(url, () => { setType(null); setQuery(""); setSearchText(""); setSearchOpen(false); }, { defer: true }));

  const [playlistsOpen, setPlaylistsOpen] = createSignal(false);
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const playlists = createPager(() => channelApi.playlistsLoad(url()), () => channelApi.playlistsNext());
  createEffect(on(playlistsOpen, (o) => { if (o) playlists.reload(); }, { defer: true }));

  const toggle = async () => {
    try {
      if (subscribed()) { await subscriptions.unsubscribe(canonicalUrl()); mutate(false); toast("Unsubscribed"); }
      else { await subscriptions.subscribe(canonicalUrl()); mutate(true); toast(`Subscribed to ${ch()?.name ?? "channel"}`); }
    } catch (e) { toastError(e); }
  };

  // Hide/unhide this creator everywhere (Discover, Subscriptions, search, Up next).
  const author = () => ({ id: ch()?.id ?? { platform: "" }, name: ch()?.name ?? "", url: canonicalUrl(), thumbnail: ch()?.thumbnail });
  const isHidden = () => hidden.isHidden(author()) || hidden.isHidden({ ...author(), url: url() });
  const toggleHidden = async () => {
    try {
      if (isHidden()) {
        const match = hidden.list().find((c) => [url(), canonicalUrl()].some((u) => u.toLowerCase() === c.url.toLowerCase()) || (c.id && c.id === ch()?.id?.value));
        await hidden.unhide(match ?? hidden.fromAuthor(author()));
        toast(`${ch()?.name ?? "Creator"} is visible again`);
      } else {
        await hidden.hide(author());
        toast(`Hidden ${ch()?.name ?? "creator"} from your feeds`);
      }
    } catch (e) { toastError(e); }
  };

  let searchInput!: HTMLInputElement;
  const openSearch = () => { setSearchOpen(true); queueMicrotask(() => searchInput?.focus()); };
  const closeSearch = () => { setSearchOpen(false); setSearchText(""); setQuery(""); };

  return (
    <>
      <PageHeader back title={ch()?.name} />
      <main class="page channel-page">
        <Show when={ch()?.banner}>
          <div class="channel-banner"><img src={ch()!.banner} alt="" referrerpolicy="no-referrer" /></div>
        </Show>
        <div class="channel-head">
          <Avatar src={ch()?.thumbnail} name={ch()?.name} size={56} />
          <div class="channel-id">
            <h1>{ch()?.name ?? (ch.loading ? "" : "Channel")}</h1>
            <p class="muted">{joinDot(ch()?.subscribers && ch()!.subscribers! > 0 ? `${formatCount(ch()!.subscribers)} subscribers` : "", ch()?.id?.platform)}</p>
          </div>
          <button class={`btn ${subscribed() ? "" : "primary"} channel-sub`} onClick={toggle} disabled={subscribed.loading || !ch()}>
            {subscribed() ? "Subscribed" : "Subscribe"}
          </button>
        </div>

        <div class="channel-tools">
          <Show when={caps()?.search}>
            <button class="btn small ghost" classList={{ "is-on": searchOpen() }} onClick={() => (searchOpen() ? closeSearch() : openSearch())}><Icon name="search" size={16} /><span>Search</span></button>
          </Show>
          <Show when={caps()?.playlists}>
            <button class="btn small ghost" onClick={() => setPlaylistsOpen(true)}><Icon name="list" size={16} /><span>Playlists</span></button>
          </Show>
          <button class="btn small ghost" onClick={() => setAboutOpen(true)} disabled={!ch()}><Icon name="info" size={16} /><span>About</span></button>
          <button class="btn small ghost" onClick={toggleHidden} disabled={!ch()} title={isHidden() ? "Show this creator in your feeds again" : "Never show this creator in Discover, Subscriptions, search or Up next"}>
            <Icon name={isHidden() ? "show" : "hide"} size={16} /><span>{isHidden() ? "Unhide" : "Hide"}</span>
          </button>
          <a class="btn small ghost" href={url()} target="_blank" rel="noreferrer"><Icon name="external" size={16} /><span>Open</span></a>
        </div>

        <Show when={searchOpen()}>
          <form class="channel-search" onSubmit={(e) => { e.preventDefault(); setQuery(searchText().trim()); searchInput.blur(); }}>
            <input ref={searchInput} class="field" type="search" enterkeyhint="search" placeholder={`Search ${ch()?.name ?? "this channel"}`}
              value={searchText()} onInput={(e) => { setSearchText(e.currentTarget.value); if (!e.currentTarget.value) setQuery(""); }} />
            <button type="button" class="btn small ghost" onClick={closeSearch}>Cancel</button>
          </form>
        </Show>

        <Show when={!query() && types().length > 1}>
          <div class="channel-filters">
            <Show when={types().length > 1}>
              <div class="chips">
                <button class="chip" aria-pressed={type() === null} onClick={() => setType(null)}>All</button>
                <For each={types()}>{(t) => <button class="chip" aria-pressed={type() === t} onClick={() => setType(t)}>{TYPE_LABELS[t]}</button>}</For>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={query()}>
          <p class="muted channel-results">Results for “{query()}”</p>
        </Show>

        <Show when={ch.error}><div class="feed-status">{(ch.error as Error).message}</div></Show>
        <Feed pager={videos} hideAuthor allowHidden
          empty={<div class="empty"><h3>{query() ? "No matching videos" : "No videos"}</h3></div>} />
      </main>

      <Sheet open={playlistsOpen()} onClose={() => setPlaylistsOpen(false)} title="Playlists" size="tall">
        <Feed pager={playlists} layout="list" hideAuthor allowHidden empty={<div class="empty"><h3>No playlists</h3></div>} />
      </Sheet>
      <Sheet open={aboutOpen()} onClose={() => setAboutOpen(false)} title={ch()?.name ?? "About"}>
        <div style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere" }}>
          <RichText text={ch()?.description || "No description."} />
        </div>
      </Sheet>
    </>
  );
}
