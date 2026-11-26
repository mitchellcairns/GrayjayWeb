import { For, Show, createResource, createSignal, onMount } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { ContentType, handling, search } from "../api";
import { createPager } from "../lib/pager";
import { channelHref, isProbablyUrl } from "../lib/nav";
import { player } from "../player/store";
import Feed from "../components/Feed";
import Icon from "../components/Icon";
import { toastError } from "../components/Toasts";
import PageHeader from "../shell/PageHeader";
import "./Search.css";

const types = [
  { id: ContentType.MEDIA, label: "Videos" },
  { id: ContentType.CHANNEL, label: "Channels" },
  { id: ContentType.PLAYLIST, label: "Playlists" },
];

export async function openAnyUrl(url: string, navigate: (to: string) => void) {
  const plan = await handling.plan(url);
  if (plan.type === "content") player.open(plan.data ?? url);
  else if (plan.type === "channel") navigate(channelHref(plan.data ?? url));
  else if (plan.type === "playlist") window.open(url, "_blank");
  else throw new Error("None of your sources can open that link.");
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [text, setText] = createSignal(typeof params.q === "string" ? params.q : "");
  const [focused, setFocused] = createSignal(!params.q);
  const [type, setType] = createSignal<number>(Number(params.type) || ContentType.MEDIA);
  let input!: HTMLInputElement;

  const [previous, { refetch: refetchPrevious }] = createResource(() => search.previous().catch(() => []));
  const [suggestions] = createResource(() => (focused() ? text().trim() : ""), async (t) => {
    if (!t || isProbablyUrl(t)) return [];
    await new Promise((r) => setTimeout(r, 150));
    return t === text().trim() ? search.suggestions(t).catch(() => []) : [];
  });

  const pager = createPager(
    () => search.loadLazy(String(params.q ?? ""), type()),
    () => search.next(),
    { eagerSecondPage: true },
  );

  const run = async (query: string) => {
    const q = query.trim();
    if (!q) return;
    input?.blur();
    setFocused(false);
    setText(q);
    if (isProbablyUrl(q)) {
      try { await openAnyUrl(q, navigate); } catch (e) { toastError(e); }
      return;
    }
    search.addPrevious(q).then(() => refetchPrevious()).catch(() => { });
    setParams({ q, type: type() === ContentType.MEDIA ? undefined : String(type()) });
    pager.reload();
  };

  onMount(() => {
    if (params.q) pager.reload();
    else input?.focus();
  });

  const pickType = (t: number) => {
    setType(t);
    if (params.q) { setParams({ type: t === ContentType.MEDIA ? undefined : String(t) }); pager.reload(); }
  };

  const pasteFromClipboard = async () => {
    try { const t = await navigator.clipboard.readText(); if (t) run(t); } catch { }
  };

  return (
    <>
      <PageHeader>
        <form class="searchbar" role="search" onSubmit={(e) => { e.preventDefault(); run(text()); }}>
          <Icon name="search" size={18} />
          <input
            ref={input}
            type="search"
            enterkeyhint="search"
            autocomplete="off"
            autocorrect="off"
            placeholder="Search, or paste a link"
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
          />
          <Show when={text()}>
            <button type="button" class="icon-btn" aria-label="Clear" onClick={() => { setText(""); input.focus(); }}><Icon name="close" size={18} /></button>
          </Show>
        </form>
      </PageHeader>
      <main class="page">
        <Show when={focused() || !params.q} fallback={
          <>
            <div class="chips" style={{ "margin-bottom": "16px" }}>
              <For each={types}>{(t) => <button class="chip" aria-pressed={type() === t.id} onClick={() => pickType(t.id)}>{t.label}</button>}</For>
            </div>
            <Feed pager={pager} empty={<div class="empty"><Icon name="search" /><h3>No results</h3><p>Try different words, or enable more sources.</p></div>} />
          </>
        }>
          <div class="list search-suggest">
            <Show when={"clipboard" in navigator && "readText" in (navigator.clipboard ?? {}) && !text()}>
              <button class="list-item" onMouseDown={(e) => e.preventDefault()} onClick={pasteFromClipboard}>
                <Icon name="link" /><div class="grow"><div class="title">Paste a link</div><div class="sub">Open a video or channel URL from any source</div></div>
              </button>
            </Show>
            <For each={text().trim() ? suggestions() ?? [] : previous() ?? []}>
              {(s) => (
                <div class="list-item" role="button" tabindex="0" onMouseDown={(e) => e.preventDefault()} onClick={() => run(s)}>
                  <Icon name={text().trim() ? "search" : "history"} size={18} />
                  <div class="grow">{s}</div>
                  <Show when={!text().trim()}>
                    <button class="icon-btn" aria-label={`Remove ${s}`} onClick={(e) => { e.stopPropagation(); search.removePrevious(s).then(() => refetchPrevious()); }}><Icon name="close" size={16} /></button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </main>
    </>
  );
}
