import { JSX, splitProps } from "solid-js";

// Minimal stroke icon set (24px grid, 1.9 stroke). Paths drawn for this app.
const paths: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  subs: "M4 6h16M4 12h16M4 18h10 M17 15.5v5l4-2.5z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4",
  library: "M4 4h4v16H4z M10 4h4v16h-4z M16.5 4.5l3.5 1-4 15-3.5-1",
  sources: "M9 3h6v4a2 2 0 1 0 0 4v0h4v4a2 2 0 1 1 0 4v2H5v-6a2 2 0 1 0 0-4V7h4z",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M19.4 13.5l1.6 1.2-2 3.5-1.9-.7a7 7 0 0 1-2 1.2L14.8 21h-4l-.3-2.3a7 7 0 0 1-2-1.2l-1.9.7-2-3.5 1.6-1.2a7 7 0 0 1 0-3L4.6 9.3l2-3.5 1.9.7a7 7 0 0 1 2-1.2L10.8 3h4l.3 2.3a7 7 0 0 1 2 1.2l1.9-.7 2 3.5-1.6 1.2a7 7 0 0 1 0 3z",
  play: "M7 4.5v15l13-7.5z",
  pause: "M7 4h3.5v16H7z M13.5 4H17v16h-3.5z",
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  down: "M5 9l7 7 7-7",
  up: "M5 15l7-7 7 7",
  close: "M6 6l12 12M18 6 6 18",
  more: "M12 5.5v.01M12 12v.01M12 18.5v.01",
  share: "M12 3v12 M7.5 7.5 12 3l4.5 4.5 M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6",
  pip: "M3 5h18v14H3z M12 12h7v5h-7z",
  fullscreen: "M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5",
  exitFullscreen: "M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13",
  qr: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h2v2h-2z M18 14h2v2h-2z M14 18h2v2h-2z M18 18h2v2h-2z",
  phone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z M11 18h2",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7L20 8.5 M20 4v4.5h-4.5",
  history: "M3.5 12a8.5 8.5 0 1 0 2.5-6 M3 4v4h4 M12 8v4.5l3 2",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  download: "M12 3v12 M7.5 10.5 12 15l4.5-4.5 M5 20h14",
  like: "M7 10v10H4V10z M7 10l4-7a2 2 0 0 1 3 2l-1 4h6a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.7 20H7",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M4 21a8 8 0 0 1 16 0",
  users: "M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M2 21a7 7 0 0 1 14 0 M16 4.5a4 4 0 0 1 0 7 M18 14.5a7 7 0 0 1 4 6.5",
  wifi: "M2 9a15 15 0 0 1 20 0 M5.5 12.5a10 10 0 0 1 13 0 M9 16a5 5 0 0 1 6 0 M12 19.5v.01",
  lock: "M6 11h12v10H6z M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
  logout: "M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4 M10 16l4-4-4-4 M14 12H3",
  rewind: "M11 6.5v11L3.5 12z M20 6.5v11L12.5 12z",
  ffwd: "M13 6.5v11l7.5-5.5z M4 6.5v11l7.5-5.5z",
  replay10: "M4 12a8 8 0 1 0 2.4-5.7L4 8.7 M4 4v4.7h4.7",
  forward10: "M20 12a8 8 0 1 1-2.4-5.7L20 8.7 M20 4v4.7h-4.7",
  volume: "M4 9h4l5-4v14l-5-4H4z M16.5 8.5a5 5 0 0 1 0 7 M19 6a8.5 8.5 0 0 1 0 12",
  mute: "M4 9h4l5-4v14l-5-4H4z M17 9l5 6 M22 9l-5 6",
  captions: "M3 5h18v14H3z M10 10.5a2.5 2.5 0 1 0 0 3 M17 10.5a2.5 2.5 0 1 0 0 3",
  gauge: "M12 14l4-5 M4.2 18a9 9 0 1 1 15.6 0",
  hd: "M3 5h18v14H3z M7 9v6 M11 9v6 M7 12h4 M14 9v6h1.5a3 3 0 0 0 0-6z",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  heart: "M12 20s-7.5-4.6-9.2-9.3A5 5 0 0 1 12 6.3a5 5 0 0 1 9.2 4.4C19.5 15.4 12 20 12 20z",
  alert: "M12 3 2 20h20z M12 10v4.5 M12 17.5v.01",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18",
  key: "M15 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12z M10.5 13.5 3 21 M6 18l2.5 2.5",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  comment: "M4 5h16v11H9l-5 4z",
  minimize: "M5 12h14",
};

export type IconName = keyof typeof paths;

export default function Icon(props: { name: IconName | string; size?: number; filled?: boolean } & JSX.SvgSVGAttributes<SVGSVGElement>) {
  const [local, rest] = splitProps(props, ["name", "size", "filled"]);
  return (
    <svg
      viewBox="0 0 24 24"
      width={local.size ?? 22}
      height={local.size ?? 22}
      fill={local.filled ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={paths[local.name] ?? ""} />
    </svg>
  );
}
