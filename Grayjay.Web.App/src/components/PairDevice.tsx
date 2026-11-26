import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import qrcode from "qrcode-generator";
import { auth } from "../api";
import Icon from "./Icon";

function qrSvg(text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

/** Shows a one-time pairing QR code. Scanning it with a phone camera opens the PWA already signed in. */
export default function PairDevice() {
  const [data, { refetch }] = createResource(() => auth.pairingCode());
  const [linkIndex, setLinkIndex] = createSignal(0);
  const [left, setLeft] = createSignal(0);

  const timer = setInterval(() => {
    const d = data();
    if (!d) return;
    const remaining = Math.max(0, (d as any)._expires - Date.now());
    setLeft(Math.round(remaining / 1000));
    if (remaining <= 0) refetch();
  }, 1000);
  onCleanup(() => clearInterval(timer));

  const withExpiry = () => {
    const d = data();
    if (d && !(d as any)._expires) (d as any)._expires = Date.now() + d.expiresInSeconds * 1000;
    return d;
  };

  const links = () => {
    const d = withExpiry();
    if (!d) return [];
    // Prefer the address this browser is using when it's a real network address (e.g. Tailscale HTTPS).
    const here = `${location.origin}/app/#pair=${d.code}`;
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    const all = isLocal ? d.links : [{ label: "This address", url: here, secure: location.protocol === "https:" }, ...d.links.filter((l) => !l.url.startsWith(location.origin))];
    return all.sort((a, b) => Number(b.secure) - Number(a.secure));
  };
  const link = () => links()[Math.min(linkIndex(), Math.max(0, links().length - 1))];

  return (
    <div class="pair-device">
      <Show when={data()} fallback={<div class="feed-status"><div class="spinner" /></div>}>
        <Show when={link()} fallback={<p class="muted">No network address found for this server. Connect it to Wi-Fi or Tailscale.</p>}>
          <div class="qr" innerHTML={qrSvg(link()!.url)} aria-label="Pairing QR code" />
          <p class="muted" style={{ "text-align": "center" }}>Scan with your phone's camera, then tap <b>Add to Home Screen</b> for the app experience.</p>
          <div class="pair-code-display">{data()!.code.slice(0, 4)}-{data()!.code.slice(4)}</div>
          <p class="faint" style={{ "text-align": "center", "font-size": "12px" }}>One-time code · expires in {Math.floor(left() / 60)}:{String(left() % 60).padStart(2, "0")}</p>

          <Show when={links().length > 1}>
            <div class="section-title" style={{ "font-size": "14px" }}>Address</div>
            <div class="chips" style={{ "flex-wrap": "wrap", margin: 0, padding: 0 }}>
              <For each={links()}>{(l, i) => (
                <button class="chip" aria-pressed={linkIndex() === i()} onClick={() => setLinkIndex(i())}>
                  {l.secure ? "🔒 " : ""}{l.label}
                </button>
              )}</For>
            </div>
          </Show>
          <p class="faint" style={{ "font-size": "12px", "word-break": "break-all", "margin-top": "10px" }}>{link()!.url.replace(/#.*/, "")}</p>
          <Show when={!link()!.secure}>
            <p class="faint" style={{ "font-size": "12px", "margin-top": "6px" }}>
              <Icon name="lock" size={12} /> This address isn't HTTPS, so it only works at home and some app features are limited. Turn on Remote access in the Grayjay tray app.
            </p>
          </Show>
          <button class="btn block" style={{ "margin-top": "14px" }} onClick={() => navigator.clipboard?.writeText(link()!.url)}>Copy link</button>
        </Show>
      </Show>
    </div>
  );
}
