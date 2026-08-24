/** Domain types shared between the main process, preload, and renderer. */

export const SUPPORTED_LOCALES = [
  'en',
  'zh-CN',
  'zh-TW',
  'ja',
  'ko',
  'de',
  'es',
  'fr',
  'pt-BR'
] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export type RepoKind = 'model' | 'dataset' | 'space'

/** One Go-menu / palette destination. `key` is the Cmd/Ctrl+N accelerator. */
export interface NavigationShortcut {
  route: string
  menuKey: string
  labelKey: string
  /** Digit accelerator; omit for destinations that only appear in the menu. */
  key?: string
}

/**
 * Native menu, renderer shortcut help, and the command palette consume this
 * same navigation map. Numbered entries keep Cmd/Ctrl+1–9; the rest fill the
 * Go menu and palette so Home / Collections / My repos / Compare / Upload
 * are reachable without hunting the sidebar.
 */
export const NAVIGATION_SHORTCUTS: readonly NavigationShortcut[] = [
  { route: '/', menuKey: 'menu.home', labelKey: 'home' },
  { key: '1', route: '/models', menuKey: 'menu.models', labelKey: 'models' },
  { key: '2', route: '/datasets', menuKey: 'menu.datasets', labelKey: 'datasets' },
  { key: '3', route: '/spaces', menuKey: 'menu.spaces', labelKey: 'spaces' },
  { key: '4', route: '/papers', menuKey: 'menu.papers', labelKey: 'papers' },
  { key: '5', route: '/favorites', menuKey: 'menu.favorites', labelKey: 'favorites' },
  { key: '6', route: '/downloads', menuKey: 'menu.downloads', labelKey: 'downloads' },
  { key: '7', route: '/cache', menuKey: 'menu.cache', labelKey: 'cache' },
  { key: '8', route: '/inbox', menuKey: 'menu.inbox', labelKey: 'inbox' },
  { key: '9', route: '/history', menuKey: 'menu.history', labelKey: 'history' },
  { route: '/collections', menuKey: 'menu.collections', labelKey: 'collections' },
  { route: '/my-repos', menuKey: 'menu.myRepos', labelKey: 'myRepos' },
  { route: '/compare', menuKey: 'menu.compare', labelKey: 'compare' },
  { route: '/upload', menuKey: 'menu.upload', labelKey: 'upload' }
]

/** One-click Hub endpoint presets (null = official huggingface.co). */
export const HUB_ENDPOINT_PRESETS = [
  { id: 'official', endpoint: null },
  { id: 'hf-mirror', endpoint: 'https://hf-mirror.com' }
] as const

export type HubEndpointPresetId = (typeof HUB_ENDPOINT_PRESETS)[number]['id']

export interface RepoSummary {
  id: string
  kind: RepoKind
  author: string
  name: string
  likes: number
  downloads: number
  /** ISO timestamp of last modification, when the API provides it. */
  updatedAt?: string
  createdAt?: string
  private: boolean
  gated: string | boolean
  tags: string[]
  /** Models only: task, e.g. "text-generation". */
  pipelineTag?: string
  /** Models only: e.g. "transformers". */
  libraryName?: string
  license?: string
  /** Total parameter count when the API exposes safetensors metadata. */
  paramCount?: number
  /** Spaces only: sdk, e.g. "gradio". */
  sdk?: string
  trendingScore?: number
  /** Spaces only: card emoji + gradient + runtime stage for gallery rendering. */
  emoji?: string
  colorFrom?: string
  colorTo?: string
  shortDescription?: string
  runtimeStage?: string
  /** Spaces only: current hardware id, e.g. "cpu-basic", "zero-a10g". */
  hardware?: string
}

export interface RepoDetail extends RepoSummary {
  sha?: string
  /** Spaces only: hostname of the live app (*.hf.space or *.static.hf.space). */
  spaceDomain?: string
  lastModified?: string
  cardData?: Record<string, unknown>
  siblings?: Array<{ rfilename: string; size?: number }>
  spaces?: string[]
  usedStorage?: number
  downloadsAllTime?: number
}

export interface FileTreeEntry {
  type: 'file' | 'directory'
  path: string
  size: number
  oid?: string
  lfs?: { oid: string; size: number }
}

export interface PaperSummary {
  id: string
  title: string
  summary: string
  publishedAt?: string
  upvotes: number
  authors: string[]
  thumbnail?: string
  numComments?: number
}

export type RepoSort = 'trending' | 'downloads' | 'likes' | 'updated' | 'created'

export interface SearchQuery {
  kind: RepoKind
  search?: string
  author?: string
  /** Raw tag filters, e.g. "license:mit", "gguf". */
  tags?: string[]
  pipelineTag?: string
  library?: string
  license?: string
  sort: RepoSort
  /** Filter to models served by a specific inference provider (models only). */
  inferenceProvider?: string
  limit?: number
  /** Opaque pagination cursor (full URL of the next page). */
  cursor?: string
}

export interface Page<T> {
  items: T[]
  nextCursor?: string
}

/**
 * Paid org plan from Hub overview / whoami (`plan` field).
 * `plus` is Enterprise Plus; `academia` is the academic org tier.
 */
export type HubOrgPlan = 'team' | 'enterprise' | 'plus' | 'academia'

export interface OrgSummary {
  name: string
  fullname?: string
  avatarUrl?: string
  /** Present when the Hub payload includes a paid org plan. */
  plan?: HubOrgPlan
}

export interface UserProfile {
  name: string
  fullname?: string
  email?: string
  avatarUrl?: string
  isPro?: boolean
  orgs: OrgSummary[]
}

export type AuthState =
  | { status: 'signedOut' }
  /**
   * Access-token session. `scopes` is unused (token permissions are decided by
   * the Hub token itself; the UI lets attempts through and the API is the
   * referee). `method` is always `'token'`.
   */
  | {
      status: 'signedIn'
      user: UserProfile
      scopes?: string[]
      method?: 'oauth' | 'token'
      /** User-chosen token name from whoami-v2, when the Hub reports it. */
      tokenDisplayName?: string
      /** 'read' | 'write' | 'fineGrained' when the Hub reports it. */
      tokenRole?: string
      /**
       * True when a supplemental Hub web-session cookie is connected. The
       * cookie itself never crosses IPC — this flag is all the renderer sees.
       * It unlocks the social writes the Hub blocks for Bearer tokens (like,
       * post reactions/comments, watch, discussion reactions).
       */
      hubSession?: boolean
    }

/** Result of a manual-token sign-in attempt; failures never throw across IPC. */
export type TokenSignInResult =
  { ok: true; state: AuthState } | { ok: false; error: 'invalid' | 'forbidden' | 'network' }

/**
 * Result of connecting a Hub web session (cookie) via the login window.
 * `mismatch` = the browser login belongs to a different account than the
 * token session; `canceled` = the user closed the login window.
 */
export type HubSessionConnectResult =
  | { ok: true; state: AuthState }
  | { ok: false; error: 'canceled' | 'timeout' | 'mismatch' | 'invalid' | 'forbidden' | 'network' }

/**
 * Sentinel embedded in CookieRequiredError messages. Electron flattens errors
 * thrown across IPC to their message string, so the renderer matches on this
 * (see renderer lib/errors.ts).
 */
export const HUB_SESSION_REQUIRED_CODE = 'HUB_WEB_SESSION_REQUIRED'

export interface HubNotification {
  /** discussion id used by mark-as-read, when the notification is discussion-backed */
  discussionId?: string
  kind: 'repo' | 'paper' | 'post' | 'org' | 'other'
  read: boolean
  updatedAt?: string
  title: string
  /** in-app route, e.g. /models/{id}/discussions/{num} or /posts/{author}/{slug} */
  route?: string
  repoId?: string
  repoKind?: RepoKind
  discussionNum?: number
  discussionStatus?: 'draft' | 'open' | 'closed' | 'merged'
  isPullRequest?: boolean
  participants?: { user: string; avatar?: string }[]
}

export interface NotificationsPage {
  count: number
  items: HubNotification[]
}

export type DownloadStatus = 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'canceled'

export interface DownloadFileState {
  path: string
  size: number
  receivedBytes: number
  status: DownloadStatus
  /** sha256 expected for LFS files (from the HF etag). */
  sha256?: string
  verified?: boolean
  error?: string
}

export interface DownloadTask {
  id: string
  repoId: string
  kind: RepoKind
  /** User-requested branch, tag, or commit. */
  revision: string
  /** Immutable 40-hex commit resolved before the task was queued. */
  resolvedCommit?: string
  errorCode?: 'legacy-task' | 'environment-mismatch' | 'commit-mismatch' | 'network' | 'integrity'
  /** False when continuing the task could mix endpoint/cache environments. */
  resumable: boolean
  status: DownloadStatus
  totalBytes: number
  receivedBytes: number
  /** Rolling average, bytes per second. */
  speedBps: number
  files: DownloadFileState[]
  error?: string
  createdAt: string
  completedAt?: string
}

export interface DownloadAutoExport {
  tool: ExportTool
  filePath: string
}

export interface DownloadRequest {
  repoId: string
  kind: RepoKind
  revision?: string
  /** File paths to fetch; omit to download the whole snapshot. */
  files?: string[]
  /**
   * After this task completes, export `filePath` (must be in `files`) to the
   * local tool. Not persisted across app restarts.
   */
  autoExport?: DownloadAutoExport
}

export interface CachedRevision {
  commitHash: string
  sizeOnDisk: number
  fileCount: number
  refs: string[]
  lastModified?: string
}

export interface CachedRepo {
  id: string
  kind: RepoKind
  sizeOnDisk: number
  revisions: CachedRevision[]
  lastModified?: string
  /** Bytes of leftover `*.incomplete*` download partials in blobs/ (absent/0 when none). */
  partialSize?: number
  /** Number of leftover partial files in blobs/. */
  partialCount?: number
}

export interface CacheReport {
  root: string
  totalSize: number
  repos: CachedRepo[]
  scannedAt: string
  /** Total bytes of leftover download partials across all repos. */
  partialSize?: number
}

/** A fully-resolved git commit SHA — the only revisions cached with no ref file. */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/

/**
 * Revisions safe to offer in a one-click "clean stale" action: ref-less
 * revisions in a repo that still has at least one ref'd revision. Repos whose
 * revisions are ALL detached (e.g. SHA-pinned downloads) yield [] — deleting
 * those must stay an explicit per-revision action. `pinnedCommits` (commits
 * this app downloaded deliberately by SHA) are never considered stale.
 */
export function staleRevisionsOf(
  repo: CachedRepo,
  pinnedCommits?: ReadonlySet<string>
): CachedRevision[] {
  if (!repo.revisions.some((r) => r.refs.length > 0)) return []
  return repo.revisions.filter((r) => r.refs.length === 0 && !pinnedCommits?.has(r.commitHash))
}

/**
 * Per-worker slice of the aggregate download speed limit; null = unlimited.
 * Floors at 1 B/s so a tiny limit still throttles instead of dividing to 0.
 */
export function computeSpeedShare(
  limitBps: number | null | undefined,
  workerCount: number
): number | null {
  if (!limitBps || limitBps <= 0) return null
  return Math.max(1, Math.floor(limitBps / Math.max(1, workerCount)))
}

export interface FavoriteItem {
  repoId: string
  kind: RepoKind
  addedAt: string
  summary: RepoSummary
}

export interface HistoryItem {
  repoId: string
  kind: RepoKind
  viewedAt: string
  summary: RepoSummary
}

export type FollowTargetType = 'user' | 'org' | 'repo' | 'papers'

export interface Follow {
  id: string
  type: FollowTargetType
  /** username, org name, or "kind:repoId"; empty for 'papers'. */
  target: string
  createdAt: string
  lastCheckedAt?: string
}

export type InboxItemKind = 'repo-update' | 'new-repo' | 'paper'

export interface InboxItem {
  id: string
  kind: InboxItemKind
  title: string
  body: string
  /** In-app route to open when clicked, e.g. "/models/meta-llama/Llama-3-8B". */
  route: string
  createdAt: string
  readAt?: string
}

export interface DiscussionSummary {
  num: number
  title: string
  status: 'open' | 'closed' | 'merged' | 'draft'
  isPullRequest: boolean
  author?: string
  createdAt?: string
  numComments?: number
}

export interface DiscussionEvent {
  id: string
  type: string
  author?: string
  createdAt?: string
  /** Markdown content for comments. */
  content?: string
  /** status-change events: the new status. */
  status?: string
  /** commit events. */
  oid?: string
  subject?: string
  /** Per-emoji reactions on comment events (empty/absent otherwise). */
  reactions?: PostReaction[]
  /** title-change events: previous and new title. */
  titleFrom?: string
  titleTo?: string
  /** pinning-change events: true = pinned, false = unpinned. */
  pinned?: boolean
  /** locking-change events: true = locked, false = unlocked. */
  locked?: boolean
}

export interface DiscussionDetail extends DiscussionSummary {
  events: DiscussionEvent[]
  /** Pull requests only. */
  baseRef?: string
  diffUrl?: string
}

export type DiscussionType = 'discussion' | 'pull_request'
export type DiscussionStatusFilter = 'open' | 'closed'

/** One emoji reaction on a post, with who reacted (to derive the current user's state). */
export interface PostReaction {
  emoji: string
  count: number
  /** Usernames that reacted with this emoji; used to highlight the caller's own reaction. */
  users: string[]
}

/**
 * The fixed reaction set the Hub web UI offers on posts and discussion
 * comments. Live-captured from the huggingface.co picker 2026-07-11.
 */
export const HUB_REACTION_EMOJIS = [
  '🔥',
  '🚀',
  '👀',
  '❤️',
  '🤗',
  '😎',
  '➕',
  '🧠',
  '👍',
  '🤝',
  '😔',
  '🤯'
] as const

/**
 * A media attachment on a post. The Hub keeps these OUT of the markdown body —
 * they live in a separate `attachments` array — so they must be rendered
 * alongside the text, not inside it.
 */
export interface PostAttachment {
  type: 'image' | 'video'
  /** Absolute CDN URL (cdn-uploads.huggingface.co). */
  url: string
}

export interface PostSummary {
  slug: string
  author: string
  authorFullname?: string
  authorAvatarUrl?: string
  /** Hub `author.isPro` — drives compact Pro avatar frame when true. */
  authorIsPro?: boolean
  /** Raw markdown-ish text of the post. */
  content: string
  publishedAt?: string
  numComments?: number
  numReactions?: number
  /** Per-emoji reaction breakdown (empty when the post has no reactions). */
  reactions: PostReaction[]
  /** Image/video attachments the Hub stores separately from the markdown body. */
  attachments: PostAttachment[]
  /** Absolute huggingface.co URL. */
  url: string
}

/** One comment on a community post (parsed from the Hub post page's embedded data). */
export interface PostComment {
  /** 24-hex comment id; addressable for replies and reactions. */
  id: string
  author: string
  authorFullname?: string
  authorAvatarUrl?: string
  authorIsPro?: boolean
  createdAt?: string
  /** Raw markdown of the latest revision. */
  content: string
  reactions: PostReaction[]
  /** Nested replies to this comment (the Hub threads them one level deep). */
  replies?: PostComment[]
  /** Hidden comments keep their metadata but the content is withheld by the Hub. */
  hidden?: boolean
  /** Verbatim reason label the moderator picked (e.g. "Off-Topic"), when hidden. */
  hiddenReason?: string
  /** Username that hid the comment, when reported. */
  hiddenBy?: string
}

/**
 * The fixed reasons the Hub offers when hiding a comment. Sent VERBATIM as the
 * `reason` field (the API stores the display label, not a code). Live-captured
 * 2026-07-11. Hiding is optional-reason and irreversible.
 */
export const HUB_HIDE_REASONS = [
  'Spam',
  'Abuse',
  'Graphic Content',
  'Resolved',
  'Off-Topic',
  'Low Quality'
] as const
export type HubHideReason = (typeof HUB_HIDE_REASONS)[number]

/** One custom field on a gated repo's access-request form (the Hub uses the question text as the field name). */
export interface GatedFormField {
  name: string
  type: 'checkbox' | 'text' | 'textarea' | 'select' | 'date'
  required: boolean
  /** Choices when type is 'select'. */
  options?: string[]
}

/**
 * The signed-in account's standing with a gated repo.
 * granted — access already approved; ask — can submit the access form;
 * pending — submitted, awaiting manual review (gate form no longer offered).
 */
export interface RepoAccessGate {
  status: 'granted' | 'ask' | 'pending'
  /** Fields to render when status is 'ask'. */
  fields: GatedFormField[]
}

/** Whether the signed-in account may create community posts (Hub gates this behind a beta). */
export interface CanPostResult {
  canPost: boolean
  /** Hub-provided explanation when posting is unavailable. */
  reason?: string
}

/**
 * Editable public-profile fields, mirroring the Hub's Settings → Profile form
 * (no JSON endpoint — scraped from the SSR page; needs a Hub web session).
 */
export interface HubProfileSettings {
  fullname: string
  homepage: string
  /** The "AI & ML interests" textarea (the form's `details` field). */
  details: string
  github: string
  twitter: string
  linkedin: string
  bluesky: string
  /** Primary organization name; '' when none is set. */
  primaryOrg: string
  /** Orgs the Hub offers for primaryOrg (Team/Enterprise plans only). */
  primaryOrgOptions: Array<{ value: string; label: string }>
}

/** Profile fields posted back to the Hub. `avatar` is a freshly uploaded image URL; omit to keep the current one. */
export interface HubProfileUpdate {
  fullname: string
  homepage: string
  details: string
  github: string
  twitter: string
  linkedin: string
  bluesky: string
  primaryOrg: string
  avatar?: string
}

export interface UserOverview {
  /** 24-hex `_id` from the overview response — required for watch updates. */
  internalId?: string
  name: string
  fullname?: string
  avatarUrl?: string
  bio?: string
  /** Personal PRO subscription (users only). */
  isPro?: boolean
  /** Org plan when this overview is an organization (`team` / `enterprise` / `plus` / …). */
  plan?: HubOrgPlan
  numModels: number
  numDatasets: number
  numSpaces: number
  numPapers?: number
  numFollowers: number
  numFollowing: number
  /** Org member count (`numUsers` on the organizations overview). */
  numUsers?: number
  numLikes?: number
  orgs: OrgSummary[]
  createdAt?: string
  /** Whether the signed-in account follows this user on the Hub. */
  isFollowing?: boolean
  isOrg?: boolean
}

export interface FollowedAccount {
  name: string
  fullname?: string
  avatarUrl?: string
  isOrg?: boolean
}

/** One entry of the Hub watch list, as returned by PATCH /api/settings/watch. */
export interface WatchedEntry {
  /** 24-hex internal id, when the Hub reports it. */
  internalId?: string
  name: string
  type: 'user' | 'org'
}

/** A discussion/PR surfaced in the activity feed. */
export interface ActivityDiscussion {
  repoId: string
  repoKind: RepoKind
  num: number
  title: string
  isPullRequest: boolean
  status?: string
  numComments?: number
}

/**
 * One item in the personalized "following" activity feed
 * (`/api/recent-activity`). Discriminated by `kind`; each carries the actor and
 * a type-specific payload. Kinds the app doesn't render yet (collection, upvote,
 * paper-daily) are dropped by the mapper.
 */
export type ActivityItem =
  | {
      kind: 'like' | 'update' | 'publish' | 'new-repo'
      time?: string
      actor: string
      actorAvatarUrl?: string
      /** Hub activity `isPro` when present. */
      actorIsPro?: boolean
      repo: RepoSummary
    }
  | {
      kind: 'social-post'
      time?: string
      actor: string
      actorAvatarUrl?: string
      actorIsPro?: boolean
      post: PostSummary
    }
  | {
      kind: 'discussion'
      time?: string
      actor: string
      actorAvatarUrl?: string
      actorIsPro?: boolean
      discussion: ActivityDiscussion
    }

export interface ActivityFeed {
  items: ActivityItem[]
  /** Opaque cursor for the next page, when the Hub returns one. */
  cursor?: string
}

export type ThemeSetting = 'system' | 'light' | 'dark'

export type DefaultHome = 'home' | 'models' | 'datasets' | 'spaces' | 'papers'

export type UiDensity = 'comfortable' | 'compact'

export type AccentPreset = 'default' | 'blue' | 'green' | 'orange' | 'violet'

export type BrowsePageSize = 20 | 30 | 50

export type RepoOpenTarget = 'app' | 'browser'

export type HistoryLimit = 50 | 100 | 200 | 500

export interface AppSettings {
  locale: 'system' | Locale
  theme: ThemeSetting
  downloadConcurrency: number
  /** null = unlimited */
  speedLimitBps: number | null
  /** null = platform default HF cache dir */
  hfCacheDir: string | null
  notificationsEnabled: boolean
  pollIntervalMinutes: number
  /** UI zoom percentage (100 = default). */
  uiScale: number
  /** null = https://huggingface.co */
  hubEndpoint: string | null
  /** null = no app-level HTTP(S) proxy override */
  proxyUrl: string | null
  /** Open the app automatically when the user logs into the OS. */
  launchAtLogin: boolean
  /** Hide to the system tray instead of quitting when the window is closed. */
  closeToTray: boolean
  /** Landing route when opening the app at `/`. */
  defaultHome: DefaultHome
  /** Default browse sort for models/datasets/spaces. */
  defaultRepoSort: RepoSort
  /** List/sidebar spacing density. */
  uiDensity: UiDensity
  /** Focus/selection accent preset (does not change CTA or brand yellow). */
  accent: AccentPreset
  /** Root font-size percentage (100 = default); independent of uiScale zoom. */
  fontScale: number
  /** Manual sidebar collapse persisted in settings. */
  sidebarCollapsed: boolean
  /** Page size for main browse / search lists. */
  browsePageSize: BrowsePageSize
  /** Where favorites/history/global-search open repos. */
  repoOpenTarget: RepoOpenTarget
  /** Max local history rows retained. */
  historyLimit: HistoryLimit
  /** Pseudonymous, low-cardinality product telemetry. Disabled until the user opts in. */
  telemetryEnabled: boolean
}

/** Renderer-writable settings. Cache roots are selected and persisted by main. */
export type SettingsPatch = Partial<Omit<AppSettings, 'hfCacheDir'>>

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'system',
  theme: 'system',
  downloadConcurrency: 3,
  speedLimitBps: null,
  hfCacheDir: null,
  notificationsEnabled: true,
  pollIntervalMinutes: 30,
  uiScale: 100,
  hubEndpoint: null,
  proxyUrl: null,
  launchAtLogin: false,
  closeToTray: false,
  defaultHome: 'home',
  defaultRepoSort: 'trending',
  uiDensity: 'comfortable',
  accent: 'default',
  fontScale: 100,
  sidebarCollapsed: false,
  browsePageSize: 30,
  repoOpenTarget: 'app',
  historyLimit: 200,
  telemetryEnabled: false
}

/** Subset of process.platform values the app runs on (kept Node-types-free for the renderer). */
export type Platform = 'darwin' | 'win32' | 'linux' | 'freebsd' | 'openbsd' | 'aix' | 'sunos'

export interface AppInfo {
  version: string
  platform: Platform
  electronVersion: string
  systemLocale: string
  hfCacheDir: string
}

export type AppUpdateErrorCode =
  'network' | 'configuration' | 'verification' | 'permission' | 'unknown'

export type AppUpdateOperation = 'check' | 'download' | 'install'

interface AppUpdateStateBase {
  currentVersion: string
}

/** Public updater state. Paths, feed URLs, and raw provider errors never cross IPC. */
export type AppUpdateState =
  | (AppUpdateStateBase & { status: 'unsupported' | 'idle' | 'checking' | 'up-to-date' })
  | (AppUpdateStateBase & {
      status: 'available' | 'manual' | 'ready'
      availableVersion: string
    })
  | (AppUpdateStateBase & {
      status: 'downloading'
      availableVersion: string
      percent: number
      transferred: number
      total: number
      bytesPerSecond: number
    })
  | (AppUpdateStateBase & {
      status: 'error'
      operation: AppUpdateOperation
      error: AppUpdateErrorCode
      availableVersion?: string
    })

export type ExportTool = 'ollama' | 'lmstudio' | 'comfyui'

export interface CacheSnapshotFile {
  path: string
  size: number
}

export interface CacheSnapshot {
  commit: string
  files: CacheSnapshotFile[]
}

export interface RepoCommitFile {
  path: string
  content: string
}

export type RepoCommitResult =
  | { ok: true; branch: string; compareUrl?: string }
  | { ok: false; error: string; messageKey?: string }

export interface ExportTarget {
  tool: ExportTool
  detected: boolean
  path?: string
}

/** messageKey resolves in the renderer's `integrations` i18n namespace. */
export interface ExportResult {
  ok: boolean
  messageKey: string
  params?: Record<string, string>
}

export type UploadWarningCode = 'sensitive-path' | 'large-upload'

export interface UploadWarning {
  code: UploadWarningCode
  /** Relative paths only; never an executable local absolute path. */
  paths?: string[]
  overflow?: number
  requiresAcknowledgement: true
}

/** Opaque, one-use directory grant created by the main process. */
export interface UploadSelection {
  selectionId: string
  label: string
  expiresAt: string
  fileCount: number
  totalBytes: number
  excludedCount: number
  warnings: UploadWarning[]
}

export interface UploadStartRequest {
  selectionId: string
  kind: RepoKind
  name: string
  private: boolean
  acknowledgedWarningCodes: UploadWarningCode[]
}

export interface ExportStartRequest {
  tool: ExportTool
  kind: RepoKind
  repoId: string
  filePath: string
}

export type IntegrationTaskStatus = 'preparing' | 'running' | 'done' | 'error' | 'canceled'

export interface IntegrationTaskBase {
  id: string
  kind: 'upload' | 'export'
  status: IntegrationTaskStatus
  phase: string
  /** 0..1 when the underlying operation exposes determinate progress. */
  progress?: number
  messageKey?: string
  params?: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface UploadIntegrationTask extends IntegrationTaskBase {
  kind: 'upload'
  repoId?: string
  repoKind: RepoKind
  path?: string
  repoUrl?: string
}

export interface ExportIntegrationTask extends IntegrationTaskBase {
  kind: 'export'
  tool: ExportTool
  repoKind: RepoKind
  repoId: string
  filePath: string
  /** Tracked main-process output; renderer reveals it only by task id. */
  outputLabel?: string
}

export type IntegrationTask = UploadIntegrationTask | ExportIntegrationTask

export interface InferenceRequest {
  model: string
  input: string
}

export interface InferenceResult {
  ok: boolean
  output?: string
  error?: string
}

export interface InferenceStreamEvent {
  id: string
  delta?: string
  done?: boolean
  error?: string
}

export interface FileTextResult {
  content: string
  truncated: boolean
  size: number
}

export interface SafetensorsTensor {
  name: string
  dtype: string
  shape: number[]
}

export interface SafetensorsHeader {
  tensors: SafetensorsTensor[]
  metadata?: Record<string, string>
  totalParams: number
}

export interface DatasetSplit {
  config: string
  split: string
}

export interface UserSearchResult {
  name: string
  fullname?: string
  avatarUrl?: string
}

/** Org hit from `/api/quicksearch?type=org` (Hub uses `name`, not `user`). */
export interface OrgSearchResult {
  name: string
  fullname?: string
  avatarUrl?: string
}

/** Paper hit from `/api/quicksearch?type=paper` (`_id` → `id`). */
export interface PaperSearchResult {
  id: string
  title: string
}

/** Collection hit from `/api/quicksearch?type=collection` (`_id` is the routable slug). */
export interface CollectionSearchResult {
  slug: string
  title: string
  description?: string
}

export interface DatasetRows {
  columns: string[]
  /** Cell values pre-stringified and truncated for display. */
  rows: string[][]
  total?: number
  /**
   * True when these are the SSR sample rows from the dataset page — the
   * fallback the Hub itself shows when the full viewer isn't available.
   */
  sample?: boolean
}

export interface CollectionSummary {
  /** "owner/title-slug-<24hex>" — the API path segment. */
  slug: string
  title: string
  description?: string
  owner: string
  private: boolean
  theme?: string
  itemCount?: number
  upvotes?: number
  /** Whether the signed-in account upvoted this collection (detail responses only). */
  isUpvoted?: boolean
  updatedAt?: string
}

export interface CollectionItem {
  /** `_id` used for item PATCH/DELETE. */
  itemId: string
  type: 'model' | 'dataset' | 'space' | 'paper' | 'collection'
  /** Repo id / paper id. */
  id: string
  /** Paper title or repo id. */
  title?: string
  /** Routable slug for type:'collection' items — the id field is the internal 24-hex id. */
  slug?: string
  note?: string
  position?: number
  /** Light display metadata when present in the API response: */
  downloads?: number
  likes?: number
  emoji?: string
}

export interface CollectionDetail extends CollectionSummary {
  items: CollectionItem[]
}

export interface MyRepoEntry {
  id: string
  /** Filter API `type` to model|dataset|space; drop bucket/kernel. */
  kind: RepoKind
  visibility: 'public' | 'private' | 'protected'
  updatedAt: string
  storage: number
  storagePercent: number
}

export interface AccessRequestUser {
  name: string
  fullname?: string
  avatarUrl?: string
}

export interface AccessRequest {
  user: AccessRequestUser
  timestamp?: string
  /** Extra gate-form fields if present. */
  fields?: Record<string, string>
}

export interface SpaceSecret {
  key: string
  description?: string
  updatedAt?: string
}

export interface SpaceVariable {
  key: string
  value?: string
  description?: string
  updatedAt?: string
}

export interface BillingUsage {
  periodStart?: string
  periodEnd?: string
  /** Tolerant of shape drift: generic labeled rows for display. */
  rows: { label: string; detail?: string; amountCents?: number }[]
}
