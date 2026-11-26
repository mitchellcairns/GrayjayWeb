// [GrayjayWeb] Background downloads, imported into the generated service worker (vite.config.ts → workbox.importScripts).
//
// The app hands the copy to this device to the browser's own downloader (Background Fetch: Chrome, Edge, Brave, Samsung
// Internet), so it carries on with the app closed and resumes after a dropped connection. When it finishes, this stores
// the file the same way src/lib/offline.ts does, so the app finds it in Library → Downloads. Keep the two in step.
/* global self, indexedDB, clients */
(() => {
  const DB_NAME = "gj-offline";
  const DB_VERSION = 2;
  const PREFIX = "gj-dl:";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const name of ["items", "files", "thumbs", "parts", "meta"])
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, name === "items" ? { keyPath: "url" } : undefined);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Storage full"));
  });
  const get = (d, store, key) => new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  async function tell(message) {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) c.postMessage(message);
  }

  self.addEventListener("backgroundfetchsuccess", (event) => {
    const reg = event.registration;
    if (!reg.id.startsWith(PREFIX)) return;
    const url = reg.id.slice(PREFIX.length);
    event.waitUntil((async () => {
      const d = await openDb();
      const meta = (await get(d, "meta", url)) || {};
      try {
        const records = await reg.matchAll();
        const res = records.length ? await records[0].responseReady : null;
        if (!res || !res.ok) throw new Error("No file");
        const blob = await res.blob();
        let s = {};
        try {
          const r = await fetch(`/web/downloads/Status?url=${encodeURIComponent(url)}`, { credentials: "same-origin" });
          if (r.ok) s = await r.json();
        } catch { }
        let thumb = null;
        try {
          const r = await fetch(`/web/downloads/Thumbnail?url=${encodeURIComponent(url)}`, { credentials: "same-origin" });
          if (r.ok) thumb = await r.blob();
        } catch { }
        const item = {
          url, aliases: meta.aliases || [],
          name: s.name || meta.name || "Video", duration: s.duration || 0, dateTime: s.dateTime, height: s.height || meta.height || 0,
          audioOnly: !!s.audioOnly,
          author: { name: s.author, url: s.authorUrl, thumbnail: s.authorThumbnail },
          mime: (res.headers.get("content-type") || "video/mp4").split(";")[0], size: blob.size, savedAt: Date.now(), hasThumb: !!thumb,
        };
        const tx = d.transaction(["items", "files", "thumbs", "meta"], "readwrite");
        tx.objectStore("files").put(blob, url);
        if (thumb) tx.objectStore("thumbs").put(thumb, url);
        tx.objectStore("items").put(item);
        tx.objectStore("meta").delete(url);
        await done(tx);
        await event.updateUI({ title: `Downloaded: ${item.name}` });
        await tell({ type: "gj-offline", event: "saved", url });
      } catch (e) {
        await event.updateUI({ title: `Couldn't save ${meta.name || "the download"}` }).catch(() => { });
        await tell({ type: "gj-offline", event: "failed", url, error: String((e && e.message) || e) });
      }
    })());
  });

  self.addEventListener("backgroundfetchfail", (event) => {
    const reg = event.registration;
    if (!reg.id.startsWith(PREFIX)) return;
    const url = reg.id.slice(PREFIX.length);
    event.waitUntil((async () => {
      await event.updateUI({ title: "Download failed: open Grayjay to retry" }).catch(() => { });
      await tell({ type: "gj-offline", event: "failed", url, error: reg.failureReason || "failed" });
    })());
  });

  self.addEventListener("backgroundfetchabort", (event) => {
    const reg = event.registration;
    if (!reg.id.startsWith(PREFIX)) return;
    event.waitUntil(tell({ type: "gj-offline", event: "aborted", url: reg.id.slice(PREFIX.length) }));
  });

  self.addEventListener("backgroundfetchclick", (event) => {
    event.waitUntil(clients.openWindow("/app/library"));
  });
})();
