import { Component, JSX, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  Captions, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Compass, Download, EllipsisVertical, ExternalLink,
  FastForward, Gauge, Globe, GripVertical, Heart, History, House, KeyRound, Library, Link, List, ListVideo, Lock, LogOut,
  Maximize, MessageSquare, Minimize, Minus, PictureInPicture2, Play, Pause, Plus, Puzzle, QrCode, RefreshCw, Rewind,
  RotateCcw, RotateCw, Search, Settings, Share2, SkipForward, Smartphone, ThumbsUp, Trash2, TriangleAlert, Tv, User, Users,
  Volume2, VolumeX, Wifi, X, ListPlus, ListCheck, ListMusic, Headphones, EyeOff, Eye, SkipBack, Video, MonitorSmartphone, Clock, Info,
} from "lucide-solid";

// Lucide icons (ISC licence) under the names the app uses.
const icons: Record<string, Component<any>> = {
  home: House,
  discover: Compass,
  subs: ListVideo,
  search: Search,
  library: Library,
  sources: Puzzle,
  settings: Settings,
  play: Play,
  pause: Pause,
  back: ChevronLeft,
  forward: ChevronRight,
  down: ChevronDown,
  up: ChevronUp,
  close: X,
  more: EllipsisVertical,
  share: Share2,
  pip: PictureInPicture2,
  fullscreen: Maximize,
  exitFullscreen: Minimize,
  plus: Plus,
  check: Check,
  trash: Trash2,
  qr: QrCode,
  phone: Smartphone,
  link: Link,
  refresh: RefreshCw,
  history: History,
  list: List,
  download: Download,
  like: ThumbsUp,
  user: User,
  users: Users,
  wifi: Wifi,
  lock: Lock,
  logout: LogOut,
  rewind: Rewind,
  ffwd: FastForward,
  replay10: RotateCcw,
  forward10: RotateCw,
  volume: Volume2,
  mute: VolumeX,
  captions: Captions,
  gauge: Gauge,
  hd: Tv,
  external: ExternalLink,
  heart: Heart,
  alert: TriangleAlert,
  globe: Globe,
  key: KeyRound,
  grip: GripVertical,
  comment: MessageSquare,
  minimize: Minus,
  skip: SkipForward,
  queueAdd: ListPlus,
  queued: ListCheck,
  queue: ListMusic,
  headphones: Headphones,
  hide: EyeOff,
  show: Eye,
  previous: SkipBack,
  video: Video,
  devices: MonitorSmartphone,
  later: Clock,
  info: Info,
};

export type IconName = keyof typeof icons;

export default function Icon(props: { name: IconName | string; size?: number; filled?: boolean } & JSX.SvgSVGAttributes<SVGSVGElement>) {
  const [local, rest] = splitProps(props, ["name", "size", "filled"]);
  return (
    <Dynamic
      component={icons[local.name] ?? Puzzle}
      size={local.size ?? 22}
      stroke-width={1.9}
      fill={local.filled ? "currentColor" : "none"}
      aria-hidden="true"
      {...rest}
    />
  );
}
