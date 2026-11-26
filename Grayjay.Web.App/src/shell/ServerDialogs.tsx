import { For, Show, createSignal, onCleanup } from "solid-js";
import { dialogs } from "../api";
import { on } from "../api/socket";
import Sheet from "../components/Sheet";
import { toast } from "../components/Toasts";

interface RemoteDialog { icon?: string; text: string; textDetails?: string; code?: string; defaultCloseAction?: number; actions?: { text: string; style?: number }[] }

/** Dialogs and toasts pushed by the server (plugin install prompts, warnings, update notices…). */
export default function ServerDialogs() {
  const [queue, setQueue] = createSignal<{ id: string; dialog: RemoteDialog }[]>([]);
  const current = () => queue()[0];

  const offs = [
    on<RemoteDialog>("Dialog", (p) => { if (p.id && p.payload) setQueue((q) => [...q, { id: p.id!, dialog: p.payload }]); }),
    on<any>("Toast", (p) => {
      const t = p.payload;
      const text = typeof t === "string" ? t : [t?.title, t?.text].filter(Boolean).join(": ");
      if (text) toast(text);
    }),
    on<string>("OpenUrl", (p) => { if (typeof p.payload === "string" && /^https?:/i.test(p.payload)) window.open(p.payload, "_blank", "noopener"); }),
  ];
  onCleanup(() => offs.forEach((o) => o()));

  const respond = (button: number) => {
    const c = current(); if (!c) return;
    setQueue((q) => q.slice(1));
    if (button >= 0) dialogs.respond(c.id, { button, index: -1 }).catch(() => { });
  };

  return (
    <Sheet open={!!current()} onClose={() => respond(current()?.dialog.defaultCloseAction ?? -1)} title={current()?.dialog.text}>
      <Show when={current()}>
        <div class="stack">
          <Show when={current()!.dialog.textDetails}><p class="muted" style={{ "white-space": "pre-wrap" }}>{current()!.dialog.textDetails}</p></Show>
          <Show when={current()!.dialog.code}>
            <pre style={{ "white-space": "pre-wrap", "font-size": "12px", background: "var(--bg-elev-2)", padding: "12px", "border-radius": "var(--radius)", "max-height": "40vh", overflow: "auto" }}>{current()!.dialog.code}</pre>
          </Show>
          <div class="row" style={{ "justify-content": "flex-end", "flex-wrap": "wrap" }}>
            <For each={current()!.dialog.actions ?? []}>
              {(a, i) => <button class={`btn ${i() === (current()!.dialog.actions!.length - 1) ? "accent" : ""}`} onClick={() => respond(i())}>{a.text}</button>}
            </For>
          </div>
        </div>
      </Show>
    </Sheet>
  );
}
