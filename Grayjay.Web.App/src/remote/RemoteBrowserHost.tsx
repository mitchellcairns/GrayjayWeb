import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { RemoteBrowserSession, remoteBrowser } from "../api";
import { on } from "../api/socket";
import RemoteBrowser from "./RemoteBrowser";

/** Opens the remote login browser whenever the server starts a sign-in or captcha session. */
export default function RemoteBrowserHost() {
  const [session, setSession] = createSignal<RemoteBrowserSession | null>(null);

  // Show any sign-in window the server has open (also after coming back from the background, when the live
  // "opened"/"closed" notices may have been missed).
  const sync = async () => {
    try {
      const open = await remoteBrowser.sessions();
      const cur = session();
      if (cur && !open.some((x) => x.id === cur.id)) setSession(null);
      else if (!cur && open?.length) setSession(open[open.length - 1]);
    } catch { }
  };
  onMount(sync);
  const onVisible = () => { if (document.visibilityState === "visible") sync(); };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisible));
  const offs = [
    on<RemoteBrowserSession>("RemoteBrowserOpened", (p) => setSession(p.payload)),
    on<{ id: string }>("RemoteBrowserClosed", (p) => { if (session()?.id === p.payload?.id) setSession(null); }),
  ];
  onCleanup(() => offs.forEach((o) => o()));

  return (
    <Show when={session()} keyed>
      {(s) => <RemoteBrowser session={s} onClosed={() => setSession(null)} />}
    </Show>
  );
}
