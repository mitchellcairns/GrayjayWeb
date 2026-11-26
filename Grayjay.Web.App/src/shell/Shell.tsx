import { JSX, Suspense, createEffect, on } from "solid-js";
import { A, useLocation, useSearchParams } from "@solidjs/router";
import Icon from "../components/Icon";
import Toasts from "../components/Toasts";
import WatchOverlay from "../player/WatchOverlay";
import { player } from "../player/store";
import ServerDialogs from "./ServerDialogs";
import RemoteBrowserHost from "../remote/RemoteBrowserHost";
import UpdatePrompt from "./UpdatePrompt";

const tabs = [
  { href: "/", icon: "home", label: "Home", end: true },
  { href: "/subscriptions", icon: "subs", label: "Subscriptions" },
  { href: "/search", icon: "search", label: "Search" },
  { href: "/library", icon: "library", label: "Library" },
  { href: "/sources", icon: "sources", label: "Sources" },
];

export default function Shell(props: { children?: JSX.Element }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();

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
      <Suspense fallback={<div class="page"><div class="feed-status"><div class="spinner" /></div></div>}>
        {props.children}
      </Suspense>

      <WatchOverlay />

      <nav class="tabbar" aria-label="Main">
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
      <RemoteBrowserHost />
      <UpdatePrompt />
    </>
  );
}
