// [GrayjayWeb] Downloads kept on this device, so they play with no connection to the server (or no internet at all).
//
// How a download works: the server downloads the video with Grayjay's own downloader and joins video + audio into one
// ordinary file (/web/downloads/*), then this device copies that file into IndexedDB. IndexedDB works on plain-HTTP LAN
// addresses too (the Cache API and OPFS need HTTPS). Playback uses a blob: URL of the stored file.
import { createRoot, createSignal } from "solid-js";
import type { Content, VideoDetails } from "../api";
import { get, post, q } from "../api/client";
import { on } from "../api/socket";

export interface ServerDownload {
  url: string;
  state: "queued" | "preparing" | "downloading" | "processing" | "ready" | "error";
  progress: number;
  error?: string;
  name?: string;
  author?: string;
  authorUrl?: string;
  authorThumbnail?: string;
  thumbnail?: string;
  duration: number;
  dateTime?: number;
  height: number;
  audioOnly: boolean;
  size?: number;
}

export interface OfflineItem {
  /** The address the server knows it by. */
  url: string;
  /** Other addresses that mean the same video (the link it was downloaded from, if different). */
  aliases: string[];
  name: string;
  author?: { name?: string; url?: string; thumbnail?: string };
  duration: number;
  dateTime?: number;
  height: number;
  audioOnly: boolean;
  mime: string;
  size: number;
  savedAt: number;
  hasThumb: boolean;
  /** Where you stopped (seconds), kept here too so resuming works offline. */
  position?: number;
}

export type JobPhase = "server" | "device";
export interface Job { url: string; name: string; phase: JobPhase; progress: number; detail?: string; error?: string }

export const downloadsApi = {
  list: () => get<ServerDownload[]>("/web/downloads/List"),
  status: (url: string) => get<ServerDownload>(`/web/downloads/Status?url=${q(url)}`),
  start: (url: string, height: number) => post<ServerDownload>(`/web/downloads/Start?url=${q(url)}&height=${height}`),
  remove: (url: string) => post(`/web/downloads/Remove?url=${q(url)}`),
};

// ---------- IndexedDB ----------

const DB_NAME = "gj-offline";
let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("This browser can't store downloads")); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("items", { keyPath: "url" });
      d.createObjectStore("files");
      d.createObjectStore("thumbs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error ?? new Error("Couldn't open this device's download storage")); };
  });
  return dbPromise;
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Storage error"));
    tx.onabort = () => reject(tx.error ?? new Error("Not enough storage space on this device"));
  });
}
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

// ---------- Store ----------

const PENDING_KEY = "gj.offline.pending";
interface Pending { url: string; height: number; name: string }
const readPending = (): Pending[] => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); } catch { return []; } };
const writePending = (p: Pending[]) => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { } };

const CHUNK_FLUSH = 8 * 1024 * 1024;

function createOffline() {
  const [items, setItems] = createSignal<OfflineItem[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [jobs, setJobs] = createSignal<Job[]>([]);
  const running = new Set<string>();
  const wake = new Map<string, () => void>();

  const byUrl = (url?: string | null) => {
    if (!url) return undefined;
    return items().find((i) => i.url === url || i.aliases.includes(url));
  };
  const job = (url?: string | null) => (url ? jobs().find((j) => j.url === url) : undefined);
  const setJob = (url: string, patch: Partial<Job>) =>
    setJobs((js) => js.map((j) => (j.url === url ? { ...j, ...patch } : j)));
  const dropJob = (url: string) => setJobs((js) => js.filter((j) => j.url !== url));

  async function refresh() {
    try {
      const d = await db();
      const all = await request<OfflineItem[]>(d.transaction("items").objectStore("items").getAll());
      setItems(all.sort((a, b) => b.savedAt - a.savedAt));
    } catch { /* no storage: nothing downloaded */ }
    setLoaded(true);
  }

  // Server progress arrives over the WebSocket; polling covers a missed message (or no socket).
  on("DownloadChanged", () => wake.forEach((w) => w()));
  on("DownloadCompleted", () => wake.forEach((w) => w()));
  const sleep = (url: string, ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(() => { wake.delete(url); resolve(); }, ms);
    wake.set(url, () => { clearTimeout(t); wake.delete(url); resolve(); });
  });

  async function fetchFile(url: string, onProgress: (received: number, total: number) => void): Promise<{ blob: Blob; mime: string }> {
    const parts: Blob[] = [];
    let chunks: Uint8Array[] = [], pending = 0, received = 0, total = 0, mime = "video/mp4";
    // A dropped connection (the phone locking, Wi-Fi switching) carries on from where it stopped.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`/web/downloads/File?url=${q(url)}`, {
          credentials: "same-origin",
          headers: received > 0 ? { Range: `bytes=${received}-` } : {},
        });
        if (!res.ok) {
          let msg = `Couldn't copy the file (${res.status})`;
          try { const j = await res.json(); msg = j.detail || j.error || j.title || msg; } catch { }
          throw Object.assign(new Error(msg), { fatal: res.status < 500 });
        }
        if (received > 0 && res.status !== 206) { parts.length = 0; chunks = []; pending = 0; received = 0; } // no resume: start over
        mime = res.headers.get("content-type")?.split(";")[0] || mime;
        const range = res.headers.get("content-range")?.match(/\/(\d+)$/);
        total = range ? +range[1] : (+(res.headers.get("content-length") ?? 0) || total);
        const reader = res.body!.getReader();
        for (; ;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          chunks.push(value); pending += value.byteLength; received += value.byteLength;
          // Hand big pieces to the browser's blob storage (spills to disk) instead of keeping them in memory.
          if (pending >= CHUNK_FLUSH) { parts.push(new Blob(chunks as BlobPart[])); chunks = []; pending = 0; }
          onProgress(received, total);
        }
        if (total && received < total) throw new Error("The connection dropped");
        if (chunks.length) parts.push(new Blob(chunks as BlobPart[]));
        return { blob: new Blob(parts, { type: mime }), mime };
      } catch (e: any) {
        if (e?.fatal || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }

  async function run(p: Pending) {
    if (running.has(p.url)) return;
    running.add(p.url);
    let url = p.url;
    try {
      setJobs((js) => [...js.filter((j) => j.url !== p.url), { url: p.url, name: p.name, phase: "server", progress: 0, detail: "Starting" }]);
      let s = await downloadsApi.start(p.url, p.height);
      // The server may know it by another address (e.g. a short link): track it under that one.
      if (s.url && s.url !== url) {
        const from = url; url = s.url;
        setJobs((js) => js.map((j) => (j.url === from ? { ...j, url } : j)));
        writePending(readPending().map((x) => (x.url === from ? { ...x, url } : x)));
      }
      if (s.name) setJob(url, { name: s.name });
      let retries = 0;
      while (s.state !== "ready") {
        if (s.state === "error") {
          // Sources sometimes drop the connection mid-download: try again a couple of times before giving up.
          if (retries >= 2) throw new Error(s.error || "The server couldn't download it");
          retries++;
          setJob(url, { phase: "server", progress: 0, detail: `The download was interrupted; trying again (${retries} of 2)` });
          await new Promise((r) => setTimeout(r, 3000 * retries));
          s = await downloadsApi.start(url, p.height);
          continue;
        }
        setJob(url, {
          phase: "server", progress: s.progress,
          detail: s.state === "downloading" ? "Downloading on your server" : s.state === "processing" ? "Finishing on your server" : "Waiting on your server",
        });
        await sleep(url, 1500);
        s = await downloadsApi.status(url);
      }

      if (navigator.storage?.estimate && s.size) {
        const { quota = 0, usage = 0 } = await navigator.storage.estimate();
        if (quota && s.size > quota - usage) throw Object.assign(new Error("Not enough storage space on this device"), { keepServer: true });
      }
      navigator.storage?.persist?.().catch(() => { });

      setJob(url, { phase: "device", progress: 0, detail: "Saving to this device" });
      const { blob, mime } = await fetchFile(url, (rec, tot) => setJob(url, { progress: tot ? rec / tot : 0 }));
      let thumb: Blob | null = null;
      try {
        const r = await fetch(`/web/downloads/Thumbnail?url=${q(url)}`, { credentials: "same-origin" });
        if (r.ok) thumb = await r.blob();
      } catch { }

      const item: OfflineItem = {
        url, aliases: url === p.url ? [] : [p.url],
        name: s.name || p.name, duration: s.duration, dateTime: s.dateTime, height: s.height, audioOnly: s.audioOnly,
        author: { name: s.author, url: s.authorUrl, thumbnail: s.authorThumbnail },
        mime, size: blob.size, savedAt: Date.now(), hasThumb: !!thumb,
      };
      const d = await db();
      const tx = d.transaction(["items", "files", "thumbs"], "readwrite");
      tx.objectStore("files").put(blob, url);
      if (thumb) tx.objectStore("thumbs").put(thumb, url);
      tx.objectStore("items").put(item);
      await done(tx);
      await refresh();
      writePending(readPending().filter((x) => x.url !== p.url && x.url !== url));
      dropJob(url);
      return item;
    } catch (e: any) {
      // No connection (fetch itself failed): the server carries on, so pick it up again next time the app opens.
      const network = e instanceof TypeError;
      if (!network) writePending(readPending().filter((x) => x.url !== p.url && x.url !== url));
      setJob(url, { error: network ? "Lost the connection to your server. It carries on; this continues when you reopen the app." : e?.message ?? "Download failed" });
      throw e;
    } finally {
      running.delete(p.url);
      running.delete(url);
    }
  }

  return {
    items, loaded, jobs, job,
    /** The downloaded copy of this video, if there is one. */
    get: byUrl,
    has: (url?: string | null) => !!byUrl(url),
    busy: (url?: string | null) => { const j = job(url); return !!j && !j.error; },

    /** Loads what's stored on this device (works with no server). */
    init: () => refresh(),

    /** Downloads that were still going when the app closed (the server kept going): pick them up. Needs the server. */
    async resume() {
      await refresh();
      for (const p of readPending()) if (!byUrl(p.url)) run(p).catch(() => { });
    },

    /** Download a video to this device (the server downloads it first). Resolves once it's stored here. */
    download(content: Pick<Content, "url" | "name">, height: number) {
      const p: Pending = { url: content.url, height, name: content.name };
      writePending([...readPending().filter((x) => x.url !== p.url), p]);
      return run(p);
    },

    /** Something already downloaded on the server (e.g. from another device): copy it here. */
    copyFromServer(s: ServerDownload) {
      return this.download({ url: s.url, name: s.name ?? "" }, s.height || 720);
    },

    dismiss(url: string) { dropJob(url); },

    async remove(url: string, alsoServer = true) {
      const it = byUrl(url);
      const key = it?.url ?? url;
      const d = await db();
      const tx = d.transaction(["items", "files", "thumbs"], "readwrite");
      tx.objectStore("items").delete(key);
      tx.objectStore("files").delete(key);
      tx.objectStore("thumbs").delete(key);
      await done(tx);
      dropJob(key);
      await refresh();
      if (alsoServer) await downloadsApi.remove(key).catch(() => { });
    },

    /** A playable blob: URL for the stored file. Revoke it when done. */
    async fileUrl(url: string): Promise<{ src: string; mime: string } | null> {
      const it = byUrl(url);
      if (!it) return null;
      const d = await db();
      const blob = await request<Blob | undefined>(d.transaction("files").objectStore("files").get(it.url));
      if (!blob) return null;
      return { src: URL.createObjectURL(blob), mime: it.mime || blob.type || "video/mp4" };
    },

    async thumbUrl(url: string): Promise<string | undefined> {
      const it = byUrl(url);
      if (!it?.hasThumb) return undefined;
      try {
        const d = await db();
        const blob = await request<Blob | undefined>(d.transaction("thumbs").objectStore("thumbs").get(it.url));
        return blob ? URL.createObjectURL(blob) : undefined;
      } catch { return undefined; }
    },

    async setPosition(url: string, seconds: number) {
      const it = byUrl(url);
      if (!it || !isFinite(seconds)) return;
      try {
        const d = await db();
        const tx = d.transaction("items", "readwrite");
        tx.objectStore("items").put({ ...it, position: Math.floor(seconds) });
        await done(tx);
        setItems((all) => all.map((x) => (x.url === it.url ? { ...x, position: Math.floor(seconds) } : x)));
      } catch { }
    },

    async usage(): Promise<{ used: number; quota?: number }> {
      const used = items().reduce((n, i) => n + (i.size || 0), 0);
      try { const e = await navigator.storage?.estimate?.(); return { used, quota: e?.quota }; } catch { return { used }; }
    },

    /** Enough of the details for the player to show and play the downloaded copy without the server. */
    toDetails(it: OfflineItem, thumb?: string): VideoDetails {
      return {
        contentType: 1,
        id: { platform: "Downloaded" },
        name: it.name,
        url: it.url,
        author: it.author?.name ? { id: { platform: "" }, name: it.author.name, url: it.author.url ?? "", thumbnail: it.author.thumbnail } : undefined,
        dateTime: it.dateTime,
        duration: it.duration,
        thumbnails: thumb ? { sources: [{ url: thumb, quality: 720 }] } : { sources: [] },
        description: "",
        video: { videoSources: [], audioSources: [] },
      } as VideoDetails;
    },

    /** As a card for lists (thumbnail from this device, so it shows offline). */
    toContent(it: OfflineItem, thumb?: string): Content {
      return {
        contentType: 1, id: { platform: "Downloaded" }, name: it.name, url: it.url, duration: it.duration, dateTime: it.dateTime,
        author: it.author?.name ? { id: { platform: "" }, name: it.author.name, url: it.author.url ?? "", thumbnail: it.author.thumbnail } : undefined,
        thumbnails: thumb ? { sources: [{ url: thumb, quality: 720 }] } : undefined,
      };
    },
  };
}

export const offline = createRoot(createOffline);

/** Quality choices for downloads (maximum height; 0 = audio only). Remembered per device. */
export const DOWNLOAD_QUALITIES = [
  { height: 1080, label: "1080p", sub: "Best picture, biggest file" },
  { height: 720, label: "720p", sub: "Good on phones · about 300–500 MB an hour" },
  { height: 480, label: "480p", sub: "Smaller · about 150–250 MB an hour" },
  { height: 360, label: "360p", sub: "Smallest video" },
  { height: 0, label: "Audio only", sub: "Podcasts and music · about 60 MB an hour" },
] as const;

/** The server can't be reached and the app was opened to watch downloads only. */
export const [offlineMode, setOfflineMode] = createRoot(() => createSignal(false));

export function formatBytes(n?: number): string {
  if (!n) return "0 MB";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}
