import { For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";

interface ToastAction { label: string; run: () => void }
interface Toast { id: number; text: string; kind: "info" | "error"; action?: ToastAction }
const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

// Leaving toasts fade out first instead of vanishing (same objects, so <For> doesn't rebuild and replay the entrance).
const [leaving, setLeaving] = createSignal<ReadonlySet<number>>(new Set());
const dismiss = (id: number) => {
  if (leaving().has(id) || !toasts().some((x) => x.id === id)) return;
  setLeaving((s) => new Set(s).add(id));
  setTimeout(() => {
    setToasts((t) => t.filter((x) => x.id !== id));
    setLeaving((s) => { const n = new Set(s); n.delete(id); return n; });
  }, 180);
};

export function toast(text: string, kind: "info" | "error" = "info", ms = 3500, action?: ToastAction) {
  const id = nextId++;
  setToasts((t) => [...t.slice(-2), { id, text, kind, action }]);
  setTimeout(() => dismiss(id), action ? Math.max(ms, 6000) : ms);
}

/** A toast with a button, e.g. "Creator hidden · Undo". */
export function toastAction(text: string, label: string, run: () => void) {
  toast(text, "info", 6000, { label, run });
}

export function toastError(e: unknown) {
  toast((e as any)?.message ?? String(e), "error", 5000);
}

export default function Toasts() {
  return (
    <Portal>
      <div class="toasts" role="status" aria-live="polite">
        <For each={toasts()}>{(t) => (
          <div class={`toast ${t.kind}`} classList={{ "has-action": !!t.action, leaving: leaving().has(t.id) }}>
            <span>{t.text}</span>
            <Show when={t.action}>
              <button class="toast-action" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action!.label}</button>
            </Show>
          </div>
        )}</For>
      </div>
    </Portal>
  );
}
