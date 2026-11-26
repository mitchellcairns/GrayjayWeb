import { For, Show, createMemo, createSignal } from "solid-js";
import { Subscription, SubscriptionGroup, subscriptions } from "../api";
import { Avatar } from "./ContentCard";
import Icon from "./Icon";
import { toast, toastError } from "./Toasts";

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Create, rename, reorder and delete subscription groups (the chips above the Subscriptions feed), and pick their channels. */
export default function GroupManager(props: { groups: SubscriptionGroup[]; subscriptions: Subscription[]; onChanged: () => void }) {
  const [editing, setEditing] = createSignal<SubscriptionGroup | null>(null);
  const [busy, setBusy] = createSignal(false);

  const save = async (g: SubscriptionGroup) => {
    setBusy(true);
    try { await subscriptions.groupSave(g); props.onChanged(); }
    catch (e) { toastError(e); throw e; }
    finally { setBusy(false); }
  };

  const move = async (index: number, delta: number) => {
    const list = [...props.groups];
    const j = index + delta;
    if (j < 0 || j >= list.length) return;
    [list[index], list[j]] = [list[j], list[index]];
    setBusy(true);
    try {
      for (let i = 0; i < list.length; i++) if (list[i].priority !== i) await subscriptions.groupSave({ ...list[i], priority: i });
      props.onChanged();
    } catch (e) { toastError(e); }
    finally { setBusy(false); }
  };

  const remove = async (g: SubscriptionGroup) => {
    if (!confirm(`Delete the group "${g.name}"? Your subscriptions stay.`)) return;
    try { await subscriptions.groupDelete(g.id); toast("Group deleted"); props.onChanged(); } catch (e) { toastError(e); }
  };

  const startNew = () => setEditing({ id: newId(), name: "", urls: [], priority: props.groups.length });

  return (
    <Show when={editing()} fallback={
      <div class="stack">
        <p class="muted" style={{ "font-size": "14px" }}>Groups appear as tabs above your Subscriptions feed. A channel can be in several groups.</p>
        <Show when={props.groups.length > 0}>
          <div class="list">
            <For each={props.groups}>
              {(g, i) => (
                <div class="list-item">
                  <div class="group-order">
                    <button class="icon-btn" aria-label={`Move ${g.name} up`} disabled={busy() || i() === 0} onClick={() => move(i(), -1)}><Icon name="up" size={18} /></button>
                    <button class="icon-btn" aria-label={`Move ${g.name} down`} disabled={busy() || i() === props.groups.length - 1} onClick={() => move(i(), 1)}><Icon name="down" size={18} /></button>
                  </div>
                  <button class="grow group-open" onClick={() => setEditing({ ...g, urls: [...(g.urls ?? [])] })}>
                    <div class="title">{g.name}</div>
                    <div class="sub">{g.urls?.length ?? 0} channel{(g.urls?.length ?? 0) === 1 ? "" : "s"}</div>
                  </button>
                  <button class="icon-btn" aria-label={`Delete ${g.name}`} onClick={() => remove(g)}><Icon name="trash" size={18} /></button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <button class="btn accent block" onClick={startNew}><Icon name="plus" size={18} /> New group</button>
      </div>
    }>
      <GroupEditor
        group={editing()!}
        subscriptions={props.subscriptions}
        busy={busy()}
        isNew={!props.groups.some((g) => g.id === editing()!.id)}
        onCancel={() => setEditing(null)}
        onSave={async (g) => { await save(g); toast(`Saved "${g.name}"`); setEditing(null); }}
      />
    </Show>
  );
}

function GroupEditor(props: { group: SubscriptionGroup; subscriptions: Subscription[]; busy: boolean; isNew: boolean; onCancel: () => void; onSave: (g: SubscriptionGroup) => Promise<void> }) {
  const [name, setName] = createSignal(props.group.name);
  const [urls, setUrls] = createSignal(new Set(props.group.urls));
  const [filter, setFilter] = createSignal("");

  // Group membership is stored by channel URL; a channel matches if any of its known URLs is in the group.
  const urlsOf = (s: Subscription) => [s.channel.url, ...(s.channel.urlAlternatives ?? [])].filter(Boolean) as string[];
  const isIn = (s: Subscription) => urlsOf(s).some((u) => urls().has(u));
  const toggle = (s: Subscription) => setUrls((set) => {
    const next = new Set(set);
    if (isIn(s)) urlsOf(s).forEach((u) => next.delete(u)); else next.add(s.channel.url);
    return next;
  });
  const visible = createMemo(() => {
    const f = filter().trim().toLowerCase();
    return [...props.subscriptions]
      .filter((s) => !f || s.channel.name.toLowerCase().includes(f))
      .sort((a, b) => Number(isIn(b)) - Number(isIn(a)) || a.channel.name.localeCompare(b.channel.name));
  });
  const count = () => props.subscriptions.filter(isIn).length;

  return (
    <form class="stack" onSubmit={(e) => { e.preventDefault(); if (name().trim()) props.onSave({ ...props.group, name: name().trim(), urls: [...urls()] }); }}>
      <input class="field" placeholder="Group name (e.g. Science)" value={name()} onInput={(e) => setName(e.currentTarget.value)} required autofocus />
      <div class="row">
        <input class="field" type="search" placeholder="Filter channels" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        <span class="faint" style={{ "white-space": "nowrap", "font-size": "13px" }}>{count()} selected</span>
      </div>
      <div class="list group-channels">
        <For each={visible()}>
          {(s) => (
            <label class="list-item" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={isIn(s)} onChange={() => toggle(s)} style={{ width: "20px", height: "20px" }} />
              <Avatar src={s.channel.thumbnail} name={s.channel.name} size={32} />
              <div class="grow"><div class="title">{s.channel.name}</div><div class="sub">{s.channel.id?.platform}</div></div>
            </label>
          )}
        </For>
      </div>
      <div class="row" style={{ "justify-content": "space-between" }}>
        <button type="button" class="btn ghost" onClick={props.onCancel}>Cancel</button>
        <button class="btn accent" disabled={props.busy || !name().trim()}>{props.isNew ? "Create group" : "Save"}</button>
      </div>
    </form>
  );
}
