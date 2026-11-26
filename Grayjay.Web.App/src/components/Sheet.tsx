import { JSX, Show, createEffect, createSignal, onCleanup } from "solid-js";
import Icon from "./Icon";
import "./Sheet.css";

const CLOSE_MS = 220;
const CLOSE_MS_WIDE = 160;

/**
 * Bottom sheet on phones, centered dialog on wide screens. Built on the native <dialog> element
 * (focus trapping, Esc / Android back, top layer) with drag-to-dismiss on touch.
 *
 * It slides out when closed (or unmounted) instead of vanishing: the content stays as it was until the panel is off
 * screen. The dialog is added to <body> by hand rather than through <Portal> so it can outlive the component for that.
 */
export default function Sheet(props: {
  open: boolean;
  onClose: () => void;
  title?: JSX.Element;
  children: JSX.Element;
  size?: "auto" | "tall" | "full";
  noPadding?: boolean;
  dismissible?: boolean;
}) {
  let dialog!: HTMLDialogElement;
  let panel!: HTMLDivElement;
  const [shown, setShown] = createSignal(false);
  let closing = false;
  let closeTimer = 0;
  let disposed = false;

  const dismissible = () => props.dismissible !== false;
  const wide = () => matchMedia("(min-width: 700px)").matches;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const resetPanel = () => { panel.style.transition = ""; panel.style.transform = ""; panel.style.opacity = ""; };

  const openNow = () => {
    if (closing) { // reopened while sliding out: carry on from where it is
      clearTimeout(closeTimer); closing = false; after = undefined;
      panel.removeEventListener("transitionend", onEnd);
      dialog.classList.remove("closing");
      resetPanel();
    }
    setShown(true);
    if (!dialog.open) {
      dialog.showModal();
      // showModal focuses the first button and scrolls it into view, but the panel is still below the screen at that
      // moment (it slides in), so the browser dragged the whole sheet up. Undo that and focus the panel itself.
      dialog.scrollTop = 0;
      panel.focus({ preventScroll: true });
    }
  };

  const finish = (then?: () => void) => {
    clearTimeout(closeTimer);
    panel.removeEventListener("transitionend", onEnd);
    closing = false;
    dialog.classList.remove("closing");
    if (dialog.open) dialog.close();
    resetPanel();
    if (!disposed) setShown(false);
    then?.();
  };
  let after: (() => void) | undefined;
  const onEnd = (e: TransitionEvent) => { if (e.target === panel && e.propertyName === "transform") finish(after); };

  const closeAnimated = (then?: () => void) => {
    if (!dialog.open) { if (!disposed) setShown(false); then?.(); return; }
    if (closing) { if (then) after = then; return; }
    if (reduced()) { finish(then); return; }
    closing = true; after = then;
    const isWide = wide();
    // Start from wherever the panel is now: mid-drag, or still sliding in.
    const from = getComputedStyle(panel).transform;
    panel.getAnimations().forEach((a) => a.cancel());
    panel.style.transition = "none";
    panel.style.transform = from === "none" ? "" : from;
    void panel.offsetHeight;
    dialog.classList.add("closing");
    const ms = isWide ? CLOSE_MS_WIDE : CLOSE_MS;
    panel.style.transition = `transform ${ms}ms cubic-bezier(0.4, 0, 1, 1), opacity ${ms}ms linear`;
    if (isWide) { panel.style.transform = "scale(0.96)"; panel.style.opacity = "0"; }
    else panel.style.transform = "translateY(100%)";
    panel.addEventListener("transitionend", onEnd);
    closeTimer = window.setTimeout(() => finish(after), ms + 80);
  };

  createEffect(() => { if (props.open) openNow(); else closeAnimated(); });

  // Content that loads after opening makes the panel taller in one frame (its top jumps up). Slide the extra height in
  // instead. Added on top of whatever else is moving it, so it also works mid slide-in. Phones only: a centred dialog
  // grows both ways.
  let lastH = 0;
  const ro = new ResizeObserver(() => {
    const h = panel.offsetHeight;
    const grew = h - lastH;
    const was = lastH;
    lastH = h;
    if (!was || grew < 8 || !dialog.open || closing || dragging || wide() || reduced()) return;
    panel.animate([{ transform: `translateY(${grew}px)` }, { transform: "translateY(0)" }],
      { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", composite: "add" });
  });

  // Drag down from the grabber/header to dismiss.
  let startY = 0, dy = 0, dragging = false;
  const onPointerDown = (e: PointerEvent) => {
    if (!dismissible() || e.pointerType === "mouse" || closing) return;
    dragging = true; startY = e.clientY; dy = 0;
    panel.getAnimations().forEach((a) => a.finish());
    panel.style.transition = "none";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - startY);
    panel.style.transform = `translateY(${dy}px)`;
  };
  const onPointerUp = () => {
    if (!dragging) return;
    dragging = false;
    if (dy > 110) {
      props.onClose(); // slides out from here
      if (!closing) resetPanel(); // the owner kept it open
      return;
    }
    resetPanel(); // springs back (the CSS transition)
  };

  const el = (
    <dialog
      ref={dialog}
      class={`sheet sheet-${props.size ?? "auto"}`}
      onCancel={(e) => { e.preventDefault(); if (dismissible() && !closing) props.onClose(); }}
      onClick={(e) => { if (e.target === dialog && dismissible() && !closing) props.onClose(); }}
    >
      <div class="sheet-panel" ref={panel} tabindex="-1">
        <div class="sheet-head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div class="sheet-grabber" />
          <Show when={props.title || dismissible()}>
            <div class="sheet-titlebar">
              <h2 class="sheet-title">{props.title}</h2>
              <Show when={dismissible()}>
                <button class="icon-btn" onClick={() => { if (!closing) props.onClose(); }} aria-label="Close"><Icon name="close" /></button>
              </Show>
            </div>
          </Show>
        </div>
        <div class={`sheet-body ${props.noPadding ? "no-pad" : ""}`}>
          <Show when={shown()}>{props.children}</Show>
        </div>
      </div>
    </dialog>
  ) as HTMLDialogElement;
  document.body.appendChild(el);
  ro.observe(panel);

  onCleanup(() => {
    disposed = true;
    ro.disconnect();
    // Unmounted while open (e.g. a server dialog that finished): slide out with its last content, then remove it.
    if (dialog.open) closeAnimated(() => el.remove());
    else { clearTimeout(closeTimer); el.remove(); }
  });

  return null;
}
