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
  // [GrayjayWeb] Another window (or tab) may have installed the update already. Then nothing is waiting, the
  // skip-waiting message goes nowhere and the page never reloads, so reload it directly. Also reload if the switch
  // hasn't happened after a few seconds.
  const reload = async () => {
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
    if (!reg?.waiting) { location.reload(); return; }
    updateServiceWorker(true);
    setTimeout(() => location.reload(), 4000);
  };
  return (
    <Show when={needRefresh()}>
      <div class="update-banner" role="status">
        <span>Update available</span>
        <button class="btn small accent" onClick={reload}>Reload</button>
        <button class="btn small ghost" onClick={() => setNeedRefresh(false)}>Later</button>
      </div>
    </Show>
  );
}
