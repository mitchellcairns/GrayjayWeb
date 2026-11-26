// Feed look: card size and what the preview image shows. Per device (a phone and a TV want different densities).
import { createRoot } from "solid-js";
import { stored } from "./stored";

export type Density = "compact" | "large" | "list";
/** "frames": stills from inside the video (YouTube's auto-generated frames); "thumbnails": the creator's chosen image. */
export type PreviewStyle = "frames" | "thumbnails";

export const display = createRoot(() => {
  const [density, setDensity] = stored<Density>("gj.feed.density", "compact");
  const [preview, setPreview] = stored<PreviewStyle>("gj.feed.preview", "frames");
  return { density, setDensity, preview, setPreview };
});

const YT_ID = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([\w-]{11})/;
export function youtubeId(url?: string): string | null {
  return url?.match(YT_ID)?.[1] ?? null;
}

/**
 * Frames YouTube generates at roughly 25%, 50% and 75% of the video (480×360 with the 16:9 picture letterboxed, so
 * object-fit: cover crops exactly the bars). Not available for other sources: callers fall back to the thumbnail.
 */
export function frameUrls(url?: string): string[] | null {
  const id = youtubeId(url);
  return id ? [2, 1, 3].map((n) => `https://i.ytimg.com/vi/${id}/hq${n}.jpg`) : null;
}
