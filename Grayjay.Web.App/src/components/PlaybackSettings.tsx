import { For, Show, createSignal } from "solid-js";
import { QUALITY_STEPS, QualityPref, detectedConnection, measureSpeed, qualityPrefs, tierFor } from "../lib/quality";
import { formatAgo } from "../lib/format";
import Icon from "./Icon";
import { toastError } from "./Toasts";

function QualitySelect(props: { value: QualityPref; onChange: (v: QualityPref) => void; allowSame?: boolean }) {
  return (
    <select class="settings-select" value={String(props.value)} onChange={(e) => {
      const v = e.currentTarget.value;
      props.onChange(v === "auto" || v === "same" ? v : Number(v));
    }}>
      <Show when={props.allowSame}><option value="same">Same as Wi-Fi</option></Show>
      <option value="auto">Auto (speed test)</option>
      <For each={QUALITY_STEPS}>{(h) => <option value={String(h)}>{h}p{h === 720 ? " (default)" : ""}</option>}</For>
    </select>
  );
}

/** Settings → Playback quality. Stored per device, since a phone and a TV want different things. */
export default function PlaybackSettings() {
  const [testing, setTesting] = createSignal(false);
  const conn = detectedConnection();
  const test = async () => {
    setTesting(true);
    try { await measureSpeed(); } catch (e) { toastError(e); } finally { setTesting(false); }
  };
  const usesAuto = () => qualityPrefs.wifi() === "auto" || qualityPrefs.metered() === "auto";

  return (
    <div class="list playback-settings">
      <label class="list-item">
        <Icon name="wifi" />
        <div class="grow"><div class="title">On Wi-Fi</div><div class="sub wrap">Default quality for new videos</div></div>
        <QualitySelect value={qualityPrefs.wifi()} onChange={qualityPrefs.setWifi} />
      </label>
      <label class="list-item">
        <Icon name="phone" />
        <div class="grow"><div class="title">On mobile data or metered</div><div class="sub wrap">Used when this device reports a cellular or Data Saver connection</div></div>
        <QualitySelect value={qualityPrefs.metered()} onChange={qualityPrefs.setMetered} allowSame />
      </label>
      <label class="list-item" style={{ cursor: "pointer" }}>
        <Icon name="gauge" />
        <div class="grow">
          <div class="title">Treat this device as metered</div>
          <div class="sub wrap">Detected: {conn.label}.{conn.kind === null ? " Turn this on when you're on mobile data (e.g. on iPhone)." : ""}</div>
        </div>
        <span class="switch"><input type="checkbox" checked={qualityPrefs.forceMetered()} onChange={(e) => qualityPrefs.setForceMetered(e.currentTarget.checked)} /><span /></span>
      </label>
      <div class="list-item">
        <Icon name="refresh" />
        <div class="grow">
          <div class="title">Speed to your server</div>
          <div class="sub wrap">
            <Show when={qualityPrefs.speed()} fallback={usesAuto() ? "Not measured yet — runs automatically when Auto needs it." : "Used by Auto quality."}>
              {qualityPrefs.speed()!.mbps} Mbps · up to {tierFor(qualityPrefs.speed()!.mbps)}p · {formatAgo(qualityPrefs.speed()!.at / 1000)}
            </Show>
          </div>
        </div>
        <button class="btn small" onClick={test} disabled={testing()}>{testing() ? "Testing…" : "Test now"}</button>
      </div>
    </div>
  );
}
