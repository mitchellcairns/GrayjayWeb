import { For, Match, Show, Switch, createResource, createSignal, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import qrcode from "qrcode-generator";
import { SourceConfig, setup, sources, sync } from "../api";
import { on } from "../api/socket";
import Icon from "../components/Icon";
import { toast, toastError } from "../components/Toasts";
import { iconOf } from "./Sources";
import { YOUTUBE_CHANNEL_SWITCHER, isYouTube, signInAndWait } from "../lib/signin";
import "./Setup.css";

type Step = "welcome" | "data" | "sources" | "signin" | "done";
const steps: Step[] = ["welcome", "data", "sources", "signin", "done"];

/** Parses a YouTube (Google Takeout) subscriptions.csv, or any text containing channel URLs. */
export function parseSubscriptionList(text: string): string[] {
  const urls = new Set<string>();
  const lines = text.split(/\r?\n/);
  const header = lines[0]?.toLowerCase() ?? "";
  if (header.includes("channel id") && header.includes("channel url")) {
    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      const url = cols.find((c) => /^https?:\/\//i.test(c.trim()))?.trim();
      const id = cols[0]?.trim();
      if (url) urls.add(url.replace(/^http:/, "https:"));
      else if (/^UC[\w-]{20,}$/.test(id)) urls.add(`https://www.youtube.com/channel/${id}`);
    }
  }
  for (const m of text.matchAll(/https?:\/\/[^\s,"'<>]+/g)) {
    const u = m[0];
    if (/youtube\.com\/(channel|c|user|@)|youtube\.com\/@|\/@[\w.-]+|\/channel\/|\/c\/|\/user\/|\/a\/|\/video-channels\//i.test(u)) urls.add(u);
  }
  return [...urls];
}

function qrSvg(text: string) {
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export default function Setup() {
  const navigate = useNavigate();
  const [step, setStep] = createSignal<Step>("welcome");
  const [status, { refetch: refetchStatus }] = createResource(() => setup.status());
  const index = () => steps.indexOf(step());
  const next = () => setStep(steps[Math.min(steps.length - 1, index() + 1)]);
  const back = () => setStep(steps[Math.max(0, index() - 1)]);

  const finish = async () => {
    await setup.complete().catch(() => { });
    navigate("/", { replace: true });
  };

  const offs = [on("SubscriptionsChanged", () => refetchStatus()), on("EnabledClientsChanged", () => refetchStatus())];
  onCleanup(() => offs.forEach((o) => o()));

  return (
    <main class="setup">
      <div class="setup-card">
        <div class="setup-progress" aria-hidden="true">
          <For each={steps}>{(s, i) => <span classList={{ on: i() <= index() }} />}</For>
        </div>

        <Switch>
          <Match when={step() === "welcome"}>
            <div class="setup-hero">
              <img src="/app/logo.svg" alt="" width="72" height="72" />
              <h1>Welcome to Grayjay</h1>
              <p class="muted">Let's get you set up. You can bring your subscriptions and history over from Grayjay on another device, and choose where you watch from.</p>
            </div>
            <div class="setup-actions">
              <button class="btn ghost" onClick={finish}>Skip setup</button>
              <button class="btn accent" onClick={next}>Get started</button>
            </div>
          </Match>

          <Match when={step() === "data"}>
            <BringData onChanged={refetchStatus} />
            <div class="setup-summary muted">
              <Show when={status()}>{status()!.subscriptions} subscription{status()!.subscriptions === 1 ? "" : "s"} · {status()!.syncDevices} linked device{status()!.syncDevices === 1 ? "" : "s"}</Show>
            </div>
            <div class="setup-actions">
              <button class="btn ghost" onClick={back}>Back</button>
              <button class="btn accent" onClick={next}>{(status()?.subscriptions ?? 0) > 0 ? "Continue" : "Start fresh"}</button>
            </div>
          </Match>

          <Match when={step() === "sources"}>
            <ChooseSources onDone={next} onBack={back} />
          </Match>

          <Match when={step() === "signin"}>
            <SignIn />
            <div class="setup-actions">
              <button class="btn ghost" onClick={back}>Back</button>
              <button class="btn accent" onClick={next}>Continue</button>
            </div>
          </Match>

          <Match when={step() === "done"}>
            <div class="setup-hero">
              <div class="setup-done"><Icon name="check" size={36} /></div>
              <h1>You're all set</h1>
              <p class="muted">Your subscriptions are your home screen. Add Grayjay to your home screen for the full app, and pair more devices any time from Settings.</p>
            </div>
            <div class="setup-actions">
              <button class="btn accent block" onClick={finish}>Go to Subscriptions</button>
            </div>
          </Match>
        </Switch>
      </div>
    </main>
  );
}

function BringData(props: { onChanged: () => void }) {
  const [mode, setMode] = createSignal<"sync" | null>(null);
  const [pairingUrl, setPairingUrl] = createSignal<string | null>(null);
  const [devices, { refetch: refetchDevices }] = createResource(() => sync.devices().catch(() => []));
  const [busy, setBusy] = createSignal<string | null>(null);
  let backupInput!: HTMLInputElement, subsInput!: HTMLInputElement;

  const startSync = async () => {
    setMode("sync");
    try {
      const r = await sync.enable();
      setPairingUrl(r.pairingUrl);
    } catch (e) { toastError(e); setMode(null); }
  };
  const poll = setInterval(() => { if (mode() === "sync") { refetchDevices(); props.onChanged(); } }, 4000);
  onCleanup(() => clearInterval(poll));

  const onBackup = async (file?: File) => {
    if (!file) return;
    setBusy("backup");
    try { await setup.importBackup(file); toast("Backup opened — choose what to import"); props.onChanged(); }
    catch (e) { toastError(e); }
    finally { setBusy(null); backupInput.value = ""; }
  };
  const onSubscriptions = async (file?: File) => {
    if (!file) return;
    setBusy("subs");
    try {
      const text = await file.text();
      if (/\.json$/i.test(file.name) || text.trim().startsWith("{")) {
        await setup.importNewPipe(file);
      } else {
        const urls = parseSubscriptionList(text);
        if (!urls.length) throw new Error("No channels found in that file.");
        await setup.importSubscriptionUrls(urls);
      }
      toast("Looking up channels…");
    } catch (e) { toastError(e); }
    finally { setBusy(null); subsInput.value = ""; }
  };

  return (
    <div class="stack">
      <h1 class="setup-title">Bring your stuff</h1>
      <p class="muted">Already use Grayjay or another app? Pick one, or start fresh.</p>

      <div class="setup-option" classList={{ open: mode() === "sync" }}>
        <button class="setup-option-head" onClick={() => (mode() === "sync" ? setMode(null) : startSync())}>
          <div class="setup-icon"><Icon name="refresh" /></div>
          <div class="grow">
            <div class="title">Sync with Grayjay on another device</div>
            <div class="sub">Keeps subscriptions, playlists, watch later and history in sync with your phone or computer.</div>
          </div>
          <Icon name={mode() === "sync" ? "up" : "down"} size={18} />
        </button>
        <Show when={mode() === "sync"}>
          <div class="setup-option-body">
            <Show when={pairingUrl()} fallback={<div class="feed-status"><div class="spinner" /></div>}>
              <div class="qr setup-qr" innerHTML={qrSvg(pairingUrl()!)} aria-label="Grayjay Sync pairing code" />
              <ol class="setup-steps">
                <li>Open <b>Grayjay</b> on your other device.</li>
                <li>Go to <b>Settings → Sync</b> and tap <b>Link new device</b> (scan QR).</li>
                <li>Scan this code, then approve the request that appears here.</li>
              </ol>
              <button class="btn small" onClick={() => navigator.clipboard?.writeText(pairingUrl()!).then(() => toast("Pairing link copied"))}>Copy pairing link</button>
              <Show when={(devices()?.length ?? 0) > 0}>
                <div class="list" style={{ "margin-top": "12px" }}>
                  <For each={devices()}>{(d) => (
                    <div class="list-item"><Icon name="phone" /><div class="grow"><div class="title">{d.displayName || "Grayjay device"}</div><div class="sub">{d.metadata}</div></div></div>
                  )}</For>
                </div>
              </Show>
            </Show>
          </div>
        </Show>
      </div>

      <button class="setup-option-head setup-option" onClick={() => backupInput.click()} disabled={busy() === "backup"}>
        <div class="setup-icon"><Icon name="download" /></div>
        <div class="grow">
          <div class="title">Import a Grayjay backup</div>
          <div class="sub">The .zip from Grayjay's <b>Settings → Export</b> on Android or desktop: subscriptions, playlists, sources.</div>
        </div>
        <Show when={busy() === "backup"}><div class="spinner" style={{ width: "20px", height: "20px", "border-width": "2px" }} /></Show>
      </button>
      <input ref={backupInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => onBackup(e.currentTarget.files?.[0])} />

      <button class="setup-option-head setup-option" onClick={() => subsInput.click()} disabled={busy() === "subs"}>
        <div class="setup-icon"><Icon name="subs" /></div>
        <div class="grow">
          <div class="title">Import subscriptions from YouTube or NewPipe</div>
          <div class="sub">YouTube: <b>subscriptions.csv</b> from Google Takeout. NewPipe: the subscriptions <b>.json</b> export.</div>
        </div>
        <Show when={busy() === "subs"}><div class="spinner" style={{ width: "20px", height: "20px", "border-width": "2px" }} /></Show>
      </button>
      <input ref={subsInput} type="file" accept=".csv,.json,.txt,text/csv,application/json,text/plain" hidden onChange={(e) => onSubscriptions(e.currentTarget.files?.[0])} />
    </div>
  );
}

function ChooseSources(props: { onDone: () => void; onBack: () => void }) {
  const [installed, { refetch: refetchInstalled }] = createResource(() => sources.all().catch(() => []));
  const [enabled, { refetch: refetchEnabled }] = createResource(() => sources.enabled().catch(() => []));
  const [official] = createResource(() => sources.official().catch(() => []));
  const [picked, setPicked] = createSignal<Set<string> | null>(null);
  const [busy, setBusy] = createSignal(false);

  const all = () => {
    const seen = new Set<string>();
    return [...(installed() ?? []), ...(official() ?? [])].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  };
  const isInstalled = (c: SourceConfig) => (installed() ?? []).some((x) => x.id === c.id);
  // Default: keep whatever is enabled; on a fresh install suggest YouTube.
  const selection = () => picked() ?? new Set((enabled()?.length ? enabled()! : all().filter((c) => /youtube/i.test(c.name))).map((c) => c.id));
  const toggle = (id: string) => { const s = new Set(selection()); s.has(id) ? s.delete(id) : s.add(id); setPicked(s); };

  const apply = async () => {
    setBusy(true);
    try {
      const wanted = selection();
      const toInstall = all().filter((c) => wanted.has(c.id) && !isInstalled(c)).map((c) => c.id);
      if (toInstall.length) await sources.installOfficial(toInstall);
      await refetchInstalled();
      for (const c of all()) {
        const isOn = (enabled() ?? []).some((x) => x.id === c.id);
        if (wanted.has(c.id) && !isOn) await sources.enable(c.id).catch(() => { });
        if (!wanted.has(c.id) && isOn) await sources.disable(c.id).catch(() => { });
      }
      await refetchEnabled();
      props.onDone();
    } catch (e) { toastError(e); }
    finally { setBusy(false); }
  };

  return (
    <div class="stack">
      <h1 class="setup-title">Where do you watch?</h1>
      <p class="muted">Turn on the platforms you use. You can change this any time in Sources.</p>
      <Show when={!official.loading && !installed.loading} fallback={<div class="feed-status"><div class="spinner" /></div>}>
        <div class="setup-sources">
          <For each={all()}>
            {(c) => (
              <button class="setup-source" classList={{ on: selection().has(c.id) }} onClick={() => toggle(c.id)} aria-pressed={selection().has(c.id)}>
                <div class="src-icon" style={{ width: "40px", height: "40px" }}>
                  <Show when={iconOf(c)} fallback={<Icon name="sources" />}><img src={iconOf(c)} alt="" referrerpolicy="no-referrer" /></Show>
                </div>
                <span class="name">{c.name}</span>
                <span class="tick"><Icon name="check" size={16} /></span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="setup-actions">
        <button class="btn ghost" onClick={props.onBack}>Back</button>
        <button class="btn accent" disabled={busy() || selection().size === 0} onClick={apply}>{busy() ? "Setting up…" : `Continue with ${selection().size}`}</button>
      </div>
    </div>
  );
}

function SignIn() {
  const [list, { refetch }] = createResource(async () => {
    const enabled = await sources.enabled().catch(() => []);
    const details = await Promise.all(enabled.map((c) => sources.details(c.id).catch(() => null)));
    return details.filter((d) => d && d.config.authentication);
  });
  const [busy, setBusy] = createSignal<string | null>(null);
  const login = async (id: string, startUrl?: string) => {
    setBusy(id);
    try {
      const ok = await signInAndWait(id, startUrl);
      toast(ok ? (startUrl ? "Channel switched" : "Signed in") : "Sign-in wasn't completed", ok ? "info" : "error");
      refetch();
    }
    catch (e) { toastError(e); }
    finally { setBusy(null); }
  };
  return (
    <div class="stack">
      <h1 class="setup-title">Sign in (optional)</h1>
      <p class="muted">Signing in gives you your own recommendations, members-only and age-restricted videos. Your login stays on your Grayjay server.</p>
      <Show when={!list.loading} fallback={<div class="feed-status"><div class="spinner" /></div>}>
        <Show when={(list()?.length ?? 0) > 0} fallback={<p class="faint">None of your sources need a sign-in.</p>}>
          <div class="list">
            <For each={list()}>
              {(d) => (
                <div class="list-item">
                  <div class="src-icon" style={{ width: "36px", height: "36px" }}><Show when={iconOf(d!.config)}><img src={iconOf(d!.config)} alt="" referrerpolicy="no-referrer" /></Show></div>
                  <div class="grow"><div class="title">{d!.config.name}</div><div class="sub">{d!.hasLoggedIn ? "Signed in" : "Not signed in"}</div></div>
                  <Show when={!d!.hasLoggedIn} fallback={
                    <Show when={isYouTube(d!.config.name)} fallback={<Icon name="check" />}>
                      <button class="btn small" disabled={busy() === d!.config.id} onClick={() => login(d!.config.id, YOUTUBE_CHANNEL_SWITCHER)}>{busy() === d!.config.id ? "Waiting…" : "Choose channel"}</button>
                    </Show>
                  }>
                    <button class="btn small accent" disabled={busy() === d!.config.id} onClick={() => login(d!.config.id)}>{busy() === d!.config.id ? "Waiting…" : "Sign in"}</button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
