import { JSX, Match, Switch, createResource, createSignal, lazy, onMount } from "solid-js";
import { Route, Router } from "@solidjs/router";
import { auth } from "./api";
import { onUnauthorized } from "./api/client";
import { startSocket } from "./api/socket";
import Shell from "./shell/Shell";
import PairScreen from "./pages/Pair";
import Home from "./pages/Home";

const Subscriptions = lazy(() => import("./pages/Subscriptions"));
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
  });

  const authed = () => !forcedOut() && !!status()?.authenticated;

  return (
    <Switch fallback={<Splash />}>
      <Match when={status.state === "ready" && status() === null}>
        <Offline onRetry={refetch} />
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

function AuthedApp(): JSX.Element {
  startSocket();
  return (
    <Router base="/app" root={Shell}>
      <Route path="/" component={Home} />
      <Route path="/subscriptions" component={Subscriptions} />
      <Route path="/search" component={Search} />
      <Route path="/library" component={Library} />
      <Route path="/channel" component={Channel} />
      <Route path="/sources" component={Sources} />
      <Route path="/settings" component={Settings} />
      <Route path="/share" component={Share} />
      <Route path="*" component={Home} />
    </Router>
  );
}

function Splash() {
  return (
    <div class="splash">
      <img src="/app/logo.svg" alt="" width="72" height="72" />
    </div>
  );
}

function Offline(props: { onRetry: () => void }) {
  return (
    <div class="splash">
      <div class="empty">
        <img src="/app/logo.svg" alt="" width="56" height="56" />
        <h3>Can't reach your Grayjay server</h3>
        <p>Make sure the computer running Grayjay is on, and that this device can reach it (same Wi-Fi, or Tailscale).</p>
        <button class="btn primary" onClick={props.onRetry}>Try again</button>
      </div>
    </div>
  );
}
