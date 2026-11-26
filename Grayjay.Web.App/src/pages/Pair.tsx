import { Show, createSignal, onMount } from "solid-js";
import { auth } from "../api";
import Icon from "../components/Icon";
import "./Pair.css";

function defaultDeviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad"
    : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone;
  return `${os}${standalone ? " (app)" : ""}`;
}

/** First screen on a new device: redeem a pairing code (usually via the QR code's #pair= link) or a password. */
export default function PairScreen(props: { passwordEnabled: boolean; onPaired: () => void }) {
  const [code, setCode] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [usePassword, setUsePassword] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const pair = async (c: string) => {
    setBusy(true); setError(null);
    try {
      await auth.pair(c, defaultDeviceName());
      history.replaceState(null, "", location.pathname + location.search);
      props.onPaired();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(false); }
  };

  const login = async () => {
    setBusy(true); setError(null);
    try { await auth.login(password(), defaultDeviceName()); props.onPaired(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  onMount(() => {
    const m = location.hash.match(/pair=([A-Za-z0-9-]+)/);
    if (m) { setCode(m[1].toUpperCase()); pair(m[1]); }
  });

  const formatted = () => {
    const c = code().replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
    return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
  };

  return (
    <main class="pair">
      <div class="pair-card">
        <img src="/app/logo.svg" alt="" width="64" height="64" class="pair-logo" />
        <h1>Connect this device</h1>
        <Show when={!usePassword()} fallback={
          <form onSubmit={(e) => { e.preventDefault(); login(); }} class="stack">
            <p class="muted">Enter the password set on your Grayjay server.</p>
            <input class="field" type="password" autocomplete="current-password" placeholder="Server password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
            <button class="btn accent block" disabled={busy() || !password()}>Sign in</button>
          </form>
        }>
          <p class="muted">
            On your computer, open Grayjay from the tray icon and choose <b>Pair a phone</b>, then scan the QR code with your camera.
            Or type the code shown there:
          </p>
          <form onSubmit={(e) => { e.preventDefault(); pair(code()); }} class="stack">
            <input
              class="field pair-code"
              inputmode="text"
              autocomplete="one-time-code"
              autocapitalize="characters"
              spellcheck={false}
              placeholder="ABCD-1234"
              maxLength={9}
              value={formatted()}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
            <button class="btn accent block" disabled={busy() || code().replace(/[^A-Za-z0-9]/g, "").length < 8}>
              {busy() ? "Connecting…" : "Connect"}
            </button>
          </form>
        </Show>
        <Show when={error()}>
          <p class="pair-error"><Icon name="alert" size={16} /> {error()}</p>
        </Show>
        <Show when={props.passwordEnabled}>
          <button class="btn ghost small" onClick={() => setUsePassword(!usePassword())}>
            {usePassword() ? "Use a pairing code instead" : "Use a password instead"}
          </button>
        </Show>
        <Show when={location.protocol === "http:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1"}>
          <p class="pair-note faint">
            <Icon name="lock" size={14} /> You're connected without HTTPS. Turn on remote access (Tailscale) in the Grayjay tray app for a secure address and the full app experience.
          </p>
        </Show>
      </div>
    </main>
  );
}
