import { For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import { sources } from "../api";
import { toastError } from "./Toasts";

interface Field {
  type: string; // toggle | dropdown | group_flat | (others shown read-only)
  title: string;
  description?: string;
  property: string;
  value?: any;
  options?: string[];
  dependency?: string | null;
  warningDialog?: string | null;
  fields?: Field[];
  visible?: boolean;
}

/**
 * Generic form for a source's (plugin's) own settings, e.g. YouTube's SponsorBlock, Return YouTube Dislike and DeArrow.
 * Values are stored as strings server-side ("True"/"False" for toggles, the option index for dropdowns); every change
 * saves immediately, and fields whose dependency toggle is off are hidden like in the Grayjay apps.
 */
export default function SourceSettingsForm(props: { id: string }) {
  const [settings] = createResource(() => props.id, (id) => sources.settings(id));
  const [values, setValues] = createSignal<Record<string, string> | null>(null);
  const current = () => values() ?? (settings()?.object as Record<string, string> | undefined) ?? {};

  const isOn = (prop?: string | null) => !prop || String(current()[prop]).toLowerCase() === "true";
  let saveTimer: number | undefined;
  const set = (prop: string, value: string) => {
    const next = { ...current(), [prop]: value };
    setValues(next);
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => sources.settingsSave(props.id, next).catch(toastError), 400);
  };
  const toggle = (f: Field) => {
    const turningOn = !isOn(f.property);
    if (turningOn && f.warningDialog && !confirm(f.warningDialog)) return;
    set(f.property, turningOn ? "True" : "False");
  };

  const FieldView = (p: { f: Field }) => (
    <Show when={p.f.visible !== false && isOn(p.f.dependency)}>
      <Switch fallback={
        <div class="list-item"><div class="grow"><div class="title">{p.f.title}</div><div class="sub">{String(current()[p.f.property] ?? "")}</div></div></div>
      }>
        <Match when={p.f.type === "group_flat"}>
          <div class="settings-group">
            <div class="settings-group-title">{p.f.title}</div>
            <div class="list"><For each={p.f.fields ?? []}>{(child) => <FieldView f={child} />}</For></div>
          </div>
        </Match>
        <Match when={p.f.type === "toggle"}>
          <label class="list-item" style={{ cursor: "pointer" }}>
            <div class="grow">
              <div class="title">{p.f.title}</div>
              <Show when={p.f.description}><div class="sub wrap">{p.f.description}</div></Show>
            </div>
            <span class="switch"><input type="checkbox" checked={isOn(p.f.property)} onChange={(e) => { e.preventDefault(); toggle(p.f); e.currentTarget.checked = isOn(p.f.property); }} /><span /></span>
          </label>
        </Match>
        <Match when={p.f.type === "dropdown"}>
          <label class="list-item">
            <div class="grow">
              <div class="title">{p.f.title}</div>
              <Show when={p.f.description}><div class="sub wrap">{p.f.description}</div></Show>
            </div>
            <select class="settings-select" value={String(current()[p.f.property] ?? p.f.value ?? 0)} onChange={(e) => set(p.f.property, e.currentTarget.value)}>
              <For each={p.f.options ?? []}>{(o, i) => <option value={String(i())}>{o}</option>}</For>
            </select>
          </label>
        </Match>
      </Switch>
    </Show>
  );

  // Top-level loose fields first, then each group as its own section.
  const loose = () => (settings()?.fields ?? []).filter((f: Field) => f.type !== "group_flat");
  const groups = () => (settings()?.fields ?? []).filter((f: Field) => f.type === "group_flat");

  return (
    <Show when={settings()} fallback={<Show when={settings.loading}><div class="feed-status"><div class="spinner" /></div></Show>}>
      <div class="stack source-settings">
        <For each={groups().filter((g: Field) => !/advanced/i.test(g.property))}>{(g) => <FieldView f={g} />}</For>
        <Show when={loose().length}>
          <div class="settings-group">
            <div class="settings-group-title">General</div>
            <div class="list"><For each={loose()}>{(f) => <FieldView f={f} />}</For></div>
          </div>
        </Show>
        <For each={groups().filter((g: Field) => /advanced/i.test(g.property))}>{(g) => <FieldView f={g} />}</For>
      </div>
    </Show>
  );
}
