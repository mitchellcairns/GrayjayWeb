import { For, JSX, Show, createResource, onCleanup } from "solid-js";
import { Content, SourceConfig, sources } from "../api";
import { on } from "../api/socket";
import { stored } from "../lib/stored";
import { iconOf } from "../pages/Sources";

/** [GrayjayWeb] Which source (platform) a feed shows: null = all of them. Remembered per page on this device. */
export function createSourceFilter(page: string) {
  const [enabled, { refetch }] = createResource(() => sources.enabled().catch(() => [] as SourceConfig[]));
  const [picked, setPicked] = stored<string | null>(`gj.sourceFilter.${page}`, null);
  onCleanup(on("EnabledClientsChanged", () => refetch()));
  // A source that's been disabled since counts as "all".
  const selected = () => {
    const id = picked();
    return id && (enabled() ?? []).some((c) => c.id === id) ? id : null;
  };
  const matches = (item: Content) => {
    const id = selected();
    if (!id) return true;
    if (item.id?.pluginID) return item.id.pluginID === id;
    const name = enabled()?.find((c) => c.id === id)?.name.toLowerCase();
    return !!name && item.id?.platform?.toLowerCase() === name;
  };
  return { enabled, selected, set: setPicked, matches };
}
export type SourceFilter = ReturnType<typeof createSourceFilter>;

/** A row of chips: All, then one per enabled source. Hidden with fewer than two sources. */
export default function SourceChips(props: {
  sources: SourceConfig[];
  selected: string | null;
  onPick: (id: string | null) => void;
  /** Highlight "All" (defaults to nothing selected). */
  allPressed?: boolean;
  /** Extra chips before the sources (e.g. "Live"); the row then shows even with one source. */
  leading?: JSX.Element;
  class?: string;
}) {
  return (
    <Show when={props.sources.length > 1 || props.leading}>
      <div class={`chips source-chips ${props.class ?? ""}`} role="toolbar" aria-label="Show sources">
        {props.leading}
        <Show when={props.sources.length > 1}>
          <button class="chip" aria-pressed={props.allPressed ?? props.selected === null} onClick={() => props.onPick(null)}>All sources</button>
        </Show>
        <For each={props.sources.length > 1 ? props.sources : []}>
          {(c) => (
            <button class="chip source-chip" aria-pressed={props.selected === c.id} onClick={() => props.onPick(props.selected === c.id ? null : c.id)}>
              <Show when={iconOf(c)}><img src={iconOf(c)} alt="" referrerpolicy="no-referrer" /></Show>{c.name}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
