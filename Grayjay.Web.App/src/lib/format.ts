import type { Thumbnails } from "../api";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatCount(n?: number | null): string {
  if (n == null || n < 0 || !isFinite(n)) return "";
  return compact.format(n);
}

export function formatViews(n?: number | null): string {
  if (n == null || n < 0) return "";
  return `${formatCount(n)} view${n === 1 ? "" : "s"}`;
}

export function formatDuration(seconds?: number | null): string {
  if (seconds == null || seconds <= 0 || !isFinite(seconds)) return "";
  const s = Math.floor(seconds % 60), m = Math.floor((seconds / 60) % 60), h = Math.floor(seconds / 3600);
  const pad = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Grayjay dates arrive as unix seconds (or ISO strings from some endpoints). */
export function toDate(value?: number | string | null): Date | null {
  if (value == null) return null;
  const d = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  const t = d.getTime();
  if (!isFinite(t) || d.getUTCFullYear() < 1980) return null;
  return d;
}

export function formatAgo(value?: number | string | null): string {
  const d = toDate(value);
  if (!d) return "";
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  for (const [unit, secs] of units) if (abs >= secs) return rtf.format(Math.round(diff / secs), unit);
  return "just now";
}

export function bestThumbnail(t?: Thumbnails | null, minWidth = 480): string | undefined {
  const sources = t?.sources?.filter((s) => s?.url) ?? [];
  if (!sources.length) return undefined;
  const sorted = [...sources].sort((a, b) => a.quality - b.quality);
  return (sorted.find((s) => s.quality >= minWidth) ?? sorted[sorted.length - 1]).url;
}

export function joinDot(...parts: (string | undefined | null | false)[]): string {
  return parts.filter(Boolean).join(" · ");
}

export function hostOf(url?: string): string {
  try { return url ? new URL(url).host.replace(/^www\./, "") : ""; } catch { return ""; }
}
