/**
 * [GrayjayWeb] A window left open across a server update still runs the old build, and the old build's page files
 * (Home, Settings, the player…) are gone from the server and from the service worker's cache: opening one of those
 * pages fails. Reload into the new build instead, at most once every 30 seconds so a real network fault can't loop.
 */
export function reloadForUpdate(): boolean {
  if (!navigator.onLine) return false;
  const last = Number(sessionStorage.getItem("gj.updateReload") || 0);
  if (Date.now() - last < 30_000) return false;
  sessionStorage.setItem("gj.updateReload", String(Date.now()));
  location.reload();
  return true;
}

/** Wraps a dynamic import (`lazy(page(() => import("./pages/Home")))`) so a missing old-build file reloads the app. */
export function page<T>(load: () => Promise<T>): () => Promise<T> {
  return () => load().catch((e) => { reloadForUpdate(); throw e; });
}
