import { For, JSX, Match, Show, Switch, createResource, createSignal } from "solid-js";
import { get } from "../api/client";
import Icon from "./Icon";
import { toast } from "./Toasts";
import "./LinkSetup.css";

type Platform = "ios" | "android" | "desktop";

const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const detected: Platform = isIOS ? "ios" : isAndroid ? "android" : "desktop";
const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
const isBrave = !!(navigator as any).brave;
const isChromeAndroid = isAndroid && /Chrome\//.test(ua) && !isBrave && !/EdgA|SamsungBrowser|OPR|Firefox/.test(ua);

const LINKS = {
  chromeAndroid: "https://play.google.com/store/apps/details?id=com.android.chrome",
  tailscaleAndroid: "https://play.google.com/store/apps/details?id=com.tailscale.ipn",
  tailscaleIOS: "https://apps.apple.com/app/tailscale/id1470499037",
  shortcutsIOS: "https://apps.apple.com/app/shortcuts/id915249334",
  urlCheckPlay: "https://play.google.com/store/apps/details?id=com.trianguloy.urlchecker",
  urlCheckFDroid: "https://f-droid.org/packages/com.trianguloy.urlchecker/",
};

async function copy(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); toast("Copied", "info", 1500); return; }
  } catch { }
  window.prompt("Copy this", text); // plain-HTTP addresses have no clipboard API
}

function CopyLine(props: { text: string }) {
  return (
    <div class="ls-copy">
      <code>{props.text}</code>
      <button class="btn small" onClick={() => copy(props.text)}>Copy</button>
    </div>
  );
}

function Step(props: { n: number; children: JSX.Element }) {
  return <li class="ls-step"><span class="ls-num">{props.n}</span><div>{props.children}</div></li>;
}

function StoreLink(props: { href: string; children: JSX.Element }) {
  return <a class="btn small ls-store" href={props.href} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> {props.children}</a>;
}

/**
 * Settings → "Open YouTube links in Grayjay": how to send links from other apps to Grayjay on this kind of device
 * (detected, switchable), plus getting it to work away from home. Uses the server's real public address.
 */
export default function LinkSetup() {
  const [platform, setPlatform] = createSignal<Platform>(detected);
  const [addrs] = createResource(() => get<{ tailscale: string | null; configured: string[] }>("/web/Addresses").catch(() => ({ tailscale: null, configured: [] })));

  /** The address a phone should use: Tailscale's HTTPS address, a configured public URL, or this one. */
  const phoneAddress = () => addrs()?.tailscale ?? addrs()?.configured?.[0] ?? location.origin;
  const homeOnly = () => /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|127\.)/.test(phoneAddress());
  const viaTailscale = () => location.hostname.endsWith(".ts.net");
  const watchPrefix = () => `${phoneAddress()}/app/?watch=`;
  const bookmarklet = () => `javascript:(()=>{location.href=${JSON.stringify(location.origin + "/app/?watch=")}+encodeURIComponent(location.href)})()`;

  return (
    <div class="link-setup">
      <div class="seg ls-platforms" role="tablist" aria-label="Device">
        <For each={[["ios", "iPhone / iPad"], ["android", "Android"], ["desktop", "Computer"]] as [Platform, string][]}>
          {([p, label]) => (
            <button role="tab" aria-pressed={platform() === p} aria-selected={platform() === p} onClick={() => setPlatform(p)}>
              {label}{p === detected ? " (this device)" : ""}
            </button>
          )}
        </For>
      </div>

      <Switch>
        <Match when={platform() === "android"}>
          <h3 class="ls-h">Share a video to Grayjay</h3>
          <Show when={platform() === detected && !(standalone && isChromeAndroid)}>
            <div class="ls-note">
              <Icon name="alert" size={16} />
              <span>
                {isBrave ? "Brave" : "This browser"} can't add web apps to Android's Share menu. Install Grayjay from <b>Chrome</b> for this to work.
              </span>
            </div>
          </Show>
          <ol class="ls-steps">
            <Step n={1}>
              Open <b>{phoneAddress()}/app/</b> in <b>Chrome</b>, then <b>⋮ → Install app</b> (or Add to Home screen).
              <div class="ls-actions"><StoreLink href={LINKS.chromeAndroid}>Chrome on Google Play</StoreLink></div>
            </Step>
            <Step n={2}>In YouTube, a browser or any app, tap <b>Share</b> on a video.</Step>
            <Step n={3}>Pick <b>Grayjay</b>. The video opens straight in the player.</Step>
          </ol>
          <Show when={platform() === detected && standalone && isChromeAndroid}>
            <p class="ls-ok"><Icon name="check" size={16} /> You're in the app installed from Chrome, so Grayjay is in your Share menu.</p>
          </Show>

          <details class="ls-more">
            <summary>Advanced: open YouTube links in Grayjay with one tap</summary>
            <p class="muted">Android only lets real apps claim youtube.com links. A link-rewriting app such as URLCheck can send them to Grayjay instead.
              It's a separate app that sees every link you open, so only set this up if you're comfortable with that.</p>
            <ol class="ls-steps">
              <Step n={1}>Install URLCheck and set it as your default browser when it asks.
                <div class="ls-actions"><StoreLink href={LINKS.urlCheckPlay}>Google Play</StoreLink><StoreLink href={LINKS.urlCheckFDroid}>F-Droid</StoreLink></div>
              </Step>
              <Step n={2}>In its <b>Pattern checker</b> module, add a rule for YouTube links (<code>youtube.com</code>, <code>youtu.be</code>) that replaces the link with this address followed by the link:
                <CopyLine text={watchPrefix()} />
              </Step>
            </ol>
          </details>
        </Match>

        <Match when={platform() === "ios"}>
          <h3 class="ls-h">Send a video to Grayjay with a Shortcut</h3>
          <p class="muted ls-p">iPhone doesn't let web apps appear in the Share menu, but a Shortcut can. You make it once.</p>
          <ol class="ls-steps">
            <Step n={1}>Open the <b>Shortcuts</b> app and tap <b>+</b> to make a new shortcut. Name it <b>Open in Grayjay</b>.
              <div class="ls-actions"><StoreLink href={LINKS.shortcutsIOS}>Shortcuts on the App Store</StoreLink></div>
            </Step>
            <Step n={2}>Tap <b>ⓘ</b> and turn on <b>Show in Share Sheet</b>. Under share sheet types, keep only <b>URLs</b>.</Step>
            <Step n={3}>Add the action <b>URL Encode</b> (it uses the Shortcut Input).</Step>
            <Step n={4}>Add <b>Text</b>. Paste this, then insert the <b>URL Encoded Text</b> variable right after it:
              <CopyLine text={watchPrefix()} />
            </Step>
            <Step n={5}>Add <b>Open URLs</b> with that Text. Done: in YouTube or Safari, tap <b>Share → Open in Grayjay</b>.</Step>
          </ol>
          <div class="ls-note">
            <Icon name="alert" size={16} />
            <span>iPhone opens it in <b>Safari</b>, not the home-screen app, and Safari keeps its own sign-in. Open <b>{phoneAddress()}/app/</b> in Safari once and pair it
              (on your computer: Settings → Pair a phone).</span>
          </div>
          <p class="muted ls-p">Quicker for the odd video: copy the link, open Grayjay, and paste it into <b>Search</b>. It opens the video directly.</p>
        </Match>

        <Match when={platform() === "desktop"}>
          <h3 class="ls-h">"Open in Grayjay" bookmark</h3>
          <ol class="ls-steps">
            <Step n={1}>Show your bookmarks bar (Ctrl+Shift+B, or ⌘+Shift+B on a Mac).</Step>
            <Step n={2}>Drag this button onto it:
              <div class="ls-actions">
                <a class="btn small accent ls-bookmarklet" href={bookmarklet()} onClick={(e) => { e.preventDefault(); toast("Drag it to your bookmarks bar instead of clicking it", "info", 3000); }}>
                  <Icon name="play" filled size={14} /> Open in Grayjay
                </a>
              </div>
            </Step>
            <Step n={3}>On any YouTube video, click the bookmark. The video opens in Grayjay.</Step>
          </ol>
          <p class="muted ls-p">Or paste a link into Grayjay's <b>Search</b>: it opens the video directly.</p>
        </Match>
      </Switch>

      <Show when={platform() !== "desktop"}>
        <h3 class="ls-h">Use it away from home</h3>
        <Show when={addrs()?.tailscale} fallback={
          <p class="muted ls-p">
            <Show when={homeOnly()} fallback={<>Your server is reachable at <b>{phoneAddress()}</b>.</>}>
              Right now Grayjay only works on your home network. On the computer running it, open the tray icon → <b>Remote access → Turn on</b> (uses the free Tailscale app).
            </Show>
          </p>
        }>
          <Show when={viaTailscale()} fallback={
            <ol class="ls-steps">
              <Step n={1}>Install <b>Tailscale</b> on this {platform() === "ios" ? "iPhone" : "phone"} and sign in with the <b>same account</b> as your computer. Leave it connected.
                <div class="ls-actions">
                  <Show when={platform() === "ios"} fallback={<StoreLink href={LINKS.tailscaleAndroid}>Tailscale on Google Play</StoreLink>}>
                    <StoreLink href={LINKS.tailscaleIOS}>Tailscale on the App Store</StoreLink>
                  </Show>
                </div>
              </Step>
              <Step n={2}>Open <b>{addrs()!.tailscale}/app/</b>, pair it, and add it to your home screen.</Step>
            </ol>
          }>
            <p class="ls-ok"><Icon name="check" size={16} /> You're already using Grayjay through Tailscale ({location.hostname}), so it works anywhere this {platform() === "ios" ? "iPhone" : "phone"} has internet.</p>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
