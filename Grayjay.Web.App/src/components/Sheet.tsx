import { JSX, Show, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import Icon from "./Icon";
import "./Sheet.css";

/**
 * Bottom sheet on phones, centered dialog on wide screens. Built on the native <dialog> element
 * (focus trapping, Esc, top layer) with drag-to-dismiss on touch.
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

  createEffect(() => {
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    else if (!props.open && dialog.open) dialog.close();
  });

  const dismissible = () => props.dismissible !== false;

  // Drag down from the grabber/header to dismiss.
  let startY = 0, dy = 0, dragging = false;
  const onPointerDown = (e: PointerEvent) => {
    if (!dismissible() || e.pointerType === "mouse") return;
    dragging = true; startY = e.clientY; dy = 0;
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
    panel.style.transition = "";
    panel.style.transform = "";
    if (dy > 110) props.onClose();
  };

  onCleanup(() => { if (dialog?.open) dialog.close(); });

  return (
    <Portal>
      <dialog
        ref={dialog}
        class={`sheet sheet-${props.size ?? "auto"}`}
        onCancel={(e) => { e.preventDefault(); if (dismissible()) props.onClose(); }}
        onClick={(e) => { if (e.target === dialog && dismissible()) props.onClose(); }}
      >
        <div class="sheet-panel" ref={panel}>
          <div class="sheet-head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <div class="sheet-grabber" />
            <Show when={props.title || dismissible()}>
              <div class="sheet-titlebar">
                <h2 class="sheet-title">{props.title}</h2>
                <Show when={dismissible()}>
                  <button class="icon-btn" onClick={() => props.onClose()} aria-label="Close"><Icon name="close" /></button>
                </Show>
              </div>
            </Show>
          </div>
          <div class={`sheet-body ${props.noPadding ? "no-pad" : ""}`}>
            <Show when={props.open}>{props.children}</Show>
          </div>
        </div>
      </dialog>
    </Portal>
  );
}
