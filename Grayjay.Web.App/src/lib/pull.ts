import { onCleanup, onMount } from "solid-js";

/**
 * Pull-to-refresh for touch devices (standalone PWAs lose the browser's own pull-to-refresh because we set
 * overscroll-behavior: none). Shows a small indicator under the top bar.
 */
export function usePullToRefresh(refresh: () => Promise<unknown> | void) {
  onMount(() => {
    const indicator = document.createElement("div");
    indicator.className = "ptr";
    indicator.innerHTML = '<div class="spinner"></div>';
    document.body.appendChild(indicator);

    let startY = 0, pulling = false, dist = 0, busy = false;
    const max = 90;
    const onStart = (e: TouchEvent) => {
      if (busy || scrollY > 0 || e.touches.length !== 1 || document.documentElement.style.overflow === "hidden") return;
      startY = e.touches[0].clientY; pulling = true; dist = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!pulling) return;
      dist = Math.max(0, e.touches[0].clientY - startY);
      if (dist <= 0) return;
      const d = Math.min(max, dist * 0.5);
      indicator.style.transform = `translate(-50%, ${d}px)`;
      indicator.style.opacity = String(Math.min(1, d / 50));
    };
    const onEnd = async () => {
      if (!pulling) return;
      pulling = false;
      if (dist * 0.5 >= 60) {
        busy = true;
        indicator.classList.add("busy");
        try { navigator.vibrate?.(8); } catch { }
        try { await refresh(); } finally { busy = false; indicator.classList.remove("busy"); }
      }
      indicator.style.transform = ""; indicator.style.opacity = "";
    };
    addEventListener("touchstart", onStart, { passive: true });
    addEventListener("touchmove", onMove, { passive: true });
    addEventListener("touchend", onEnd);
    onCleanup(() => {
      removeEventListener("touchstart", onStart);
      removeEventListener("touchmove", onMove);
      removeEventListener("touchend", onEnd);
      indicator.remove();
    });
  });
}
