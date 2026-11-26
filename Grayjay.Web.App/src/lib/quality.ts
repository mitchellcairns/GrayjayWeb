// Default playback quality: per device, different for Wi-Fi vs mobile data / metered, with an "Auto" mode that picks a
// tier from a quick speed test against your Grayjay server (the link that actually carries the video to this device).
import { createRoot } from "solid-js";
import { stored } from "./stored";

/** "auto" = by measured speed, "same" = (metered only) same as Wi-Fi, otherwise a maximum height in pixels. */
export type QualityPref = "auto" | "same" | number;
export const QUALITY_STEPS = [2160, 1440, 1080, 720, 480, 360] as const;

export const qualityPrefs = createRoot(() => {
  const [wifi, setWifi] = stored<QualityPref>("gj.quality.wifi", 720);
  const [metered, setMetered] = stored<QualityPref>("gj.quality.metered", 480);
  const [forceMetered, setForceMetered] = stored("gj.quality.forceMetered", false);
  const [speed, setSpeed] = stored<{ mbps: number; at: number } | null>("gj.quality.speed", null);
  return { wifi, setWifi, metered, setMetered, forceMetered, setForceMetered, speed, setSpeed };
});

type Kind = "metered" | "unmetered";
/** Network Information API (Chrome/Edge/Brave on Android & desktop). Safari and Firefox don't expose it. */
export function detectedConnection(): { kind: Kind | null; label: string } {
  const c = (navigator as any).connection;
  if (!c) return { kind: null, label: "Not detectable in this browser" };
  if (c.saveData) return { kind: "metered", label: "Data Saver is on" };
  if (c.type === "cellular") return { kind: "metered", label: "Mobile data" };
  if (c.type === "wifi" || c.type === "ethernet") return { kind: "unmetered", label: c.type === "wifi" ? "Wi-Fi" : "Ethernet" };
  if (c.effectiveType && ["slow-2g", "2g", "3g"].includes(c.effectiveType)) return { kind: "metered", label: `Slow connection (${c.effectiveType})` };
  return { kind: null, label: "Connection type unknown" };
}
export function connectionKind(): Kind {
  if (qualityPrefs.forceMetered()) return "metered";
  return detectedConnection().kind ?? "unmetered";
}

/** Times downloading from the server; a second, larger sample on fast links for accuracy. Result in Mbps. */
export async function measureSpeed(): Promise<number> {
  const sample = async (bytes: number) => {
    const t0 = performance.now();
    const r = await fetch(`/web/speedtest?bytes=${bytes}&_=${Date.now()}`, { cache: "no-store", credentials: "same-origin" });
    const buf = await r.arrayBuffer();
    const secs = Math.max(0.001, (performance.now() - t0) / 1000);
    return (buf.byteLength * 8) / secs / 1e6;
  };
  let mbps = await sample(1_000_000);
  if (mbps > 15) mbps = Math.max(mbps, await sample(6_000_000));
  qualityPrefs.setSpeed({ mbps: Math.round(mbps * 10) / 10, at: Date.now() });
  return mbps;
}

/** Highest quality the measured speed sustains comfortably (YouTube-ish bitrates with headroom). */
export function tierFor(mbps: number): number {
  if (mbps >= 35) return 2160;
  if (mbps >= 18) return 1440;
  if (mbps >= 9) return 1080;
  if (mbps >= 4.5) return 720;
  if (mbps >= 2) return 480;
  return 360;
}

/** The maximum height to play at by default on this device right now. */
export async function targetHeight(): Promise<number> {
  let pref = connectionKind() === "metered" ? qualityPrefs.metered() : qualityPrefs.wifi();
  if (pref === "same") pref = qualityPrefs.wifi();
  if (pref === "same") pref = 720;
  if (pref !== "auto") return pref;
  const s = qualityPrefs.speed();
  if (s && Date.now() - s.at < 30 * 60 * 1000) return tierFor(s.mbps);
  try {
    const mbps = await Promise.race([measureSpeed(), new Promise<number>((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000))]);
    return tierFor(mbps);
  } catch {
    return 720;
  }
}

/**
 * Picks the source index to play: the highest resolution ≤ target, preferring the container/codec of the server's own
 * choice (which it already knows this browser can play). Returns the current index if nothing better fits.
 */
export function pickVideoIndex(sources: any[], currentIndex: number, target: number): number {
  const cur = sources[currentIndex];
  if (!cur) return currentIndex;
  const family = (s: any) => `${s.container ?? ""}|${String(s.codec ?? "").split(".")[0]}`;
  const sameFamily = sources.map((s, i) => ({ s, i })).filter(({ s }) => s.height && family(s) === family(cur));
  const pool = sameFamily.length ? sameFamily : sources.map((s, i) => ({ s, i })).filter(({ s }) => s.height);
  if (!pool.length) return currentIndex;
  const fitting = pool.filter(({ s }) => s.height <= target).sort((a, b) => b.s.height - a.s.height || (b.s.fps ?? 0) - (a.s.fps ?? 0));
  if (fitting.length) return fitting[0].i;
  return pool.sort((a, b) => a.s.height - b.s.height)[0].i; // nothing that small: use the smallest available
}
