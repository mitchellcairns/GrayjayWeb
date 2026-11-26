import { JSX, Match, Show, Switch, createResource, createSignal, lazy, onMount } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { auth } from "./api";
import { onUnauthorized } from "./api/client";
import { startSocket } from "./api/socket";
import Shell from "./shell/Shell";
import PairScreen from "./pages/Pair";
import Subscriptions from "./pages/Subscriptions";
import { offline, offlineMode, setOfflineMode } from "./lib/offline";

const Home = lazy(() => import("./pages/Home"));
const Setup = lazy(() => import("./pages/Setup"));
const Search = lazy(() => import("./pages/Search"));
const Library = lazy(() => import("./pages/Library"));
const Channel = lazy(() => import("./pages/Channel"));
const Sources = lazy(() => import("./pages/Sources"));
const Settings = lazy(() => import("./pages/Settings"));
const Share = lazy(() => import("./pages/Share"));

export default function App() {
  const [status, { refetch }] = createResource(() => auth.status().catch(() => null));
  const [forcedOut, setForcedOut] = createSignal(false);

  onMount(() => {
    onUnauthorized(() => setForcedOut(true));
    offline.init();
  });

  const authed = () => !forcedOut() && !!status()?.authenticated;
  const retry = async () => { await refetch(); if (status()) setOfflineMode(false); };

  return (
    <Switch fallback={<Splash />}>
      <Match when={offlineMode()}>
        <AuthedApp offline onRetry={retry} />
      </Match>
      <Match when={status.state === "ready" && status() === null}>
        <Offline onRetry={refetch} onDownloads={() => setOfflineMode(true)} />
      </Match>
      <Match when={status.state === "ready" && !authed()}>
        <PairScreen
          passwordEnabled={!!status()?.passwordEnabled}
          onPaired={async () => { setForcedOut(false); await refetch(); }}
        />
      </Match>
      <Match when={authed()}>
        <AuthedApp />
      </Match>
    </Switch>
  );
}

function AuthedApp(props: { offline?: boolean; onRetry?: () => void }): JSX.Element {
  startSocket();
  if (!props.offline) offline.resume();
  // No server: only the downloads on this device (Library), with a way back once it's reachable again.
  if (props.offline && !/^\/app\/library/.test(location.pathname)) history.replaceState(null, "", "/app/library");
  return (
    <>
    <Show when={props.offline}>
      <div class="offline-banner" role="status">
        <span>No connection to your server · showing your downloads</span>
        <button class="btn small" onClick={() => props.onRetry?.()}>Retry</button>
      </div>
    </Show>
    <Router base="/app" root={Shell}>
      <Route path="/" component={Subscriptions} />
      <Route path="/subscriptions" component={Subscriptions} />
      <Route path="/discover" component={Home} />
      <Route path="/setup" component={Setup} />
      <Route path="/search" component={Search} />
      <Route path="/library" component={Library} />
      <Route path="/channel" component={Channel} />
      <Route path="/sources" component={Sources} />
      <Route path="/settings" component={Settings} />
      <Route path="/share" component={Share} />
      <Route path="*" component={Subscriptions} />
    </Router>
    </>
  );
}

function Splash() {
  return (
    <div class="splash">
      <img src="/app/logo.svg" alt="" width="72" height="72" />
    </div>
  );
}

function Offline(props: { onRetry: () => void; onDownloads: () => void }) {
  return (
    <div class="splash">
      <div class="empty">
        <img src="/app/logo.svg" alt="" width="56" height="56" />
        <h3>Can't reach your Grayjay server</h3>
        <p>Make sure the computer running Grayjay is on, and that this device can reach it (same Wi-Fi, or Tailscale).</p>
        <button class="btn primary" onClick={props.onRetry}>Try again</button>
        <Show when={offline.items().length > 0}>
          <button class="btn" onClick={props.onDownloads}>Watch your downloads ({offline.items().length})</button>
        </Show>
      </div>
    </div>
  );
}
