// Typed wrappers for the Grayjay server endpoints used by the PWA.
import { get, post, del, q, upload } from "./client";

export interface PagerResult<T> { pagerID?: string; results: T[]; hasMore: boolean; exception?: any }

export interface PlatformID { platform: string; value?: string; pluginID?: string }
export interface AuthorLink { id: PlatformID; name: string; url: string; thumbnail?: string; subscribers?: number }
export interface Thumbnails { sources: { url: string; quality: number }[] }

export const ContentType = {
  UNKNOWN: 0, MEDIA: 1, POST: 2, ARTICLE: 3, PLAYLIST: 4, URL: 9, NESTED_VIDEO: 11, CHANNEL: 60, LOCKED: 70, PLACEHOLDER: 90, DEFERRED: 91,
} as const;

export interface Content {
  contentType: number;
  id: PlatformID;
  name: string;
  author?: AuthorLink;
  dateTime?: number | string;
  url: string;
  shareUrl?: string;
  // video
  thumbnails?: Thumbnails;
  duration?: number;
  viewCount?: number;
  isLive?: boolean;
  /** [GrayjayWeb] Queue/previous entries: where to resume when you come back to it (seconds). */
  resumeAt?: number;
  // post
  description?: string;
  images?: string[];
  thumbnailsCount?: number;
  // playlist
  videoCount?: number;
  // channel
  thumbnail?: string;
  subscribers?: number;
  // placeholder
  placeholderIcon?: string;
  error?: any;
  // nested
  contentUrl?: string;
  contentName?: string;
  contentThumbnails?: Thumbnails;
}

export interface VideoDetails extends Content {
  description: string;
  rating?: { type: number; likes?: number; dislikes?: number; value?: number };
  video: { videoSources: any[]; audioSources?: any[] };
  live?: any;
  subtitles?: { name: string; url?: string; format?: string }[];
  isVOD?: boolean;
}

export interface SourceDescriptor {
  url: string; type: string;
  videoIndex?: number; audioIndex?: number; subtitleIndex?: number;
  videoIsLocal?: boolean; audioIsLocal?: boolean; subtitleIsLocal?: boolean;
  drm?: { keySystem: string; licenseUrl: string; serviceCertificate?: string; certificateUrl?: string } | null;
}

export interface Channel {
  id: PlatformID; name: string; thumbnail?: string; banner?: string; subscribers?: number; url: string;
  description?: string; links?: Record<string, string>; urlAlternatives?: string[];
}

export interface Subscription { channel: Channel; lastVideo?: number; doNotifications?: boolean }
export interface SubscriptionGroup { id: string; name: string; urls: string[]; priority: number; image?: any; lastChange?: string; creationTime?: string }

export interface SourceConfig {
  id: string; name: string; description?: string; version: number; author?: string; authorUrl?: string;
  iconUrl?: string; absoluteIconUrl?: string; sourceUrl?: string; scriptUrl?: string; repositoryUrl?: string;
  platformUrl?: string; settings?: any[]; authentication?: any; captcha?: any; allowUrls?: string[]; packages?: string[];
  [k: string]: any;
}
export interface SourceDetails {
  config: SourceConfig;
  state: { capabilities?: any; [k: string]: any };
  hasLoggedIn: boolean; hasCaptcha: boolean; hasUpdate: boolean;
}

// ---------- Auth / pairing ----------
export interface AuthStatus { authenticated: boolean; authDisabled: boolean; passwordEnabled: boolean; device?: { id: string; name: string } | null }
export interface PairingLink { label: string; url: string; secure: boolean }
export interface PairedDevice { id: string; name: string; created: string; lastSeen: string; method: string; current: boolean }
export const auth = {
  status: () => get<AuthStatus>("/auth/Status"),
  pair: (code: string, name?: string) => post<{ ok: boolean }>("/auth/Pair", { code, name }),
  login: (password: string, name?: string) => post<{ ok: boolean }>("/auth/Login", { password, name }),
  logout: () => post("/auth/Logout"),
  pairingCode: () => post<{ code: string; expiresInSeconds: number; links: PairingLink[] }>("/auth/PairingCode"),
  devices: () => get<PairedDevice[]>("/auth/Devices"),
  removeDevice: (id: string) => del(`/auth/Devices/${q(id)}`),
};

// ---------- Feeds ----------
export const home = {
  loadLazy: () => get<PagerResult<Content>>("/home/HomeLoadLazy?initialPageSize=24"),
  next: () => get<PagerResult<Content>>("/home/HomeNextPage"),
};

export const subscriptions = {
  list: () => get<Subscription[]>("/subscriptions/Subscriptions"),
  loadLazy: (updated = false) => get<PagerResult<Content>>(`/subscriptions/SubscriptionsLoadLazy?updated=${updated}`),
  /** Cached feed from the local database: instant, shown while the live feed refreshes. */
  cacheLoad: () => get<PagerResult<Content>>("/subscriptions/SubscriptionsCacheLoad"),
  cacheNext: () => get<PagerResult<Content>>("/subscriptions/SubscriptionsCacheNextPage"),
  groupSave: (group: SubscriptionGroup) => post<SubscriptionGroup>("/subscriptions/SubscriptionGroupSave", group),
  groupDelete: (id: string) => get(`/subscriptions/SubscriptionGroupDelete?id=${q(id)}`),
  next: () => get<PagerResult<Content>>("/subscriptions/SubscriptionsNextPage"),
  groups: () => get<SubscriptionGroup[]>("/subscriptions/SubscriptionGroups"),
  groupLoad: (id: string, updated = false) => get<PagerResult<Content>>(`/subscriptions/SubscriptionGroupLoad?id=${q(id)}&updated=${updated}`),
  groupNext: (id: string) => get<PagerResult<Content>>(`/subscriptions/SubscriptionGroupNextPage?id=${q(id)}`),
  isSubscribed: (url: string) => get<boolean>(`/subscriptions/IsSubscribed?url=${q(url)}`),
  subscribe: (url: string) => get(`/subscriptions/Subscribe?url=${q(url)}`),
  unsubscribe: (url: string) => get(`/subscriptions/Unsubscribe?url=${q(url)}`),
};

export const search = {
  loadLazy: (query: string, type: number = ContentType.MEDIA, filters?: Record<string, string[]>, excludePlugins?: string[], order?: string) =>
    post<PagerResult<Content>>("/search/SearchLoadLazy", { type, query, order, filters, excludePlugins }),
  next: () => get<PagerResult<Content>>("/search/SearchNextPage"),
  suggestions: (query: string) => get<string[]>(`/search/SearchSuggestions?query=${q(query)}`),
  previous: () => get<string[]>("/search/PreviousSearches"),
  addPrevious: (query: string) => get(`/search/AddPreviousSearch?query=${q(query)}`),
  removePrevious: (query: string) => get(`/search/RemovePreviousSearch?query=${q(query)}`),
  clearPrevious: () => get("/search/RemoveAllPreviousSearches"),
  isContentDetailsUrl: (url: string) => get<boolean>(`/search/IsContentDetailsUrl?url=${q(url)}`),
};

export const channel = {
  load: (url: string) => get<Channel>(`/channel/Channel?url=${q(url)}`),
  contentLoad: (url: string) => get<PagerResult<Content>>(`/channel/ChannelContentLoad?url=${q(url)}`),
  contentNext: () => get<PagerResult<Content>>("/channel/ChannelContentNextPage"),
  canGetPlaylists: (url: string) => get<boolean>(`/channel/CanGetChannelPlaylists?url=${q(url)}`),
  playlistsLoad: (url: string) => get<PagerResult<Content>>(`/channel/ChannelPlaylistsLoad?url=${q(url)}`),
  playlistsNext: () => get<PagerResult<Content>>("/channel/ChannelPlaylistsNextPage"),
  /** Content types (VIDEOS, STREAMS, SHORTS…), sort orders (CHRONOLOGICAL, Popular…), search and playlists support. */
  capabilities: (url: string) => get<{ types: string[]; sorts: string[]; search: boolean; playlists: boolean }>(`/channel/ChannelCapabilities?url=${q(url)}`),
  contentLoadTyped: (url: string, type?: string, order?: string) =>
    get<PagerResult<Content>>(`/channel/ChannelContentLoadTyped?url=${q(url)}${type ? `&type=${q(type)}` : ""}${order ? `&order=${q(order)}` : ""}`),
  search: (url: string, query: string) => get<PagerResult<Content>>(`/channel/ChannelContentLoadSearch?url=${q(url)}&query=${q(query)}`),
};

export const history = {
  load: () => get<PagerResult<any>>("/history/HistoryLoad"),
  next: () => get<PagerResult<any>>("/history/HistoryNextPage"),
  search: (query: string) => get<PagerResult<any>>(`/history/HistoryLoadSearch?query=${q(query)}`),
  remove: (url: string) => get(`/history/RemoveHistory?url=${q(url)}`),
  position: (url: string) => get<number>(`/history/GetHistoricalPosition?url=${q(url)}`),
};

export const handling = {
  plan: (url: string) => get<{ type: "content" | "channel" | "playlist" | string; data: any }>(`/handle/GetHandlePlan?url=${q(url)}`),
};

// ---------- Playback ----------
let videoRequestId = 0;
export const details = {
  videoLoad: async (url: string) => {
    const requestId = ++videoRequestId;
    const result = await get<{ video: VideoDetails; local?: any }>(`/details/VideoLoad?url=${q(url)}&requestId=${requestId}`);
    return { ...result, superseded: requestId !== videoRequestId };
  },
  videoClose: () => get(`/details/VideoClose?requestId=${++videoRequestId}`),
  sourceAuto: (url: string) => get<SourceDescriptor>(`/details/SourceAuto?url=${q(url)}`),
  sourceProxy: (url: string, videoIndex: number, audioIndex: number, subtitleIndex = -1, tag = "") =>
    get<SourceDescriptor>(`/details/SourceProxy?url=${q(url)}&videoIndex=${videoIndex}&audioIndex=${audioIndex}&subtitleIndex=${subtitleIndex}&videoIsLocal=false&audioIsLocal=false&subtitleIsLocal=false&tag=${q(tag)}`),
  watchProgress: (url: string, seconds: number) => get(`/details/WatchProgress?url=${q(url)}&position=${Math.floor(seconds)}`),
  commentsLoad: () => get<PagerResult<{ object: any }>>("/details/CommentsLoad"),
  commentsNext: () => get<PagerResult<{ object: any }>>("/details/CommentsNextPage"),
  repliesLoad: (commentId: string) => get<PagerResult<{ object: any }>>(`/details/RepliesLoad?commentId=${q(commentId)}`),
  recommendationsLoad: (url: string) => get<PagerResult<Content>>(`/details/RecommendationsLoad?url=${q(url)}`),
  recommendationsNext: (url: string) => get<PagerResult<Content>>(`/details/RecommendationsNextPage?url=${q(url)}`),
  chapters: (url: string) => get<{ name: string; timeStart: number; timeEnd: number; type: number }[]>(`/details/getVideoChapters?url=${q(url)}`),
};

// ---------- Sources (plugins) ----------
export const sources = {
  all: () => get<SourceConfig[]>("/sources/Sources"),
  /** Per-source state incl. capabilitiesSearch {types, sorts, filters}. */
  states: () => get<any[]>("/sources/SourceStates"),
  enabled: () => get<SourceConfig[]>("/sources/SourcesEnabled"),
  disabled: () => get<SourceConfig[]>("/sources/SourcesDisabled"),
  details: (id: string) => get<SourceDetails>(`/sources/SourceDetails?id=${q(id)}`),
  enable: (id: string) => get(`/sources/SourceEnable?id=${q(id)}`),
  disable: (id: string) => get(`/sources/SourceDisable?id=${q(id)}`),
  reorder: (ids: string[]) => post("/sources/SourcesReorder", ids),
  installPrompt: (url: string) => get<any>(`/sources/SourceInstallPrompt?url=${q(url)}`),
  install: (url: string) => get<SourceConfig>(`/sources/SourceInstall?url=${q(url)}`),
  remove: (id: string) => get(`/sources/SourceDelete?id=${q(id)}`),
  official: () => get<SourceConfig[]>("/sources/OfficialPlugins"),
  installOfficial: (ids: string[]) => post("/sources/InstallOfficialPlugins", ids),
  /** Opens the sign-in browser and returns immediately; use lib/signin.signInAndWait to wait for the result. */
  login: (id: string, startUrl?: string) => get<boolean>(`/sources/SourceLogin?id=${q(id)}${startUrl ? `&startUrl=${q(startUrl)}` : ""}`),
  logout: (id: string) => get(`/sources/SourceLogout?id=${q(id)}`),
  settings: (id: string) => get<any>(`/settings/SourceSettings?id=${q(id)}`),
  settingsSave: (id: string, obj: any) => post(`/settings/SourceSettingsSave?id=${q(id)}`, obj),
};

export const dialogs = {
  respond: (id: string, response: { button: number; action?: string; index?: number; selected?: any; text?: string }) =>
    post(`/dialog/DialogRespond?id=${q(id)}`, response),
};

// ---------- Remote login browser ----------
export interface RemoteBrowserSession { id: string; title: string; url: string; width: number; height: number; mobile: boolean; headful?: boolean }
export const remoteBrowser = {
  sessions: () => get<RemoteBrowserSession[]>("/RemoteBrowser/Sessions"),
  /** Deletes remembered sign-in browser profiles on the server (called on sign-out). */
  forgetAccounts: () => post("/RemoteBrowser/ForgetAccounts"),
};

// ---------- First-run setup, import & Grayjay Sync ----------
export interface SetupStatus { done: boolean; subscriptions: number; enabledSources: number; installedSources: number; syncEnabled: boolean; syncDevices: number }
export const setup = {
  status: () => get<SetupStatus>("/web/setup/Status"),
  complete: () => post("/web/setup/Complete"),
  /** Grayjay backup (.zip exported from Grayjay Android/Desktop). Progress arrives as the "import" custom dialog. */
  importBackup: (file: Blob) => upload<{ ok: boolean; stores?: Record<string, number>; plugins: number }>("/web/import/Backup", file),
  /** NewPipe subscriptions export (.json). Continues in the "importSubs" custom dialog. */
  importNewPipe: (file: Blob) => upload<{ ok: boolean; count: number }>("/web/import/NewPipe", file),
  /** Channel URLs (e.g. parsed from a YouTube Takeout subscriptions.csv). Continues in the "importSubs" dialog. */
  importSubscriptionUrls: (urls: string[]) => post<boolean>("/Import/ImportSubscriptions", urls),
};

export interface SyncDevice { publicKey: string; displayName?: string; metadata?: string; linkType?: number }
export const sync = {
  enable: () => post<{ ok: boolean; pairingUrl: string }>("/web/sync/Enable"),
  pairingUrl: () => get<string>("/Sync/GetPairingUrl"),
  devices: () => get<SyncDevice[]>("/Sync/GetDevices"),
  status: () => get<{ serverSocketStarted: boolean; relayConnected: boolean; serverSocketFailedToStart: boolean }>("/Sync/Status"),
  remove: (publicKey: string) => get(`/Sync/RemoveDevice?publicKey=${q(publicKey)}`),
};

/** Server-driven "custom dialogs" (import progress, subscription import, sync pairing confirmation). */
export const customDialogs = {
  action: (id: string, action: string, data: unknown = null) => post(`/dialog/DialogRespondCustom?id=${q(id)}&actionName=${q(action)}`, data),
};

// [GrayjayWeb] Hidden creators: filtered out of feeds on every device.
export interface HiddenCreator { url: string; name?: string; thumbnail?: string; platform?: string; id?: string; hiddenAt?: string }
export const hiddenCreators = {
  list: () => get<HiddenCreator[]>("/web/hidden/List"),
  add: (c: HiddenCreator) => post("/web/hidden/Add", c),
  remove: (c: HiddenCreator) => post("/web/hidden/Remove", c),
};

// [GrayjayWeb] Follows you between devices: shared queue, what's playing where (for "Continue here").
export interface NowPlayingState {
  deviceId: string; deviceName?: string; url?: string; name?: string; thumbnail?: string; author?: string;
  position: number; duration: number; playing: boolean; audioOnly: boolean; updatedAt: string;
}
export interface DeviceCommand { targetId: string; kind: "pause"; fromId?: string; fromName?: string }
export const deviceSync = {
  queue: () => get<{ items: Content[]; saved: boolean; updatedAt?: string; updatedBy?: string }>("/web/queue"),
  saveQueue: (items: Content[], clientId: string) => post(`/web/queue?clientId=${q(clientId)}`, items),
  nowPlaying: () => get<{ now: string; devices: NowPlayingState[] }>("/web/nowplaying"),
  report: (s: Partial<NowPlayingState> & { clientId: string; heartbeat?: boolean }) => post("/web/nowplaying", s),
  command: (c: DeviceCommand & { clientId: string }) => post("/web/device/Command", c),
};

// Watch later (server-side; also syncs with Grayjay Android/Desktop over Grayjay Sync).
export const watchLater = {
  all: () => get<Content[]>("/WatchLater/GetAll"),
  add: (video: Content) => post("/WatchLater/Add", { ...video, index: 0 }),
  remove: (url: string) => get(`/WatchLater/Remove?url=${q(url)}`),
};
