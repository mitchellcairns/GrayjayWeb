import { For, Match, Show, Switch, createMemo, createSignal, onCleanup } from "solid-js";
import { customDialogs } from "../api";
import { on } from "../api/socket";
import Sheet from "../components/Sheet";
import { Avatar } from "../components/ContentCard";
import Icon from "../components/Icon";

interface RemoteCustomDialog { id: string; name: string; data: any }

/**
 * Renders the server's "custom dialogs": backup import ("import"), subscription import ("importSubs") and Grayjay Sync
 * pairing ("syncConfirm" / "syncStatus"). They're driven by WebSocket events and answered via /dialog/DialogRespondCustom.
 */
export default function CustomDialogs() {
  const [dialogs, setDialogs] = createSignal<RemoteCustomDialog[]>([]);
  const known = new Set(["import", "importSubs", "syncConfirm", "syncStatus"]);

  const offs = [
    on<any>("CustomDialog", (p) => {
      const d = p.payload;
      const id = d?.id ?? d?.ID ?? p.id;
      const name = d?.name ?? d?.Name;
      if (!id || !known.has(name)) return;
      setDialogs((list) => [...list.filter((x) => x.id !== id), { id, name, data: d?.data ?? d?.Data ?? {} }]);
    }),
    on<any>("CustomDialogUpdate", (p) => setDialogs((list) => list.map((x) => (x.id === p.id ? { ...x, data: p.payload ?? {} } : x)))),
    on<any>("CustomDialogClose", (p) => setDialogs((list) => list.filter((x) => x.id !== p.id))),
  ];
  onCleanup(() => offs.forEach((o) => o()));

  const current = () => dialogs()[0];
  const dismiss = (id: string) => setDialogs((list) => list.filter((x) => x.id !== id));
  const act = (action: string, data: unknown = null) => { const c = current(); if (c) customDialogs.action(c.id, action, data).catch(() => { }); };

  return (
    <Show when={current()} keyed>
      {(d) => (
        <Switch>
          <Match when={d.name === "import"}><ImportDialog dialog={d} act={act} dismiss={() => dismiss(d.id)} /></Match>
          <Match when={d.name === "importSubs"}><ImportSubsDialog dialog={d} act={act} dismiss={() => dismiss(d.id)} /></Match>
          <Match when={d.name === "syncConfirm"}>
            <Sheet open onClose={() => { act("cancel"); dismiss(d.id); }} title="Link a device?">
              <div class="stack">
                <p class="muted">A Grayjay device wants to sync with this server. It will share subscriptions, playlists, watch later and history.</p>
                <p class="faint" style={{ "font-size": "12px", "word-break": "break-all" }}>Device key: {d.data.PublicKey}</p>
                <div class="row" style={{ "justify-content": "flex-end" }}>
                  <button class="btn" onClick={() => { act("cancel"); dismiss(d.id); }}>Decline</button>
                  <button class="btn accent" onClick={() => { act("confirm"); dismiss(d.id); }}>Link device</button>
                </div>
              </div>
            </Sheet>
          </Match>
          <Match when={d.name === "syncStatus"}>
            <Sheet open onClose={() => { act("close"); dismiss(d.id); }} title="Grayjay Sync">
              <div class="stack">
                <Show when={d.data.Status === "pairing"}><div class="row"><div class="spinner" /> <span>Pairing…</span></div></Show>
                <Show when={d.data.Message}><p class="muted">{d.data.Message}</p></Show>
                <button class="btn block" onClick={() => { act("close"); dismiss(d.id); }}>Close</button>
              </div>
            </Sheet>
          </Match>
        </Switch>
      )}
    </Show>
  );
}

interface Option { ID: string; Name: string; Count: number; Importing?: boolean; Imported?: boolean; Progress?: number; Warnings?: string[]; Exceptions?: string[] }

function ImportDialog(props: { dialog: RemoteCustomDialog; act: (a: string, d?: unknown) => void; dismiss: () => void }) {
  const data = () => props.dialog.data;
  // "Settings" import is a no-op upstream, so it isn't offered.
  const options = createMemo<Option[]>(() => {
    const d = data();
    const list: Option[] = [];
    if (d.Plugins?.Count > 0) list.push({ ...d.Plugins, Name: "Sources (plugins)" });
    if (d.PluginSettings?.Count > 0) list.push({ ...d.PluginSettings, Name: "Source settings" });
    for (const s of d.Stores ?? []) if (s.Count > 0) list.push(s);
    return list;
  });
  const [picked, setPicked] = createSignal<Set<string>>(new Set());
  const isPicked = (id: string) => picked().size === 0 ? true : picked().has(id);
  const toggle = (id: string) => {
    const base = picked().size === 0 ? new Set(options().map((o) => o.ID)) : new Set(picked());
    base.has(id) ? base.delete(id) : base.add(id);
    setPicked(base);
  };
  const chosen = () => options().filter((o) => isPicked(o.ID)).map((o) => o.ID);
  const status = () => data().Status as string;
  const importing = () => (data().Importing ?? []) as Option[];
  const prettyName = (o: Option) => ({ plugins: "Sources (plugins)", pluginSettings: "Source settings", subscriptions: "Subscriptions", subscription_groups: "Subscription groups", playlists: "Playlists", history: "Watch history", watch_later: "Watch later" } as Record<string, string>)[o.ID] ?? o.Name;

  const close = () => { props.act("close"); props.dismiss(); };

  return (
    <Sheet open onClose={() => { if (status() === "choice") props.act("choice", "cancel"); if (status() !== "importing") close(); }} title="Import Grayjay backup" dismissible={status() !== "importing"}>
      <Switch>
        <Match when={status() === "choice"}>
          <div class="stack">
            <p class="muted">Choose what to bring over from your backup.</p>
            <div class="list">
              <For each={options()}>
                {(o) => (
                  <label class="list-item" style={{ cursor: "pointer" }}>
                    <input type="checkbox" checked={isPicked(o.ID)} onChange={() => toggle(o.ID)} style={{ width: "20px", height: "20px" }} />
                    <div class="grow"><div class="title">{prettyName(o)}</div><div class="sub">{o.Count} item{o.Count === 1 ? "" : "s"}</div></div>
                  </label>
                )}
              </For>
            </div>
            <div class="row" style={{ "justify-content": "flex-end" }}>
              <button class="btn" onClick={() => { props.act("choice", "cancel"); props.dismiss(); }}>Cancel</button>
              <button class="btn accent" disabled={chosen().length === 0} onClick={() => props.act("choice", "import;" + chosen().join(","))}>Import</button>
            </div>
          </div>
        </Match>
        <Match when={status() === "enablePlugins"}>
          <div class="stack">
            <p>Turn on the sources from your backup as well?</p>
            <p class="muted" style={{ "font-size": "14px" }}>Subscriptions and playlists need their source enabled to load.</p>
            <div class="row" style={{ "justify-content": "flex-end" }}>
              <button class="btn" onClick={() => props.act("import", "false")}>Keep current</button>
              <button class="btn accent" onClick={() => props.act("import", "true")}>Enable sources</button>
            </div>
          </div>
        </Match>
        <Match when={status() === "importing" || status() === "finished"}>
          <div class="stack">
            <div class="list">
              <For each={importing()}>
                {(o) => (
                  <div class="list-item">
                    <Show when={o.Imported} fallback={o.Importing ? <div class="spinner" style={{ width: "20px", height: "20px", "border-width": "2px" }} /> : <Icon name="history" size={20} />}>
                      <Icon name={(o.Exceptions?.length ?? 0) > 0 ? "alert" : "check"} size={20} />
                    </Show>
                    <div class="grow">
                      <div class="title">{prettyName(o)}</div>
                      <div class="sub">{o.Imported ? `${o.Count} done${(o.Exceptions?.length ?? 0) > 0 ? ` · ${o.Exceptions!.length} problem${o.Exceptions!.length === 1 ? "" : "s"}` : ""}` : o.Importing ? `${o.Progress ?? 0} of ${o.Count}` : "Waiting"}</div>
                    </div>
                  </div>
                )}
              </For>
            </div>
            <Show when={status() === "importing"}><p class="faint" style={{ "font-size": "13px" }}>{data().ImportStatus ?? "Importing…"} Keep this open; large libraries can take a few minutes.</p></Show>
            <Show when={status() === "finished"}>
              <Show when={importing().some((o) => (o.Exceptions?.length ?? 0) > 0)}>
                <details class="card" style={{ "font-size": "13px" }}>
                  <summary>Some items couldn't be imported</summary>
                  <For each={importing().flatMap((o) => o.Exceptions ?? [])}>{(e) => <div class="muted">{e}</div>}</For>
                </details>
              </Show>
              <button class="btn accent block" onClick={close}>Done</button>
            </Show>
          </div>
        </Match>
      </Switch>
    </Sheet>
  );
}

function ImportSubsDialog(props: { dialog: RemoteCustomDialog; act: (a: string, d?: unknown) => void; dismiss: () => void }) {
  const data = () => props.dialog.data;
  const channels = () => (data().Channels ?? []) as any[];
  const selected = () => new Set<string>(data().Selected ?? []);
  const loading = () => (data().Loaded ?? 0) + (data().Failed ?? 0) < (data().Total ?? 0);
  const close = () => { props.act("close"); props.dismiss(); };
  return (
    <Sheet open onClose={close} title="Import subscriptions" size="tall">
      <Show when={data().Status !== "finished"} fallback={
        <div class="stack">
          <div class="empty"><Icon name="check" /><h3>Subscriptions imported</h3><p>New videos from these channels now show up in Subscriptions.</p></div>
          <button class="btn accent block" onClick={close}>Done</button>
        </div>
      }>
        <div class="stack">
          <p class="muted" style={{ "font-size": "14px" }}>
            {data().Total ?? 0} channels found{(data().Failed ?? 0) > 0 ? `, ${data().Failed} couldn't be loaded` : ""}.
            {loading() ? ` Loading channel details (${data().Loaded ?? 0}/${data().Total ?? 0})…` : ""}
          </p>
          <div class="row">
            <button class="btn small" onClick={() => props.act("selectAll")}>Select all</button>
            <button class="btn small" onClick={() => props.act("deselectAll")}>Select none</button>
            <div class="spacer" />
            <span class="faint" style={{ "font-size": "13px" }}>{selected().size} selected</span>
          </div>
          <div class="list">
            <For each={channels()}>
              {(c) => (
                <label class="list-item" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={selected().has(c.url ?? c.Url)} onChange={() => props.act("selectSubscription", c.url ?? c.Url)} style={{ width: "20px", height: "20px" }} />
                  <Avatar src={c.thumbnail ?? c.Thumbnail} name={c.name ?? c.Name} size={36} />
                  <div class="grow"><div class="title">{c.name ?? c.Name}</div><div class="sub">{c.id?.platform ?? c.ID?.Platform ?? ""}</div></div>
                </label>
              )}
            </For>
          </div>
          <button class="btn accent block" disabled={selected().size === 0} onClick={() => props.act("import")}>
            Subscribe to {selected().size} channel{selected().size === 1 ? "" : "s"}
          </button>
        </div>
      </Show>
    </Sheet>
  );
}
