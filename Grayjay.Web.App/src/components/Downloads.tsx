// [GrayjayWeb] Library → Downloads: videos saved on this device (they play offline), downloads in progress, and videos
// already downloaded on the server (e.g. from another phone) that can be copied here.
import { For, Show, createEffect, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import ContentCard from "./ContentCard";
import Icon from "./Icon";
import { toast, toastError } from "./Toasts";
import { OfflineItem, ServerDownload, downloadsApi, formatBytes, offline, offlineMode } from "../lib/offline";
import "./Downloads.css";

function DownloadedRow(props: { item: OfflineItem }) {
  const [thumb, setThumb] = createSignal<string | undefined>();
  onMount(() => offline.thumbUrl(props.item.url).then((u) => { if (u) setThumb(u); }));
  onCleanup(() => { const u = thumb(); if (u) URL.revokeObjectURL(u); });
  const progress = () => (props.item.position && props.item.duration ? props.item.position / props.item.duration : 0);
  const remove = () => offline.remove(props.item.url).then(() => toast("Download removed", "info", 1800)).catch(toastError);
  return (
    <div class="later-row">
      <ContentCard item={offline.toContent(props.item, thumb())} layout="row" progress={progress()} noQueue={offlineMode()} />
      <button class="icon-btn" aria-label={`Remove download of ${props.item.name}`} title="Remove download" onClick={remove}><Icon name="trash" size={18} /></button>
    </div>
  );
}

export default function Downloads() {
  const [server, { refetch }] = createResource(() => (offlineMode() ? Promise.resolve([] as ServerDownload[]) : downloadsApi.list().catch(() => [] as ServerDownload[])));
  // Downloaded on the server but not here (another device downloaded it, or this one was cleared).
  const onServerOnly = () => (server() ?? []).filter((s) => s.state === "ready" && !offline.has(s.url) && !offline.job(s.url));
  const [usage, setUsage] = createSignal<{ used: number; quota?: number }>({ used: 0 });
  const updateUsage = () => offline.usage().then(setUsage);
  createEffect(on(offline.items, () => { updateUsage(); if (!offlineMode()) refetch(); }, { defer: true }));
  onMount(updateUsage);

  const copy = (s: ServerDownload) => {
    offline.copyFromServer(s)
      .then((it) => { toast(`Saved "${it?.name ?? s.name}" on this device`, "info", 2500); refetch(); })
      .catch((e) => toastError(new Error(`Couldn't save it here: ${e?.message ?? e}`)));
  };
  const retry = (url: string, name: string) => {
    offline.dismiss(url);
    offline.download({ url, name }, 720).catch(toastError);
  };

  return (
    <section class="downloads">
      <h2 class="section-title" style={{ "margin-top": "4px" }}>
        Downloads <span class="faint" style={{ "font-weight": 500, "font-size": "14px" }}>{offline.items().length || ""}</span>
      </h2>

      <Show when={offline.jobs().length > 0}>
        <div class="dl-jobs">
          <For each={offline.jobs()}>{(j) => (
            <div class="dl-job" classList={{ failed: !!j.error }}>
              <div class="grow">
                <div class="dl-name">{j.name || "Video"}</div>
                <div class="dl-detail">
                  {j.error ? j.error : `${j.detail ?? (j.phase === "server" ? "Downloading on your server" : "Saving to this device")} · ${Math.round(j.progress * 100)}%`}
                </div>
                <Show when={!j.error}>
                  <div class="dl-bar"><div style={{ width: `${Math.max(2, Math.min(100, j.progress * 100))}%` }} classList={{ device: j.phase === "device" }} /></div>
                </Show>
              </div>
              <Show when={j.error}>
                <button class="btn small" onClick={() => retry(j.url, j.name)}>Retry</button>
                <button class="icon-btn" aria-label="Dismiss" onClick={() => offline.dismiss(j.url)}><Icon name="close" size={18} /></button>
              </Show>
            </div>
          )}</For>
        </div>
      </Show>

      <Show when={offline.items().length > 0} fallback={
        <Show when={offline.loaded() && offline.jobs().length === 0}>
          <p class="muted" style={{ "font-size": "14px" }}>
            Nothing downloaded on this device. Use ⋮ → Download on a video, or Download on the watch page: it then plays with no connection.
          </p>
        </Show>
      }>
        <div class="feed-list">
          <For each={offline.items()}>{(it) => <DownloadedRow item={it} />}</For>
        </div>
        <p class="faint dl-usage">
          {formatBytes(usage().used)} on this device{usage().quota ? ` · ${formatBytes(Math.max(0, usage().quota! - usage().used))} free for the app` : ""}
        </p>
      </Show>

      <Show when={onServerOnly().length > 0}>
        <h3 class="dl-sub">On your server</h3>
        <div class="dl-jobs">
          <For each={onServerOnly()}>{(s) => (
            <div class="dl-job">
              <div class="grow">
                <div class="dl-name">{s.name}</div>
                <div class="dl-detail">{[s.author, s.audioOnly ? "Audio only" : s.height ? `${s.height}p` : "", s.size ? formatBytes(s.size) : ""].filter(Boolean).join(" · ")}</div>
              </div>
              <button class="btn small" onClick={() => copy(s)}><Icon name="download" size={16} /> Save here</button>
              <button class="icon-btn" aria-label={`Delete ${s.name} from the server`} title="Delete from server"
                onClick={() => downloadsApi.remove(s.url).then(() => refetch()).catch(toastError)}><Icon name="trash" size={18} /></button>
            </div>
          )}</For>
        </div>
      </Show>
    </section>
  );
}
