import { JSX, Show, createSignal, onCleanup, onMount } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import Icon from "../components/Icon";
import { QueueButton } from "../components/GlobalSheets";

/**
 * Translucent top bar. iOS standalone PWAs have no browser chrome or back gesture, so pages deeper than a tab
 * always get an explicit back button.
 */
export default function PageHeader(props: { title?: JSX.Element; back?: boolean; actions?: JSX.Element; children?: JSX.Element; logo?: boolean }) {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = createSignal(false);
  const onScroll = () => setScrolled(scrollY > 4);
  onMount(() => { addEventListener("scroll", onScroll, { passive: true }); onScroll(); });
  onCleanup(() => removeEventListener("scroll", onScroll));

  const goBack = () => (history.length > 1 ? history.back() : navigate("/"));

  return (
    <header class="topbar" classList={{ scrolled: scrolled() }}>
      <Show when={props.back}>
        <button class="icon-btn" aria-label="Back" onClick={goBack}><Icon name="back" /></button>
      </Show>
      <Show when={props.logo}>
        <A href="/" class="topbar-logo" aria-label="Grayjay home"><img src="/app/logo.svg" alt="" width="26" height="26" /><span>Grayjay</span></A>
      </Show>
      <Show when={props.title}>
        <div class="topbar-title">{props.title}</div>
      </Show>
      {props.children}
      <div class="spacer" />
      <QueueButton />
      {props.actions}
    </header>
  );
}
