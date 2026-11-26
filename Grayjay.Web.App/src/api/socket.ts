// Server push channel (/ws): pager updates, dialogs, toasts, plugin/subscription changes, remote login browser events.
import { createSignal } from "solid-js";

export interface Packet<T = any> { id?: string; type: string; payload: T }
type Handler = (packet: Packet) => void;

const handlers = new Map<string, Set<Handler>>();
const [connected, setConnected] = createSignal(false);
export { connected };

let socket: WebSocket | null = null;
let retry = 0;
let started = false;
let pending: string[] = [];

function url() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

function connect() {
  socket = new WebSocket(url());
  socket.addEventListener("open", () => {
    retry = 0;
    setConnected(true);
    for (const p of pending) socket?.send(p);
    pending = [];
  });
  socket.addEventListener("message", (ev) => {
    let packet: Packet;
    try { packet = JSON.parse(ev.data); } catch { return; }
    handlers.get(packet.type)?.forEach((h) => {
      try { h(packet); } catch (e) { console.error("socket handler", packet.type, e); }
    });
  });
  socket.addEventListener("close", () => {
    setConnected(false);
    socket = null;
    const delay = Math.min(15000, 500 * 2 ** retry++);
    setTimeout(() => { if (document.visibilityState !== "hidden") connect(); else waitVisible(); }, delay);
  });
}

function waitVisible() {
  const onVis = () => {
    if (document.visibilityState === "visible") {
      document.removeEventListener("visibilitychange", onVis);
      if (!socket) connect();
    }
  };
  document.addEventListener("visibilitychange", onVis);
}

export function startSocket() {
  if (started) return;
  started = true;
  connect();
}

export function on<T = any>(type: string, handler: (packet: Packet<T>) => void): () => void {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type)!.add(handler as Handler);
  return () => handlers.get(type)?.delete(handler as Handler);
}

export function send(packet: Packet) {
  const data = JSON.stringify(packet);
  if (socket?.readyState === WebSocket.OPEN) socket.send(data);
  else pending.push(data);
}
