import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { dialogs } from "../api";
import { on } from "../api/socket";
import Sheet from "../components/Sheet";
import { toast } from "../components/Toasts";

interface RemoteDialog { icon?: string; text: string; textDetails?: string; code?: string; defaultCloseAction?: number; actions?: { text: string; style?: number }[] }

/** Dialogs and toasts pushed by the server (plugin install prompts, warnings, update notices…). */
export default function ServerDialogs() {
  const [queue, setQueue] = createSignal<{ id: string; dialog: RemoteDialog }[]>([]);
  const current = () => queue()[0];
  // Keeps showing the last dialog while the sheet slides closed.
  const shown = createMemo<ReturnType<typeof current> | undefined>((prev) => current() ?? prev);

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
    <Sheet open={!!current()} onClose={() => respond(current()?.dialog.defaultCloseAction ?? -1)} title={shown()?.dialog.text}>
      <Show when={shown()}>
        <div class="stack">
          <Show when={shown()!.dialog.textDetails}><p class="muted" style={{ "white-space": "pre-wrap" }}>{shown()!.dialog.textDetails}</p></Show>
          <Show when={shown()!.dialog.code}>
            <pre style={{ "white-space": "pre-wrap", "font-size": "12px", background: "var(--bg-elev-2)", padding: "12px", "border-radius": "var(--radius)", "max-height": "40vh", overflow: "auto" }}>{shown()!.dialog.code}</pre>
          </Show>
          <div class="row" style={{ "justify-content": "flex-end", "flex-wrap": "wrap" }}>
            <For each={shown()!.dialog.actions ?? []}>
              {(a, i) => <button class={`btn ${i() === (shown()!.dialog.actions!.length - 1) ? "accent" : ""}`} onClick={() => respond(i())}>{a.text}</button>}
            </For>
          </div>
        </div>
      </Show>
    </Sheet>
  );
}
