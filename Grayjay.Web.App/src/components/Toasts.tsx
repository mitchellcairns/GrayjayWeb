import { For, createSignal } from "solid-js";
import { Portal } from "solid-js/web";

interface Toast { id: number; text: string; kind: "info" | "error" }
const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

export function toast(text: string, kind: "info" | "error" = "info", ms = 3500) {
  const id = nextId++;
  setToasts((t) => [...t.slice(-2), { id, text, kind }]);
  setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
}

export function toastError(e: unknown) {
  toast((e as any)?.message ?? String(e), "error", 5000);
}

export default function Toasts() {
  return (
    <Portal>
      <div class="toasts" role="status" aria-live="polite">
        <For each={toasts()}>{(t) => <div class={`toast ${t.kind}`}>{t.text}</div>}</For>
      </div>
    </Portal>
  );
}
