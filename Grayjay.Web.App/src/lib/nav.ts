export const channelHref = (url?: string) => (url ? `/channel?url=${encodeURIComponent(url)}` : "#");
export const searchHref = (query: string) => `/search?q=${encodeURIComponent(query)}`;

/** Wraps state-changing DOM updates in a View Transition where supported (Chrome/Edge/Safari 18+). */
export function withTransition(fn: () => void) {
  const d = document as any;
  if (d.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) d.startViewTransition(fn);
  else fn();
}

export function isProbablyUrl(text: string) {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

export function extractUrl(text?: string | null): string | null {
  const m = text?.match(/https?:\/\/\S+/i);
  return m ? m[0] : null;
}
