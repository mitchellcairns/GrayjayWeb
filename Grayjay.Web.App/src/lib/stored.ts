import { createSignal } from "solid-js";

/** A signal persisted to localStorage (per device/browser). */
export function stored<T>(key: string, fallback: T) {
  let initial = fallback;
  try { const v = localStorage.getItem(key); if (v != null) initial = JSON.parse(v); } catch { }
  const [get, set] = createSignal<T>(initial);
  return [get, (v: T) => { set(() => v); try { localStorage.setItem(key, JSON.stringify(v)); } catch { } }] as const;
}
