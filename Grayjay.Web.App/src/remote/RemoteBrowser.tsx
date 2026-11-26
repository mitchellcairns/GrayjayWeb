import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { RemoteBrowserSession, remoteBrowser } from "../api";
import Icon from "../components/Icon";
import "./RemoteBrowser.css";

interface YtAccount { index: number; name: string; handle?: string; subtitle?: string; thumbnail?: string; selected?: boolean }

/**
 * Remote login browser: a Chromium running on the Grayjay server, streamed here as JPEG frames over a WebSocket.
 * Touch/mouse input is forwarded with coordinates in the remote viewport's CSS pixels, and typing goes through a
 * hidden input so phone keyboards (including iOS autofill/password managers) work. When YouTube shows its channel
 * switcher we render a native picker instead, which is the part that's painful in a tiny remote view.
 */
export default function RemoteBrowser(props: { session: RemoteBrowserSession; onClosed: () => void }) {
  let canvas!: HTMLCanvasElement;
  let stage!: HTMLDivElement;
  let keyInput!: HTMLInputElement;
  let dialog!: HTMLDialogElement;
  let ws: WebSocket | null = null;
  const [url, setUrl] = createSignal(props.session.url);
  const [canGoBack, setCanGoBack] = createSignal(false);
  const [connected, setConnected] = createSignal(false);
  const [frameSize, setFrameSize] = createSignal({ w: props.session.width || 390, h: props.session.height || 844 });
  const [accounts, setAccounts] = createSignal<YtAccount[] | null>(null);
  const [showPage, setShowPage] = createSignal(false);
  const [gotFrame, setGotFrame] = createSignal(false);
  // The stream drops whenever the phone puts the app in the background (approving a sign-in on the phone, copying a
  // 2-step code from another app). The server keeps the session for 15 minutes, so reconnect and carry on.
  const [reconnecting, setReconnecting] = createSignal(false);
  let closedByUs = false;
  // Sign-in started on the computer running Grayjay opens a real browser window there instead of streaming.
  const headful = !!props.session.headful;

  const send = (msg: object) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  const host = () => { try { return new URL(url()).host; } catch { return url(); } };

  // Size the remote viewport to this screen so pages lay out natively.
  const sendResize = () => {
    const r = stage.getBoundingClientRect();
    if (headful || r.width < 50 || r.height < 50) return;
    send({ type: "resize", width: Math.round(r.width), height: Math.round(r.height), dpr: Math.min(3, devicePixelRatio || 2) });
  };

  onMount(() => {
    // A modal <dialog> joins the top layer above any open sheet (which are dialogs too).
    try { dialog.showModal(); } catch { }
    const img = new Image();
    let pending: string | null = null, decoding = false;
    const draw = async () => {
      if (decoding || !pending) return;
      decoding = true;
      const data = pending; pending = null;
      img.src = `data:image/jpeg;base64,${data}`;
      try { await img.decode(); } catch { }
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      }
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      setGotFrame(true);
      decoding = false;
      if (pending) draw();
    };

    let retryTimer: number | undefined, attempt = 0;
    const onMessage = (ev: MessageEvent) => {
      let m: any;
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.type) {
        case "frame":
          if (headful) break;
          if (m.width && m.height) setFrameSize({ w: m.width, h: m.height });
          pending = m.data; draw();
          break;
        case "url":
          setUrl(m.url); setCanGoBack(!!m.canGoBack);
          if (!/youtube\.com\/channel_switcher/.test(m.url)) setAccounts(null);
          break;
        case "ytAccounts":
          setAccounts(Array.isArray(m.accounts) && m.accounts.length ? m.accounts : null);
          setShowPage(false);
          break;
        case "closed":
          closedByUs = true;
          props.onClosed();
          break;
      }
    };

    const connect = () => {
      clearTimeout(retryTimer);
      if (closedByUs || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/RemoteBrowser/${encodeURIComponent(props.session.id)}/Stream`);
      ws = sock;
      sock.addEventListener("open", () => {
        attempt = 0;
        setConnected(true); setReconnecting(false);
        sendResize();
        if (!headful) keyInput?.focus({ preventScroll: true });
      });
      sock.addEventListener("message", onMessage);
      sock.addEventListener("close", () => {
        if (ws !== sock) return;
        setConnected(false);
        if (!closedByUs) scheduleReconnect();
      });
    };
    // Before reconnecting, make sure the session still exists: if it's gone, sign-in finished (or timed out) while we
    // were away, and the window should close.
    const reconnect = async () => {
      if (closedByUs) return;
      setReconnecting(true);
      try {
        const open = await remoteBrowser.sessions();
        if (!open.some((x) => x.id === props.session.id)) { closedByUs = true; props.onClosed(); return; }
      } catch { /* server unreachable right now: retry below */ }
      connect();
    };
    const scheduleReconnect = () => {
      clearTimeout(retryTimer);
      if (document.visibilityState !== "visible") return; // reconnect when the app comes back
      const delay = Math.min(5000, 400 * 2 ** attempt++);
      retryTimer = window.setTimeout(reconnect, delay);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && ws?.readyState !== WebSocket.OPEN) { attempt = 0; reconnect(); }
    };
    document.addEventListener("visibilitychange", onVisible);
    addEventListener("online", onVisible);
    connect();

    const ro = new ResizeObserver(() => sendResize());
    ro.observe(stage);
    onCleanup(() => {
      closedByUs = true;
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      removeEventListener("online", onVisible);
      ro.disconnect();
      ws?.close();
    });
  });

  // ---------- Input ----------
  const toRemote = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    const fs = frameSize();
    return { x: ((e.clientX - r.left) / r.width) * fs.w, y: ((e.clientY - r.top) / r.height) * fs.h };
  };
  const pointer = (action: "down" | "move" | "up") => (e: PointerEvent) => {
    if (action === "move" && e.buttons === 0 && e.pointerType !== "mouse") return;
    e.preventDefault();
    if (action === "down") canvas.setPointerCapture(e.pointerId);
    const { x, y } = toRemote(e);
    send({ type: "pointer", action, x, y, button: "left", pointerType: e.pointerType === "mouse" ? "mouse" : "touch" });
    // Tapping the page keeps the hidden input focused so the keyboard can appear for text fields.
    if (action === "up") keyInput.focus({ preventScroll: true });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { x, y } = toRemote(e);
    send({ type: "wheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY });
  };

  let mirror = "";
  let composing = false;
  const specialKeys = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete", "Home", "End"]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || composing) return; // the keyboard is mid-word: the input diff handles it
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return; // let the paste event carry the text
    if (specialKeys.has(e.key) || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const mods = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
      send({ type: "key", action: "down", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods });
      send({ type: "key", action: "up", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods });
    }
  };
  // Typing goes through the hidden input and is forwarded as the *difference* between what it held before and now.
  // Phone keyboards (Gboard, SwiftKey, iOS) build words up in a composition ("t", "te", "tes"…) that can't be
  // cancelled, so forwarding each event's text would type "ttetes". Diffing works for composition, autocorrect,
  // dictation, paste and password-manager autofill alike.
  const backspace = (n: number) => {
    for (let i = 0; i < n; i++) {
      send({ type: "key", action: "down", key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 });
      send({ type: "key", action: "up", key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 });
    }
  };
  const syncInput = () => {
    const now = keyInput.value;
    let p = 0;
    while (p < mirror.length && p < now.length && mirror[p] === now[p]) p++;
    backspace(mirror.length - p);
    if (now.length > p) send({ type: "text", text: now.slice(p) });
    mirror = now;
    // Outside a composition, start fresh each time so the local field never drifts from the page.
    if (!composing) { keyInput.value = ""; mirror = ""; }
  };
  const onBeforeInput = (e: InputEvent) => {
    // Backspace with nothing local to delete: there'd be no input event, so forward it directly.
    if (e.inputType === "deleteContentBackward" && keyInput.value === "") {
      e.preventDefault();
      backspace(1);
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const t = e.clipboardData?.getData("text");
    if (t) send({ type: "text", text: t });
    e.preventDefault();
  };
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; syncInput(); };

  const cancel = () => { send({ type: "close" }); closedByUs = true; props.onClosed(); };

  return (
    <Portal>
      <dialog class="rb" ref={dialog} aria-label="Sign in" onCancel={(e) => e.preventDefault()}>
        <header class="rb-bar">
          <button class="icon-btn" aria-label="Cancel sign-in" onClick={cancel}><Icon name="close" /></button>
          <div class="rb-url">
            <Icon name="lock" size={14} />
            <span>{host()}</span>
          </div>
          <button class="icon-btn" aria-label="Back" disabled={!canGoBack()} onClick={() => send({ type: "back" })}><Icon name="back" /></button>
          <button class="icon-btn" aria-label="Reload" onClick={() => send({ type: "reload" })}><Icon name="refresh" /></button>
        </header>

        <Show when={accounts() && !showPage()}>
          <div class="rb-accounts">
            <h2>Choose a channel</h2>
            <p class="muted">Pick which YouTube channel Grayjay should use for recommendations, subscriptions and history.</p>
            <div class="list">
              <For each={accounts()!}>
                {(a) => (
                  <button class="list-item" onClick={() => { send({ type: "ytSelectAccount", index: a.index }); setAccounts(null); }}>
                    <div class="avatar" style={{ width: "44px", height: "44px" }}>
                      <Show when={a.thumbnail} fallback={<span>{a.name.charAt(0)}</span>}><img src={a.thumbnail} alt="" referrerpolicy="no-referrer" /></Show>
                    </div>
                    <div class="grow">
                      <div class="title">{a.name}</div>
                      <div class="sub">{[a.handle, a.subtitle].filter(Boolean).join(" · ")}</div>
                    </div>
                    <Show when={a.selected}><span class="faint" style={{ "font-size": "12px" }}>Current</span></Show>
                    <Icon name="forward" size={18} />
                  </button>
                )}
              </For>
            </div>
            <button class="btn ghost small" onClick={() => setShowPage(true)}>Show the YouTube page instead</button>
          </div>
        </Show>

        <Show when={headful && !accounts()}>
          <div class="rb-accounts rb-headful">
            <img src="/app/logo.svg" alt="" width="56" height="56" />
            <h2>Finish signing in in the new window</h2>
            <p class="muted">
              A sign-in window for <b>{host()}</b> opened on this computer. Sign in there; this screen closes by itself when you're done.
              Your account is remembered, so next time it's just a tap.
            </p>
            <p class="faint" style={{ "font-size": "13px" }}>Can't see it? Check your taskbar for a browser window.</p>
            <button class="btn" onClick={cancel}>Cancel sign-in</button>
          </div>
        </Show>

        <div class="rb-stage" ref={stage} hidden={headful || (!!accounts() && !showPage())}>
          <canvas
            ref={canvas}
            class="rb-canvas"
            style={{ "aspect-ratio": `${frameSize().w} / ${frameSize().h}` }}
            onPointerDown={pointer("down")}
            onPointerMove={pointer("move")}
            onPointerUp={pointer("up")}
            onPointerCancel={pointer("up")}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
          <Show when={!gotFrame()}>
            <div class="rb-loading"><div class="spinner" /><p class="muted">{connected() ? "Opening sign-in page…" : "Connecting to your server…"}</p></div>
          </Show>
          <Show when={gotFrame() && !connected()}>
            <div class="rb-loading rb-reconnecting"><div class="spinner" /><p>{reconnecting() ? "Reconnecting…" : "Connection lost. Reconnecting…"}</p></div>
          </Show>
        </div>

        <input
          ref={keyInput}
          class="rb-keys"
          type="text"
          autocomplete="on"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          aria-label="Type into the page"
          onKeyDown={onKeyDown}
          onBeforeInput={onBeforeInput as any}
          onInput={syncInput}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onPaste={onPaste}
          value=""
        />
        <footer class="rb-foot faint">
          <Icon name="lock" size={12} /> This page runs on your own Grayjay server. Sign in as you normally would; Grayjay keeps only the session it needs.
        </footer>
      </dialog>
    </Portal>
  );
}
