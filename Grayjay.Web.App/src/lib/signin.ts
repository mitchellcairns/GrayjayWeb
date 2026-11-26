import { remoteBrowser, sources } from "../api";
import { on } from "../api/socket";

/** YouTube's channel/brand-account switcher. Opening sign-in here with a remembered Google account shows the channel picker. */
export const YOUTUBE_CHANNEL_SWITCHER = "https://www.youtube.com/channel_switcher";

export const isYouTube = (name?: string) => /youtube/i.test(name ?? "");

/**
 * Starts a source sign-in and resolves once it has actually finished. The server's SourceLogin call returns as soon as
 * the sign-in browser opens; the result is only saved when that browser closes. So: wait for RemoteBrowserClosed,
 * then re-read the source to see whether it's now signed in.
 */
export async function signInAndWait(id: string, startUrl?: string): Promise<boolean> {
  let off: (() => void) | undefined;
  let poll: number | undefined;
  const closed = new Promise<void>((resolve) => {
    off = on("RemoteBrowserClosed", () => resolve());
    // The live "closed" notice is missed if the phone had the app in the background when sign-in finished (e.g.
    // while approving it on the phone), so also check now and then whether any sign-in window is still open.
    let seenOpen = false;
    poll = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const open = await remoteBrowser.sessions().catch(() => null);
      if (!open) return;
      if (open.length) seenOpen = true;
      else if (seenOpen) resolve();
    }, 3000);
  });
  try {
    await sources.login(id, startUrl);
    await Promise.race([closed, new Promise((r) => setTimeout(r, 30 * 60 * 1000))]);
  } finally {
    off?.();
    clearInterval(poll);
  }
  // The server saves the session right after the browser closes; give it a moment.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const d = await sources.details(id).catch(() => null);
    if (d?.hasLoggedIn) return true;
  }
  return false;
}
