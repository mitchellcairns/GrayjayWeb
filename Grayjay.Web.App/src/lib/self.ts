// This device's identity for device-to-device features: the paired device id from the server, or (when the server
// runs without auth) a random id kept in localStorage.
import { createRoot, createSignal } from "solid-js";
import { auth } from "../api";

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const self = createRoot(() => {
  let local = localStorage.getItem("gj.clientId");
  if (!local) { local = randomId(); localStorage.setItem("gj.clientId", local); }
  const [id, setId] = createSignal<string>(local);
  const [name, setName] = createSignal<string>("");
  const ready = auth.status().then((s) => { if (s.device?.id) { setId(s.device.id); setName(s.device.name); } }).catch(() => { });
  return { id, name, clientId: local, ready };
});
