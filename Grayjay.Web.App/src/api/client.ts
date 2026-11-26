// HTTP client for the Grayjay server API. All calls are same-origin and carry the session cookie automatically.

/** Each tab/PWA window gets its own backend "window state" (pagers, current video). Survives reloads. */
export const WindowID: string = (() => {
  const key = "gj.windowId";
  let id = sessionStorage.getItem(key);
  if (!id) {
    // crypto.randomUUID only exists in secure contexts (HTTPS/localhost); plain-HTTP LAN addresses need this fallback.
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
})();

export class ApiError extends Error {
  status: number;
  title?: string;
  pluginName?: string;
  details?: string;
  canRetry?: boolean;
  constructor(message: string, status: number, extra?: Partial<ApiError>) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
export function onUnauthorized(l: UnauthorizedListener) {
  unauthorizedListeners.add(l);
  return () => unauthorizedListeners.delete(l);
}

async function handle(resp: Response): Promise<any> {
  if (resp.status === 401) {
    let body: any = null;
    try { body = await resp.json(); } catch { }
    // Only a missing/expired session signs the app out; a rejected pairing code or password just shows its message.
    if (!body?.error || body.error === "unauthorized") {
      unauthorizedListeners.forEach((l) => l());
      throw new ApiError("Not signed in to this server", 401);
    }
    throw new ApiError(body.error, 401);
  }
  if (resp.status === 550) {
    // Grayjay "exception model": plugin/script errors with a human-readable message.
    let model: any = {};
    try { model = await resp.json(); } catch { }
    throw new ApiError(model.message || model.title || "Something went wrong", 550, {
      title: model.title, pluginName: model.pluginName, details: model.stacktrace ?? model.code, canRetry: model.canRetry,
    });
  }
  if (!resp.ok) {
    let text = "";
    try { text = await resp.text(); } catch { }
    let message = text;
    try { const j = JSON.parse(text); message = j.error || j.message || j.title || text; } catch { }
    throw new ApiError(prettifyError(message) || `Request failed (${resp.status})`, resp.status);
  }
  const type = resp.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return resp.json();
  const text = await resp.text();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

function prettifyError(message: string): string {
  // ASP.NET developer exception pages / stack traces aren't useful to people.
  const first = message.split("\n")[0].trim();
  return first.replace(/^System\.[A-Za-z.]+Exception:\s*/, "").slice(0, 300);
}

function headers(extra?: Record<string, string>): HeadersInit {
  return { WindowID, ...extra };
}

export async function get<T = any>(url: string, signal?: AbortSignal): Promise<T> {
  return handle(await fetch(url, { headers: headers(), credentials: "same-origin", signal }));
}

export async function post<T = any>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return handle(await fetch(url, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    signal,
  }));
}

export async function del<T = any>(url: string): Promise<T> {
  return handle(await fetch(url, { method: "DELETE", headers: headers(), credentials: "same-origin" }));
}

export const q = encodeURIComponent;
