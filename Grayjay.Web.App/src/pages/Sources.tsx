import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { SourceConfig, remoteBrowser, sources } from "../api";
import { on } from "../api/socket";
import Icon from "../components/Icon";
import Sheet from "../components/Sheet";
import SourceSettingsForm from "../components/SourceSettingsForm";
import { YOUTUBE_CHANNEL_SWITCHER, isYouTube, signInAndWait } from "../lib/signin";
import { toast, toastError } from "../components/Toasts";
import PageHeader from "../shell/PageHeader";
import "./Sources.css";

export function iconOf(c?: SourceConfig) {
  if (!c) return undefined;
  const icon = c.absoluteIconUrl || c.iconUrl;
  if (!icon) return undefined;
  try { return new URL(icon, c.sourceUrl || location.href).toString(); } catch { return icon; }
}

function SourceIcon(props: { config?: SourceConfig; size?: number }) {
  return (
    <div class="src-icon" style={{ width: `${props.size ?? 40}px`, height: `${props.size ?? 40}px` }}>
      <Show when={iconOf(props.config)} fallback={<Icon name="sources" />}>
        <img src={iconOf(props.config)} alt="" loading="lazy" referrerpolicy="no-referrer" />
      </Show>
    </div>
  );
}

export default function Sources() {
  const [enabled, { refetch: refetchEnabled }] = createResource(() => sources.enabled());
  const [disabled, { refetch: refetchDisabled }] = createResource(() => sources.disabled());
  const [official, { refetch: refetchOfficial }] = createResource(() => sources.official().catch(() => []));
  const [selected, setSelected] = createSignal<string | null>(null);
  const lastSelected = createMemo<string | null>((prev) => selected() ?? prev, null); // shown while the sheet slides closed
  const [installUrl, setInstallUrl] = createSignal("");
  const [installing, setInstalling] = createSignal<Set<string>>(new Set<string>());
  const [busy, setBusy] = createSignal(false);

  const refresh = () => { refetchEnabled(); refetchDisabled(); refetchOfficial(); };
  const offs = [on("EnabledClientsChanged", refresh), on("PluginUpdated", refresh)];
  onCleanup(() => offs.forEach((o) => o()));

  const setEnabled = async (c: SourceConfig, value: boolean) => {
    try { value ? await sources.enable(c.id) : await sources.disable(c.id); refresh(); }
    catch (e) { toastError(e); }
  };

  const installOfficial = async (c: SourceConfig) => {
    setInstalling((s) => new Set(s).add(c.id));
    try {
      await sources.installOfficial([c.id]);
      await sources.enable(c.id).catch(() => { });
      toast(`${c.name} added`);
      refresh();
    } catch (e) { toastError(e); }
    finally { setInstalling((s) => { const n = new Set(s); n.delete(c.id); return n; }); }
  };

  const installFromUrl = async () => {
    const url = installUrl().trim();
    if (!url) return;
    setBusy(true);
    try {
      const prompt = await sources.installPrompt(url);
      const name = prompt?.config?.name ?? "this source";
      const warnings: string[] = (prompt?.warnings ?? []).map((w: any) => w?.title ? `${w.title}: ${w.description ?? ""}` : String(w));
      const ok = confirm(`Install ${name}${prompt?.config?.author ? ` by ${prompt.config.author}` : ""}?\n\n${warnings.join("\n")}\n\nOnly install sources you trust: they run code on your server.`);
      if (!ok) return;
      const cfg = await sources.install(url);
      await sources.enable(cfg.id).catch(() => { });
      toast(`${cfg.name} installed`);
      setInstallUrl("");
      refresh();
    } catch (e) { toastError(e); }
    finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="Sources" />
      <main class="page" style={{ "max-width": "900px" }}>
        <p class="muted" style={{ "margin-bottom": "14px" }}>Sources are plugins that connect Grayjay to a platform. They run on your server, not on this device.</p>

        <h2 class="section-title">Enabled</h2>
        <div class="list">
          <For each={enabled()} fallback={<div class="list-item"><div class="grow muted">No sources enabled yet.</div></div>}>
            {(c) => (
              <div class="list-item">
                <button class="src-main" onClick={() => setSelected(c.id)}>
                  <SourceIcon config={c} />
                  <div class="grow"><div class="title">{c.name}</div><div class="sub">{c.description}</div></div>
                </button>
                <label class="switch" aria-label={`Enable ${c.name}`}><input type="checkbox" checked onChange={() => setEnabled(c, false)} /><span /></label>
              </div>
            )}
          </For>
        </div>

        <Show when={(disabled()?.length ?? 0) > 0}>
          <h2 class="section-title">Disabled</h2>
          <div class="list">
            <For each={disabled()}>
              {(c) => (
                <div class="list-item">
                  <button class="src-main" onClick={() => setSelected(c.id)}>
                    <SourceIcon config={c} />
                    <div class="grow"><div class="title">{c.name}</div><div class="sub">{c.description}</div></div>
                  </button>
                  <label class="switch" aria-label={`Enable ${c.name}`}><input type="checkbox" onChange={() => setEnabled(c, true)} /><span /></label>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={(official()?.length ?? 0) > 0}>
          <h2 class="section-title">Add official sources</h2>
          <div class="src-grid">
            <For each={official()}>
              {(c) => (
                <div class="src-card">
                  <SourceIcon config={c} size={44} />
                  <div class="grow">
                    <div class="title">{c.name}</div>
                    <div class="sub">{c.description}</div>
                  </div>
                  <button class="btn small accent" disabled={installing().has(c.id)} onClick={() => installOfficial(c)}>
                    {installing().has(c.id) ? "Adding…" : "Add"}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={official.loading}><div class="feed-status"><div class="spinner" /></div></Show>

        <h2 class="section-title">Install from a link</h2>
        <form class="row" onSubmit={(e) => { e.preventDefault(); installFromUrl(); }}>
          <input class="field" type="url" inputmode="url" placeholder="https://…/Config.json" value={installUrl()} onInput={(e) => setInstallUrl(e.currentTarget.value)} />
          <button class="btn" disabled={busy() || !installUrl().trim()}>Install</button>
        </form>
      </main>

      <Sheet open={!!selected()} onClose={() => setSelected(null)} title="Source">
        <Show when={lastSelected()}>
          <SourceDetailsView id={lastSelected()!} onChanged={refresh} onRemoved={() => { setSelected(null); refresh(); }} />
        </Show>
      </Sheet>
    </>
  );
}

function SourceDetailsView(props: { id: string; onChanged: () => void; onRemoved: () => void }) {
  const [d, { refetch }] = createResource(() => props.id, (id) => sources.details(id));
  const [signingIn, setSigningIn] = createSignal<"signin" | "channel" | null>(null);
  const [showSettings, setShowSettings] = createSignal(false);
  const [justSignedIn, setJustSignedIn] = createSignal(false);

  // Waits for the sign-in browser to close, then reports what actually happened.
  const login = async (startUrl?: string) => {
    const wasSignedIn = !!d()?.hasLoggedIn;
    setSigningIn(startUrl ? "channel" : "signin");
    try {
      const ok = await signInAndWait(props.id, startUrl);
      if (ok) {
        toast(startUrl ? "Channel switched" : "Signed in");
        if (!startUrl && !wasSignedIn) setJustSignedIn(true);
      } else if (!wasSignedIn) toast("Sign-in wasn't completed", "error");
      refetch(); props.onChanged();
    } catch (e) { toastError(e); }
    finally { setSigningIn(null); }
  };
  const chooseChannel = () => { setJustSignedIn(false); login(YOUTUBE_CHANNEL_SWITCHER); };
  const logout = async () => {
    try {
      await sources.logout(props.id);
      // Also forget the remembered sign-in browser profile so the account isn't offered again.
      await remoteBrowser.forgetAccounts().catch(() => { });
      toast("Signed out"); refetch(); props.onChanged();
    } catch (e) { toastError(e); }
  };
  const remove = async () => {
    if (!confirm(`Remove ${d()?.config.name}?`)) return;
    try { await sources.remove(props.id); toast("Removed"); props.onRemoved(); } catch (e) { toastError(e); }
  };

  return (
    <Show when={d()} fallback={<div class="feed-status" style={{ "min-height": "300px" }}><div class="spinner" /></div>}>
      <div class="stack">
        <div class="row">
          <SourceIcon config={d()!.config} size={56} />
          <div class="grow" style={{ "min-width": 0 }}>
            <div style={{ "font-size": "20px", "font-weight": 700 }}>{d()!.config.name}</div>
            <div class="muted" style={{ "font-size": "13px" }}>v{d()!.config.version}{d()!.config.author ? ` · ${d()!.config.author}` : ""}</div>
          </div>
        </div>
        <Show when={d()!.config.description}><p class="muted">{d()!.config.description}</p></Show>

        <Show when={d()!.config.authentication}>
          <div class="card" style={{ background: "var(--bg-elev-2)" }}>
            <div class="row">
              <Icon name="user" />
              <div class="grow">
                <div style={{ "font-weight": 600 }}>{d()!.hasLoggedIn ? "Signed in" : "Not signed in"}</div>
                <div class="muted" style={{ "font-size": "13px" }}>
                  {d()!.hasLoggedIn ? "Your recommendations, subscriptions and history from this platform are used." : "Sign in for personal recommendations, age-restricted and members-only content."}
                </div>
              </div>
            </div>
            <div class="row" style={{ "margin-top": "12px" }}>
              <Show when={d()!.hasLoggedIn} fallback={
                <button class="btn accent block" onClick={() => login()} disabled={!!signingIn()}>{signingIn() ? "Waiting for sign-in…" : "Sign in"}</button>
              }>
                <Show when={isYouTube(d()!.config.name)} fallback={
                  <button class="btn block" onClick={() => login()} disabled={!!signingIn()}>{signingIn() ? "Waiting…" : "Switch account"}</button>
                }>
                  <button class="btn block" onClick={chooseChannel} disabled={!!signingIn()}>{signingIn() === "channel" ? "Waiting…" : "Choose channel"}</button>
                </Show>
                <button class="btn block danger" onClick={logout} disabled={!!signingIn()}>Sign out</button>
              </Show>
            </div>
            <Show when={justSignedIn() && isYouTube(d()!.config.name)}>
              <div class="signin-followup">
                <span>Have more than one YouTube channel or a brand account?</span>
                <button class="btn small accent" onClick={chooseChannel}>Choose channel</button>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={(d()!.config.settings?.length ?? 0) > 0}>
          <button class="list-item card" style={{ padding: "14px 16px" }} onClick={() => setShowSettings(!showSettings())} aria-expanded={showSettings()}>
            <Icon name="settings" />
            <div class="grow"><div class="title">Settings</div><div class="sub">{/youtube/i.test(d()!.config.name) ? "SponsorBlock, dislikes, DeArrow, streams…" : "Options for this source"}</div></div>
            <Icon name={showSettings() ? "up" : "down"} size={18} />
          </button>
          <Show when={showSettings()}><SourceSettingsForm id={props.id} /></Show>
        </Show>

        <div class="list">
          <Show when={d()!.config.platformUrl}>
            <a class="list-item" href={d()!.config.platformUrl} target="_blank" rel="noreferrer"><Icon name="globe" /><div class="grow">Website</div><Icon name="external" size={18} /></a>
          </Show>
          <Show when={d()!.config.repositoryUrl}>
            <a class="list-item" href={d()!.config.repositoryUrl} target="_blank" rel="noreferrer"><Icon name="link" /><div class="grow">Source code</div><Icon name="external" size={18} /></a>
          </Show>
          <button class="list-item danger" onClick={remove}><Icon name="trash" /><div class="grow">Remove source</div></button>
        </div>
      </div>
    </Show>
  );
}
