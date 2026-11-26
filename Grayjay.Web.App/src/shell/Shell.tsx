import { JSX, createEffect, on, onMount } from "solid-js";
import { A, useLocation, useNavigate, useSearchParams } from "@solidjs/router";
import { setup } from "../api";
import CustomDialogs from "./CustomDialogs";
import GlobalSheets from "../components/GlobalSheets";
import Icon from "../components/Icon";
import Toasts from "../components/Toasts";
import WatchOverlay from "../player/WatchOverlay";
import { player } from "../player/store";
import ServerDialogs from "./ServerDialogs";
import RemoteBrowserHost from "../remote/RemoteBrowserHost";
import UpdatePrompt from "./UpdatePrompt";

const tabs = [
  { href: "/", icon: "subs", label: "Subscriptions", end: true },
  { href: "/discover", icon: "discover", label: "Discover" },
  { href: "/search", icon: "search", label: "Search" },
  { href: "/library", icon: "library", label: "Library" },
  { href: "/sources", icon: "sources", label: "Sources" },
];

export default function Shell(props: { children?: JSX.Element }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  // useLocation() includes the router base (/app); compare against the app-relative path.
  const path = () => location.pathname.replace(/^\/app(?=\/|$)/, "") || "/";

  // New server with nothing in it yet: start the setup wizard (import/sync, sources, sign-in).
  onMount(async () => {
    try {
      const s = await setup.status();
      if (!s.done && s.subscriptions === 0 && !/^\/(setup|share)/.test(path()) && !params.watch) navigate("/setup", { replace: true });
    } catch { }
  });
  const isSetup = () => path().startsWith("/setup");

  // ?watch=<url> opens the full-screen player; Back minimizes it.
  player.bindNavigation({
    setWatchParam: (url, replace) => setParams({ watch: url ?? undefined }, { replace, scroll: false }),
    back: () => history.back(),
  });
  createEffect(on(() => params.watch, (w) => player.syncFromUrl(typeof w === "string" ? w : null)));

  // Scroll to top on page change (not on ?watch toggles).
  createEffect(on(() => location.pathname, () => window.scrollTo({ top: 0 }), { defer: true }));

  return (
    <>
      {/* No <Suspense> here on purpose: any resource refetch inside a page (e.g. search suggestions on each keystroke)
          would swap the whole page for the fallback and rebuild it, losing input focus. Pages handle loading themselves. */}
      {props.children}

      <WatchOverlay />
      <GlobalSheets />

      <nav class="tabbar" aria-label="Main" hidden={isSetup()}>
        <A href="/" class="rail-logo" aria-label="Home"><img src="/app/logo.svg" alt="" width="30" height="30" /></A>
        {tabs.map((t) => (
          <A href={t.href} end={t.end} class="tab" activeClass="active">
            <Icon name={t.icon} />
            <span>{t.label}</span>
          </A>
        ))}
        <A href="/settings" class="tab rail-only" activeClass="active"><Icon name="settings" /><span>Settings</span></A>
      </nav>

      <Toasts />
      <ServerDialogs />
      <CustomDialogs />
      <RemoteBrowserHost />
      <UpdatePrompt />
    </>
  );
}
