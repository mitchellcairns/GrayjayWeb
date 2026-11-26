import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { RemoteBrowserSession, remoteBrowser } from "../api";
import { on } from "../api/socket";
import RemoteBrowser from "./RemoteBrowser";

/** Opens the remote login browser whenever the server starts a sign-in or captcha session. */
export default function RemoteBrowserHost() {
  const [session, setSession] = createSignal<RemoteBrowserSession | null>(null);

  onMount(async () => {
    try {
      const open = await remoteBrowser.sessions();
      if (open?.length) setSession(open[open.length - 1]);
    } catch { }
  });
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
