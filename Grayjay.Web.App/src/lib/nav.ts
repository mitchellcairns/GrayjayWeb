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
  // Shared text often ends the link with punctuation ("…watch this: https://t.co/abc).").
  return m ? m[0].replace(/[.,;:!?)\]}"'>]+$/, "") : null;
}

/** Shorteners and redirect wrappers whose real address only the server can find out (it follows them). */
const SHORT_HOSTS = /^(t\.co|goo\.gl|g\.co|search\.app|share\.google|bit\.ly|tinyurl\.com|ow\.ly|buff\.ly|dis\.gd|is\.gd|rb\.gy|t\.ly|cutt\.ly|shorturl\.at|tiny\.cc|lnkd\.in|fb\.me|s\.id|trib\.al|dlvr\.it|ift\.tt|l\.facebook\.com|lm\.facebook\.com|l\.instagram\.com|out\.reddit\.com|href\.li)$/i;
export function isShortLink(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return SHORT_HOSTS.test(host) || (/^google\./.test(host) && u.pathname === "/url") || (/(^|\.)youtube\.com$/.test(host) && u.pathname === "/redirect");
  } catch { return false; }
}
