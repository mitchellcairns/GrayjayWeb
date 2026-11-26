import { For, Show, createResource, createSignal } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { auth } from "../api";
import { get, post } from "../api/client";
import { formatAgo } from "../lib/format";
import Icon from "../components/Icon";
import Sheet from "../components/Sheet";
import PairDevice from "../components/PairDevice";
import { toast, toastError } from "../components/Toasts";
import PageHeader from "../shell/PageHeader";

const FUTO_PAYMENT_PORTAL = "https://pay.futo.org/api/PaymentPortal?product=grayjay";

export default function Settings() {
  const [devices, { refetch }] = createResource(() => auth.devices().catch(() => []));
  const [purchased, { refetch: refetchPurchased }] = createResource(() => get<boolean>("/Buy/DidPurchase").catch(() => false));
  const [price] = createResource(() => get<string>("/Buy/GetPrice").catch(() => ""));
  const [params] = useSearchParams();
  // The tray app's "Pair a phone" opens /app/settings?pair=1.
  const [pairOpen, setPairOpen] = createSignal(params.pair === "1");
  const [licenseOpen, setLicenseOpen] = createSignal(false);
  const [license, setLicense] = createSignal("");

  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone;

  const removeDevice = async (id: string, current: boolean) => {
    if (current && !confirm("Sign this device out of your Grayjay server?")) return;
    try {
      await auth.removeDevice(id);
      if (current) location.reload(); else { toast("Device removed"); refetch(); }
    } catch (e) { toastError(e); }
  };

  const activate = async () => {
    try {
      const ok = await post<boolean>("/Buy/SetLicense", license().trim());
      if (ok) { toast("Thank you for supporting Grayjay!"); setLicenseOpen(false); refetchPurchased(); }
      else toast("That license key wasn't accepted", "error");
    } catch (e) { toastError(e); }
  };

  return (
    <>
      <PageHeader title="Settings" back />
      <main class="page" style={{ "max-width": "760px" }}>
        <h2 class="section-title" style={{ "margin-top": "4px" }}>Devices</h2>
        <div class="list">
          <button class="list-item" onClick={() => setPairOpen(true)}>
            <Icon name="qr" />
            <div class="grow"><div class="title">Pair a phone or tablet</div><div class="sub">Show a QR code to sign in another device</div></div>
            <Icon name="forward" size={18} />
          </button>
          <For each={devices()}>
            {(d) => (
              <div class="list-item">
                <Icon name={/iPhone|Android|iPad/.test(d.name) ? "phone" : "globe"} />
                <div class="grow">
                  <div class="title">{d.name}{d.current ? " (this device)" : ""}</div>
                  <div class="sub">Active {formatAgo(new Date(d.lastSeen).getTime() / 1000)} · paired {formatAgo(new Date(d.created).getTime() / 1000)}</div>
                </div>
                <button class="icon-btn" aria-label={`Remove ${d.name}`} onClick={() => removeDevice(d.id, d.current)}><Icon name={d.current ? "logout" : "trash"} /></button>
              </div>
            )}
          </For>
        </div>

        <Show when={!standalone}>
          <h2 class="section-title">Install the app</h2>
          <div class="card muted" style={{ "font-size": "14px" }}>
            <Show when={/iPhone|iPad/.test(navigator.userAgent)} fallback={<>In your browser menu choose <b>Install app</b> or <b>Add to Home screen</b> to get a full-screen app with its own icon.</>}>
              In Safari, tap <b>Share</b> <Icon name="share" size={14} /> then <b>Add to Home Screen</b> to get a full-screen app with its own icon.
            </Show>
          </div>
        </Show>

        <h2 class="section-title">Library</h2>
        <div class="list">
          <A class="list-item" href="/sources"><Icon name="sources" /><div class="grow"><div class="title">Sources</div><div class="sub">Add platforms, sign in, enable or disable</div></div><Icon name="forward" size={18} /></A>
          <A class="list-item" href="/library"><Icon name="history" /><div class="grow"><div class="title">Watch history</div></div><Icon name="forward" size={18} /></A>
          <A class="list-item" href="/setup"><Icon name="refresh" /><div class="grow"><div class="title">Import & sync</div><div class="sub">Grayjay Sync, Grayjay backups, YouTube/NewPipe subscriptions</div></div><Icon name="forward" size={18} /></A>
          <a class="list-item" href="/web/export/Backup" download=""><Icon name="download" /><div class="grow"><div class="title">Download a backup</div><div class="sub">Subscriptions, playlists and sources as a Grayjay .zip</div></div></a>
        </div>

        <h2 class="section-title">Support Grayjay</h2>
        <div class="card stack">
          <Show when={purchased()} fallback={<>
            <p class="muted" style={{ "font-size": "14px" }}>
              Grayjay is made by FUTO and is free to use. If you find it useful, buying a license supports its development{price() ? ` (${price()})` : ""}.
            </p>
            <div class="row" style={{ "flex-wrap": "wrap" }}>
              <a class="btn accent" href={FUTO_PAYMENT_PORTAL} target="_blank" rel="noreferrer"><Icon name="heart" size={18} /> Buy Grayjay</a>
              <button class="btn" onClick={() => setLicenseOpen(true)}>Enter license key</button>
            </div>
          </>}>
            <div class="row"><Icon name="heart" filled style={{ color: "#e5212c" }} /><div>Licensed. Thank you for supporting Grayjay!</div></div>
          </Show>
        </div>

        <h2 class="section-title">About</h2>
        <div class="card stack" style={{ "font-size": "14px" }}>
          <p><b>Grayjay Web</b> is an unofficial, modified version of <a href="https://grayjay.app" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>Grayjay</a> by FUTO, rebuilt as a self-hosted web app. It is not affiliated with or endorsed by FUTO.</p>
          <p class="muted">Licensed under the Source First License 1.1. You may use it for non-commercial purposes; see the LICENSE file shipped with the server.</p>
        </div>
      </main>

      <Sheet open={pairOpen()} onClose={() => { setPairOpen(false); refetch(); }} title="Pair a device">
        <PairDevice />
      </Sheet>
      <Sheet open={licenseOpen()} onClose={() => setLicenseOpen(false)} title="License key">
        <form class="stack" onSubmit={(e) => { e.preventDefault(); activate(); }}>
          <input class="field" placeholder="Paste your license key" value={license()} onInput={(e) => setLicense(e.currentTarget.value)} autocomplete="off" spellcheck={false} />
          <button class="btn accent block" disabled={!license().trim()}>Activate</button>
        </form>
      </Sheet>
    </>
  );
}
