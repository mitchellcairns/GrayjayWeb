import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { ContentType, handling, search, sources } from "../api";
import { createPager } from "../lib/pager";
import { channelHref, isProbablyUrl } from "../lib/nav";
import { player } from "../player/store";
import Feed from "../components/Feed";
import Icon from "../components/Icon";
import Sheet from "../components/Sheet";
import { toastError } from "../components/Toasts";
import PageHeader from "../shell/PageHeader";
import { iconOf } from "./Sources";
import "./Search.css";

const types = [
  { id: ContentType.MEDIA, label: "Videos" },
  { id: ContentType.CHANNEL, label: "Channels" },
  { id: ContentType.PLAYLIST, label: "Playlists" },
];

interface FilterGroup { id: string; name: string; isMultiSelect: boolean; filters: { name: string; value: string; id?: string }[] }
interface SourceCaps { id: string; name: string; config: any; sorts: string[]; filters: FilterGroup[] }

const SORT_LABELS: Record<string, string> = { chronological: "Upload date", views: "View count", rating: "Rating", relevance: "Relevance" };
// The server maps each selected filter by its id or display name (not its raw value) to what the plugin expects.
const filterKey = (f: { id?: string; name: string }) => f.id || f.name;
const sortLabel = (s: string) => SORT_LABELS[s.toLowerCase()] ?? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export async function openAnyUrl(url: string, navigate: (to: string) => void) {
  // The server also follows short links (t.co, search.app, bit.ly…) and redirect wrappers to the real address.
  const plan = await handling.resolve(url).catch(() => handling.plan(url));
  const target = plan.data || url;
  if (plan.type === "content") player.open(target);
  else if (plan.type === "channel") navigate(channelHref(target));
  else if (plan.type === "playlist") window.open(target, "_blank");
  else throw new Error("None of your sources can open that link.");
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const initialQuery = typeof params.q === "string" ? params.q : "";
  const [text, setText] = createSignal(initialQuery);
  // The submitted query. Kept separately from the URL because router params update asynchronously.
  const [query, setQuery] = createSignal(initialQuery);
  const [focused, setFocused] = createSignal(!initialQuery);
  const [type, setType] = createSignal<number>(Number(params.type) || ContentType.MEDIA);
  const [order, setOrder] = createSignal<string | null>(null);
  const [filters, setFilters] = createSignal<Record<string, string[]>>({});
  const [excluded, setExcluded] = createSignal<string[]>([]);
  const [filtersOpen, setFiltersOpen] = createSignal(false);
  let input!: HTMLInputElement;

  const [previous, { refetch: refetchPrevious }] = createResource(() => search.previous().catch(() => []));
  const [suggestions] = createResource(() => (focused() ? text().trim() : ""), async (t) => {
    if (!t || isProbablyUrl(t)) return [];
    await new Promise((r) => setTimeout(r, 150));
    return t === text().trim() ? search.suggestions(t).catch(() => []) : [];
  });

  // What the enabled sources can sort/filter by.
  const [caps] = createResource(async (): Promise<SourceCaps[]> => {
    const states = await sources.states().catch(() => []);
    const enabled = new Set((await sources.enabled().catch(() => [])).map((c) => c.id));
    return states
      .filter((s: any) => enabled.has(s.config?.id))
      .map((s: any) => ({ id: s.config.id, name: s.config.name, config: s.config, sorts: s.capabilitiesSearch?.sorts ?? [], filters: s.capabilitiesSearch?.filters ?? [] }));
  });
  const includedSources = () => (caps() ?? []).filter((c) => !excluded().includes(c.id));
  // Union across the sources being searched (each source ignores filters it doesn't know).
  const allSorts = createMemo(() => [...new Set(includedSources().flatMap((c) => c.sorts))]);
  const allFilters = createMemo(() => {
    const byId = new Map<string, FilterGroup>();
    for (const c of includedSources()) for (const g of c.filters) if (!byId.has(g.id)) byId.set(g.id, g);
    return [...byId.values()];
  });
  const activeCount = () => (order() ? 1 : 0) + Object.values(filters()).reduce((n, v) => n + v.length, 0) + (excluded().length ? 1 : 0);

  const pager = createPager(
    () => search.loadLazy(query(), type(), type() === ContentType.MEDIA ? filters() : undefined, excluded(), type() === ContentType.MEDIA ? order() ?? undefined : undefined),
    () => search.next(),
    { eagerSecondPage: true, current: () => search.current() },
  );

  const run = async (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    input?.blur();
    setFocused(false);
    setText(q);
    if (isProbablyUrl(q)) {
      try { await openAnyUrl(q, navigate); } catch (e) { toastError(e); }
      return;
    }
    search.addPrevious(q).then(() => refetchPrevious()).catch(() => { });
    setQuery(q);
    setParams({ q, type: type() === ContentType.MEDIA ? undefined : String(type()) });
    pager.reload();
  };
  const rerun = () => { if (query()) pager.reload(); };

  onMount(() => {
    if (query()) pager.reload();
    else input?.focus();
  });

  const pickType = (t: number) => {
    setType(t);
    if (query()) { setParams({ type: t === ContentType.MEDIA ? undefined : String(t) }); rerun(); }
  };

  const toggleFilter = (g: FilterGroup, value: string) => {
    setFilters((f) => {
      const cur = f[g.id] ?? [];
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : g.isMultiSelect ? [...cur, value] : [value];
      const out = { ...f, [g.id]: next };
      if (!next.length) delete out[g.id];
      return out;
    });
  };
  const toggleSource = (id: string) => setExcluded((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const resetFilters = () => { setOrder(null); setFilters({}); setExcluded([]); };
  const filterName = (gid: string, key: string) => allFilters().find((g) => g.id === gid)?.filters.find((f) => filterKey(f) === key)?.name ?? key;

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
        <Show when={focused() || !query()} fallback={
          <>
            <div class="chips search-chips">
              <For each={types}>{(t) => <button class="chip" aria-pressed={type() === t.id} onClick={() => pickType(t.id)}>{t.label}</button>}</For>
              <span class="chip-divider" />
              <button class="chip" aria-pressed={activeCount() > 0} onClick={() => setFiltersOpen(true)}>
                <Icon name="settings" size={14} /> Filters{activeCount() ? ` · ${activeCount()}` : ""}
              </button>
              <Show when={order() && type() === ContentType.MEDIA}>
                <button class="chip removable" onClick={() => { setOrder(null); rerun(); }}>{sortLabel(order()!)} <Icon name="close" size={12} /></button>
              </Show>
              <Show when={type() === ContentType.MEDIA}>
                <For each={Object.entries(filters()).flatMap(([gid, vals]) => vals.map((v) => [gid, v] as const))}>
                  {([gid, v]) => (
                    <button class="chip removable" onClick={() => { toggleFilter(allFilters().find((g) => g.id === gid)!, v); rerun(); }}>
                      {filterName(gid, v)} <Icon name="close" size={12} />
                    </button>
                  )}
                </For>
              </Show>
            </div>
            <Feed pager={pager} empty={<div class="empty"><Icon name="search" /><h3>No results</h3><p>Try different words or filters, or enable more sources.</p></div>} />
          </>
        }>
          <div class="list search-suggest">
            <Show when={"clipboard" in navigator && "readText" in (navigator.clipboard ?? {}) && !text()}>
              <button class="list-item" onMouseDown={(e) => e.preventDefault()} onClick={pasteFromClipboard}>
                <Icon name="link" /><div class="grow"><div class="title">Paste a link</div><div class="sub">Open a video or channel URL from any source</div></div>
              </button>
            </Show>
            <For each={text().trim() ? suggestions.latest ?? [] : previous.latest ?? []}>
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

      <Sheet open={filtersOpen()} onClose={() => setFiltersOpen(false)} title="Search filters" size="tall">
        <div class="stack search-filters">
          <Show when={type() === ContentType.MEDIA} fallback={<p class="muted">Sorting and filters apply to video searches.</p>}>
            <Show when={allSorts().length > 0}>
              <div>
                <div class="filter-title">Sort by</div>
                <div class="chip-wrap">
                  <button class="chip" aria-pressed={!order()} onClick={() => setOrder(null)}>Relevance</button>
                  <For each={allSorts()}>{(s) => <button class="chip" aria-pressed={order() === s} onClick={() => setOrder(order() === s ? null : s)}>{sortLabel(s)}</button>}</For>
                </div>
              </div>
            </Show>
            <For each={allFilters()}>
              {(g) => (
                <div>
                  <div class="filter-title">{g.name}{g.isMultiSelect ? <span class="faint"> · any of</span> : null}</div>
                  <div class="chip-wrap">
                    <Show when={!g.isMultiSelect}>
                      <button class="chip" aria-pressed={!(filters()[g.id]?.length)} onClick={() => setFilters((f) => { const o = { ...f }; delete o[g.id]; return o; })}>Any</button>
                    </Show>
                    <For each={g.filters}>{(f) => <button class="chip" aria-pressed={(filters()[g.id] ?? []).includes(filterKey(f))} onClick={() => toggleFilter(g, filterKey(f))}>{f.name}</button>}</For>
                  </div>
                </div>
              )}
            </For>
          </Show>
          <Show when={(caps()?.length ?? 0) > 1}>
            <div>
              <div class="filter-title">Search in</div>
              <div class="chip-wrap">
                <For each={caps()}>
                  {(c) => (
                    <button class="chip source-chip" aria-pressed={!excluded().includes(c.id)} onClick={() => toggleSource(c.id)}>
                      <Show when={iconOf(c.config)}><img src={iconOf(c.config)} alt="" referrerpolicy="no-referrer" /></Show>{c.name}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <div class="row" style={{ "justify-content": "space-between", "margin-top": "8px" }}>
            <button class="btn ghost" onClick={resetFilters}>Reset</button>
            <button class="btn accent" disabled={includedSources().length === 0} onClick={() => { setFiltersOpen(false); rerun(); }}>Show results</button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
