import { Show } from "solid-js";
import { useRegisterSW } from "virtual:pwa-register/solid";

/** Registers the service worker; when a new version is deployed, offers a one-tap reload. */
export default function UpdatePrompt() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Check for updates whenever the app comes back to the foreground.
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg?.update().catch(() => { }); });
    },
  });
  return (
    <Show when={needRefresh()}>
      <div class="update-banner" role="status">
        <span>Update available</span>
        <button class="btn small accent" onClick={() => updateServiceWorker(true)}>Reload</button>
        <button class="btn small ghost" onClick={() => setNeedRefresh(false)}>Later</button>
      </div>
    </Show>
  );
}
