import type {
  AccessRequest,
  ActivityFeed,
  BillingUsage,
  CanPostResult,
  CollectionDetail,
  CollectionSummary,
  DatasetRows,
  DatasetSplit,
  FollowedAccount,
  HubProfileSettings,
  HubProfileUpdate,
  DiscussionDetail,
  DiscussionStatusFilter,
  DiscussionSummary,
  DiscussionType,
  FileTextResult,
  FileTreeEntry,
  MyRepoEntry,
  NotificationsPage,
  Page,
  PaperSummary,
  PostComment,
  PostSummary,
  RepoAccessGate,
  RepoDetail,
  RepoKind,
  RepoSummary,
  SafetensorsHeader,
  SafetensorsTensor,
  SearchQuery,
  SpaceSecret,
  SpaceVariable,
  UserOverview,
  UserProfile,
  UserSearchResult,
  WatchedEntry,
  OrgSearchResult,
  PaperSearchResult,
  CollectionSearchResult
} from '@oh-my-huggingface/shared'
import {
  DEFAULT_HUB_ENDPOINT,
  hubRelativeUrl,
  normalizeHubEndpoint
} from '@oh-my-huggingface/shared'
import { CookieRequiredError, HubApiError, isNotFound } from './errors'
import {
  mapAccessRequest,
  mapActivityFeed,
  mapBillingUsage,
  mapCollectionDetail,
  mapCollectionSummary,
  mapDiscussionDetail,
  mapDiscussionSummary,
  mapFileTree,
  mapMyRepos,
  mapNotificationsPage,
  mapPaper,
  mapPaperComments,
  mapPaperDetail,
  mapPost,
  mapRepoDetail,
  mapRepoSummary,
  mapSpaceSecrets,
  mapSpaceVariables,
  mapUserOverview,
  mapWhoAmI,
  mapWhoAmIAuth,
  parseAskAccessForm,
  parseDatasetSampleRows,
  parsePostComments,
  parseProfileSettingsPage,
  type WhoAmIDetailed
} from './mappers'

export const DEFAULT_ENDPOINT = DEFAULT_HUB_ENDPOINT

export const DATASETS_SERVER = 'https://datasets-server.huggingface.co'

export const API_PATH: Record<RepoKind, string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces'
}

/** URL prefix used by resolve/tree URLs ("" for models, "datasets/"…). */
export const RESOLVE_PREFIX: Record<RepoKind, string> = {
  model: '',
  dataset: 'datasets/',
  space: 'spaces/'
}

const SORT_PARAM: Record<SearchQuery['sort'], string> = {
  trending: 'trendingScore',
  downloads: 'downloads',
  likes: 'likes',
  updated: 'lastModified',
  created: 'createdAt'
}

const LIST_EXPAND: Record<RepoKind, string[]> = {
  model: [
    'downloads',
    'likes',
    'lastModified',
    'createdAt',
    'pipeline_tag',
    'library_name',
    'tags',
    'private',
    'gated',
    'trendingScore',
    'safetensors'
  ],
  dataset: [
    'downloads',
    'likes',
    'lastModified',
    'createdAt',
    'tags',
    'private',
    'gated',
    'trendingScore'
  ],
  space: [
    'likes',
    'lastModified',
    'createdAt',
    'tags',
    'private',
    'sdk',
    'trendingScore',
    'cardData',
    'runtime'
  ]
}

export interface HubClientOptions {
  endpoint?: string
  userAgent?: string
  fetchImpl?: typeof fetch
  /** TTL for the in-memory GET cache. 0 disables caching. */
  cacheTtlMs?: number
  /** Maximum number of requests in flight at once. */
  maxConcurrent?: number
  /** Minimum delay between request starts, spreading bursts to dodge rate limits. */
  minRequestGapMs?: number
  /** Retries for 429/503 responses, in addition to the initial attempt. */
  maxRetries?: number
  /** Called on every request; return undefined when signed out. */
  getAccessToken?: () => string | undefined
  /**
   * Hub web-session cookie (the huggingface.co `token` cookie value), for the
   * social writes the Hub blocks for Bearer tokens. Return undefined when no
   * web session is connected.
   */
  getSessionCookie?: () => string | undefined
}

interface CacheEntry {
  at: number
  status: number
  body: unknown
  nextUrl?: string
}

function parseLinkNext(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (m) return m[1]
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const RETRY_AFTER_CAP_MS = 60_000

/** Retry-After is either seconds or an HTTP date; without it, full-jitter backoff from 1s. */
function retryDelayMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_CAP_MS)
    }
    const date = Date.parse(header)
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_CAP_MS)
    }
  }
  return Math.min(Math.random() * 1000 * 2 ** attempt, RETRY_AFTER_CAP_MS)
}

/** Failures where an expired cache entry is still better than an error. */
function isTransientFailure(err: unknown): boolean {
  if (!(err instanceof HubApiError)) return true // network-level failure
  return err.status === 429 || err.status === 503
}

/** Total file size: Content-Range "bytes 0-x/TOTAL" wins over Content-Length. */
function totalSizeFrom(res: Response, received: number): number {
  const total = res.headers.get('Content-Range')?.match(/\/(\d+)$/)?.[1]
  if (total) return Number(total)
  const length = Number(res.headers.get('Content-Length'))
  return Number.isFinite(length) && length > 0 ? length : received
}

/**
 * Stream at most maxBytes from a response body, cancelling the remainder.
 * `capped` reports whether bytes past the limit were actually dropped, for
 * servers that omit Content-Length (chunked transfer).
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number
): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    return bytes.byteLength > maxBytes
      ? { bytes: bytes.slice(0, maxBytes), capped: true }
      : { bytes, capped: false }
  }
  const chunks: Uint8Array[] = []
  let received = 0
  let capped = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    if (received > maxBytes) {
      capped = true
      await reader.cancel().catch(() => undefined)
      break
    }
  }
  const bytes = new Uint8Array(Math.min(received, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.byteLength - offset)
    bytes.set(take === chunk.byteLength ? chunk : chunk.subarray(0, take), offset)
    offset += take
    if (offset === bytes.byteLength) break
  }
  return { bytes, capped }
}

/** Sanity cap when draining Link-header pagination, bounding runaway fan-out. */
const LINK_DRAIN_MAX_PAGES = 50

const MAX_CELL_CHARS = 200

/** Pre-stringify a dataset cell for display, truncating long values. */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text
}

const SAFETENSORS_MAX_HEADER_BYTES = 8 * 1024 * 1024

/**
 * When a server ignores a Range header (200), fetchFileRange can only read from
 * offset 0. Reads whose end lands past this ceiling are refused so a
 * range-ignoring endpoint can never buffer a large file into memory.
 */
const RANGE_FALLBACK_MAX = 64 * 1024 * 1024

/** PR diffs beyond this length are truncated before reaching the renderer. */
const DIFF_MAX_CHARS = 2 * 1024 * 1024

/** Bounds for the Space log SSE snapshot: stop after this many bytes or this long. */
const SPACE_LOGS_MAX_BYTES = 64 * 1024
const SPACE_LOGS_WINDOW_MS = 2500

/** Gated-access management only exists for models and datasets. */
type GatedRepoKind = Extract<RepoKind, 'model' | 'dataset'>

/** Watch targets are addressed by their 24-hex internal id. */
interface WatchTarget {
  /**
   * The account HANDLE — username or org name — NOT the 24-hex internal id.
   * Live-verified 2026-07-11: /api/settings/watch keys add/delete on the
   * handle (`{id: "Juanxi"}`); sending the internal id is silently ignored.
   */
  id: string
  type: 'user' | 'org'
}

/** Concatenates the `data:` payload lines of a raw SSE stream into plain text. */
function sseDataText(raw: string): string {
  const lines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length)
    lines.push(payload.startsWith(' ') ? payload.slice(1) : payload)
  }
  return lines.join('\n')
}

/** Pull a short Hub error string out of a failed response body for toast/log detail. */
async function hubErrorDetail(res: Response): Promise<string> {
  let text: string
  try {
    text = (await res.text()).trim()
  } catch {
    return ''
  }
  if (!text) return ''
  // HTML error pages (CSRF/WAF 403s) are useless in toasts — keep statusText only.
  if (
    /^<!doctype\b/i.test(text) ||
    /^<html[\s>]/i.test(text) ||
    /<html[\s>]/i.test(text.slice(0, 200))
  ) {
    return ''
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
    const msg =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.message === 'string'
          ? parsed.message
          : undefined
    if (msg) {
      const oneLine = msg.replace(/\s+/g, ' ').trim()
      return oneLine ? `: ${oneLine.slice(0, 240)}` : ''
    }
  } catch {
    // not JSON — fall through to a raw snippet
  }
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 240)
  return snippet ? `: ${snippet}` : ''
}

/** Name=value pairs from Set-Cookie response headers (attributes stripped). */
function cookiePairsFromResponse(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] }
  const lines =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (() => {
          const one = res.headers.get('set-cookie')
          return one ? [one] : []
        })()
  const pairs: string[] = []
  for (const line of lines) {
    const pair = line.split(';', 1)[0]?.trim()
    if (pair && pair.includes('=')) pairs.push(pair)
  }
  return pairs
}

/**
 * Build a Cookie request header from a stored Hub web session.
 * Accepts legacy raw token values (`abc`) or a full jar (`token=abc; csrf=…`).
 */
export function formatSessionCookie(session: string, extras: string[] = []): string {
  const base = /\btoken=/i.test(session) ? session : `token=${session}`
  const seen = new Set(
    base
      .split(';')
      .map((p) => p.trim().split('=', 1)[0]?.toLowerCase())
      .filter((n): n is string => Boolean(n))
  )
  const extraParts: string[] = []
  for (const pair of extras) {
    const name = pair.split('=', 1)[0]?.trim().toLowerCase()
    if (!name || name === 'token' || seen.has(name)) continue
    seen.add(name)
    extraParts.push(pair)
  }
  return extraParts.length === 0 ? base : `${base}; ${extraParts.join('; ')}`
}

/**
 * Thin, cached client over the Hub REST API. All requests carry a descriptive
 * User-Agent and are centrally cached so UI-driven refetches never hammer the API.
 * Every fetch funnels through a global limiter (concurrency cap + start gap) with
 * 429/503 retries, and expired cache entries are served when a refresh fails.
 */
export class HubClient {
  private readonly endpoint: string
  private readonly endpointHost: string
  private readonly userAgent: string
  private readonly fetchImpl: typeof fetch
  private readonly cacheTtlMs: number
  private readonly maxConcurrent: number
  private readonly minRequestGapMs: number
  private readonly maxRetries: number
  private readonly getAccessToken: () => string | undefined
  private readonly getSessionCookie: () => string | undefined
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<unknown>>()
  private active = 0
  private nextStartAt = 0
  private readonly slotWaiters: Array<() => void> = []

  constructor(options: HubClientOptions = {}) {
    const requestedEndpoint = options.endpoint ?? DEFAULT_ENDPOINT
    let endpoint = requestedEndpoint.replace(/\/$/, '')
    try {
      endpoint = normalizeHubEndpoint(requestedEndpoint)
    } catch {
      // Preserve the historical invalid-endpoint behavior used by the auth
      // allow-list hardening path; application settings are schema-validated.
    }
    this.endpoint = endpoint
    let endpointHost = ''
    try {
      endpointHost = new URL(this.endpoint).hostname
    } catch {
      // Non-URL endpoint: auth only attaches to *.huggingface.co hosts.
    }
    this.endpointHost = endpointHost
    this.userAgent = options.userAgent ?? 'oh-my-huggingface (unofficial desktop client)'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4)
    this.minRequestGapMs = Math.max(0, options.minRequestGapMs ?? 120)
    this.maxRetries = Math.max(0, options.maxRetries ?? 2)
    this.getAccessToken = options.getAccessToken ?? (() => undefined)
    this.getSessionCookie = options.getSessionCookie ?? (() => undefined)
  }

  get baseUrl(): string {
    return this.endpoint
  }

  /** Never send the token to hosts other than the configured endpoint or *.huggingface.co. */
  private allowsAuth(url: string): boolean {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return false
    }
    return (
      (this.endpointHost !== '' && host === this.endpointHost) ||
      host === 'huggingface.co' ||
      host.endsWith('.huggingface.co')
    )
  }

  /**
   * `auth: 'cookie'` authenticates as the Hub web session instead of the
   * Bearer token — required for the social writes the Hub blocks for tokens
   * (like, post reactions/comments, watch, discussion reactions; live-verified
   * 2026-07-11) and for the personalized following feed GET (Bearer returns
   * 401 "Invalid username or password"; live-verified 2026-08-23). Cookie
   * requests deliberately omit Authorization (the Hub would prefer the header
   * and 401), and carry Origin/Referer like the first-party web app. Throws
   * CookieRequiredError before any I/O when no web session is connected.
   */
  private headers(
    url: string,
    auth: 'token' | 'cookie' = 'token',
    opts: { referer?: string; extraCookies?: string[] } = {}
  ): Record<string, string> {
    const h: Record<string, string> = { 'User-Agent': this.userAgent }
    if (auth === 'cookie') {
      const cookie = this.getSessionCookie()
      if (!cookie || !this.allowsAuth(url)) throw new CookieRequiredError(url)
      h.Cookie = formatSessionCookie(cookie, opts.extraCookies)
      h.Origin = this.endpoint
      h.Referer = opts.referer ?? `${this.endpoint}/`
      return h
    }
    const token = this.getAccessToken()
    if (token && this.allowsAuth(url)) h.Authorization = `Bearer ${token}`
    return h
  }

  private cacheKey(url: string, auth: 'token' | 'cookie' = 'token'): string {
    // Token presence changes private/gated GETs. Cookie GETs (following feed)
    // are account-specific and must not share the token/anon partition.
    if (auth === 'cookie') return `cookie:${url}`
    return `${this.getAccessToken() ? 'auth' : 'anon'}:${url}`
  }

  invalidateCache(): void {
    this.cache.clear()
  }

  /** Admits a request start: caps concurrency and spaces starts by minRequestGapMs. */
  private async acquireSlot(): Promise<void> {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve))
    }
    this.active += 1
    const startAt = Math.max(Date.now(), this.nextStartAt)
    this.nextStartAt = startAt + this.minRequestGapMs
    const delay = startAt - Date.now()
    if (delay > 0) await sleep(delay)
  }

  private releaseSlot(): void {
    this.active -= 1
    this.slotWaiters.shift()?.()
  }

  /** All network access funnels through here: limiter plus 429/503 retry with Retry-After. */
  private async fetchWithPolicy(
    url: string,
    init?: RequestInit,
    opts: { retryStatuses?: number[] } = {}
  ): Promise<Response> {
    const retryStatuses = opts.retryStatuses ?? [429, 503]
    for (let attempt = 0; ; attempt++) {
      await this.acquireSlot()
      let res: Response
      try {
        res = await this.fetchImpl(url, init)
      } finally {
        this.releaseSlot()
      }
      if (retryStatuses.includes(res.status) && attempt < this.maxRetries) {
        void res.body?.cancel().catch(() => undefined)
        await sleep(retryDelayMs(res.headers.get('Retry-After'), attempt))
        continue
      }
      return res
    }
  }

  private async throwHttpError(res: Response, method: string, url: string): Promise<never> {
    const rate = res.status === 429 ? ' (rate limited)' : ''
    // Hub often puts the real reason on HTML error pages in this header
    // (e.g. profile primaryOrg → "This organization is not a paid organization").
    const headerMsg = (
      res.headers.get('x-error-message') ??
      res.headers.get('X-Error-Message') ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
    const hubDetail = headerMsg ? `: ${headerMsg.slice(0, 240)}` : await hubErrorDetail(res)
    throw new HubApiError(
      `${method} ${url} failed: ${res.status} ${res.statusText}${rate}${hubDetail}`,
      res.status,
      url
    )
  }

  /**
   * Authenticated JSON mutation. Retries only 429s (a 503 may already have
   * applied side effects) and invalidates the GET cache after every success,
   * so the next read reflects the change.
   */
  private async sendJson(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    opts: { auth?: 'token' | 'cookie' } = {}
  ): Promise<Response> {
    const res = await this.fetchWithPolicy(
      url,
      {
        method,
        headers: {
          ...this.headers(url, opts.auth),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      },
      { retryStatuses: [429] }
    )
    if (!res.ok) await this.throwHttpError(res, method, url)
    this.invalidateCache()
    return res
  }

  private async getJson<T>(
    url: string,
    opts: { ttl?: number; auth?: 'token' | 'cookie' } = {}
  ): Promise<{
    body: T
    nextUrl?: string
  }> {
    const ttl = opts.ttl ?? this.cacheTtlMs
    const auth = opts.auth ?? 'token'
    const key = this.cacheKey(url, auth)
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < ttl) {
      return { body: hit.body as T, nextUrl: hit.nextUrl }
    }
    // Coalesce identical concurrent GETs into a single request.
    const inflightKey = `json:${key}`
    const pending = this.inflight.get(inflightKey)
    if (pending) return pending as Promise<{ body: T; nextUrl?: string }>
    const request = this.fetchJson<T>(url, key, ttl, auth).finally(() => {
      this.inflight.delete(inflightKey)
    })
    this.inflight.set(inflightKey, request)
    return request
  }

  private async fetchJson<T>(
    url: string,
    key: string,
    ttl: number,
    auth: 'token' | 'cookie' = 'token'
  ): Promise<{ body: T; nextUrl?: string }> {
    try {
      const res = await this.fetchWithPolicy(url, { headers: this.headers(url, auth) })
      if (!res.ok) await this.throwHttpError(res, 'GET', url)
      const body = (await res.json()) as T
      const nextUrl = parseLinkNext(res.headers.get('Link'))
      if (ttl > 0) this.cache.set(key, { at: Date.now(), status: res.status, body, nextUrl })
      return { body, nextUrl }
    } catch (err) {
      // Stale-on-error: an expired entry beats surfacing a transient failure.
      const stale = this.cache.get(key)
      if (stale && isTransientFailure(err)) return { body: stale.body as T, nextUrl: stale.nextUrl }
      throw err
    }
  }

  private async getText(url: string): Promise<string> {
    const key = this.cacheKey(url)
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.body as string
    const inflightKey = `text:${key}`
    const pending = this.inflight.get(inflightKey)
    if (pending) return pending as Promise<string>
    const request = this.fetchText(url, key).finally(() => {
      this.inflight.delete(inflightKey)
    })
    this.inflight.set(inflightKey, request)
    return request
  }

  private async fetchText(url: string, key: string): Promise<string> {
    try {
      const res = await this.fetchWithPolicy(url, { headers: this.headers(url) })
      if (!res.ok) await this.throwHttpError(res, 'GET', url)
      const body = await res.text()
      if (this.cacheTtlMs > 0) this.cache.set(key, { at: Date.now(), status: res.status, body })
      return body
    } catch (err) {
      const stale = this.cache.get(key)
      if (stale && isTransientFailure(err)) return stale.body as string
      throw err
    }
  }

  /** Ranged GET returning the requested byte window even when the server ignores Range. */
  private async fetchRange(url: string, start: number, end: number): Promise<Uint8Array> {
    const res = await this.fetchWithPolicy(url, {
      headers: {
        ...this.headers(url),
        Range: `bytes=${start}-${end}`,
        'Accept-Encoding': 'identity'
      }
    })
    if (res.status !== 200 && res.status !== 206) await this.throwHttpError(res, 'GET', url)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const want = end - start + 1
    return res.status === 200 && bytes.byteLength > want ? bytes.slice(start, end + 1) : bytes
  }

  /** Build the search URL for a query; exposed for tests. */
  buildSearchUrl(query: SearchQuery): string {
    const url = new URL(`${this.endpoint}/api/${API_PATH[query.kind]}`)
    if (query.search) url.searchParams.set('search', query.search)
    if (query.author) url.searchParams.set('author', query.author)
    if (query.pipelineTag) url.searchParams.set('pipeline_tag', query.pipelineTag)
    if (query.library) url.searchParams.set('library', query.library)
    for (const tag of query.tags ?? []) url.searchParams.append('filter', tag)
    if (query.license) url.searchParams.append('filter', `license:${query.license}`)
    if (query.inferenceProvider && query.kind === 'model') {
      url.searchParams.set('inference_provider', query.inferenceProvider)
    }
    url.searchParams.set('sort', SORT_PARAM[query.sort])
    url.searchParams.set('direction', '-1')
    url.searchParams.set('limit', String(query.limit ?? 30))
    for (const field of LIST_EXPAND[query.kind]) url.searchParams.append('expand[]', field)
    return url.toString()
  }

  async searchRepos(query: SearchQuery): Promise<Page<RepoSummary>> {
    const url = query.cursor ?? this.buildSearchUrl(query)
    const { body, nextUrl } = await this.getJson<unknown[]>(url)
    return {
      items: body.map((raw) => mapRepoSummary(raw as never, query.kind)),
      nextCursor: nextUrl
    }
  }

  async getRepoDetail(kind: RepoKind, repoId: string, revision?: string): Promise<RepoDetail> {
    const revisionSuffix = revision ? `/revision/${encodeURIComponent(revision)}` : ''
    const url = `${this.endpoint}/api/${API_PATH[kind]}/${repoId}${revisionSuffix}`
    const { body } = await this.getJson<unknown>(url)
    return mapRepoDetail(body as never, kind)
  }

  resolveUrl(kind: RepoKind, repoId: string, revision: string, path: string): string {
    const rev = encodeURIComponent(revision)
    const p = path.split('/').map(encodeURIComponent).join('/')
    return `${this.endpoint}/${RESOLVE_PREFIX[kind]}${repoId}/resolve/${rev}/${p}`
  }

  /** Fetch README.md via the resolve URL. Returns '' when the repo has no card. */
  async getReadme(kind: RepoKind, repoId: string, revision = 'main'): Promise<string> {
    try {
      return await this.getText(this.resolveUrl(kind, repoId, revision, 'README.md'))
    } catch (err) {
      if (isNotFound(err)) return ''
      throw err
    }
  }

  /** Lists a tree level (or the whole tree with `recursive`), draining Link-header pagination. */
  async getFileTree(
    kind: RepoKind,
    repoId: string,
    revision = 'main',
    path = '',
    opts: { recursive?: boolean } = {}
  ): Promise<FileTreeEntry[]> {
    const rev = encodeURIComponent(revision)
    const suffix = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''
    let url: string | undefined =
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/tree/${rev}${suffix}` +
      (opts.recursive ? '?recursive=true' : '')
    const all: FileTreeEntry[] = []
    while (url) {
      const page: { body: never[]; nextUrl?: string } = await this.getJson<never[]>(url)
      all.push(...mapFileTree(page.body))
      url = page.nextUrl
    }
    return all
  }

  async getDailyPapers(cursor?: string): Promise<Page<PaperSummary>> {
    const url = cursor ?? `${this.endpoint}/api/daily_papers?limit=50`
    const { body, nextUrl } = await this.getJson<unknown[]>(url)
    return { items: (body as never[]).map(mapPaper), nextCursor: nextUrl }
  }

  /** Single paper lookup (deep links to papers outside the daily feed). */
  async getPaper(paperId: string): Promise<PaperSummary> {
    const url = `${this.endpoint}/api/papers/${encodeURIComponent(paperId)}`
    const { body } = await this.getJson<unknown>(url, { ttl: 60_000 })
    return mapPaperDetail(body as never)
  }

  /**
   * Existing comment thread on a Daily Papers entry. Unlike community posts,
   * this is a clean public JSON endpoint (sparse fieldset: `field=comments`) —
   * no HTML scraping needed (openapi.json, live-verified 2026-07-13).
   */
  async getPaperComments(paperId: string): Promise<PostComment[]> {
    const url = `${this.endpoint}/api/papers/${encodeURIComponent(paperId)}?field=comments`
    const { body } = await this.getJson<unknown>(url, { ttl: 10_000 })
    return mapPaperComments(body as never)
  }

  /**
   * One page of discussions/PRs. The endpoint paginates by a 0-based `p`
   * param and reports progress via `start`/`count` in the body; `nextCursor`
   * is the ready-to-fetch next-page URL (pass it back as `opts.cursor`).
   */
  async listDiscussions(
    kind: RepoKind,
    repoId: string,
    opts: { type?: DiscussionType; status?: DiscussionStatusFilter; cursor?: string } = {}
  ): Promise<Page<DiscussionSummary>> {
    let url = opts.cursor
    if (!url) {
      const first = new URL(`${this.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions`)
      if (opts.type) first.searchParams.set('type', opts.type)
      if (opts.status) first.searchParams.set('status', opts.status)
      url = first.toString()
    }
    const { body, nextUrl } = await this.getJson<{
      discussions?: unknown[]
      count?: number
      start?: number
    }>(url)
    const items = (body.discussions ?? []).map((d) => mapDiscussionSummary(d as never))
    let nextCursor = nextUrl
    if (!nextCursor && items.length > 0 && body.count !== undefined) {
      const seen = (body.start ?? 0) + items.length
      if (seen < body.count) {
        const next = new URL(url)
        const p = Number(next.searchParams.get('p') ?? '0')
        next.searchParams.set('p', String(p + 1))
        nextCursor = next.toString()
      }
    }
    return { items, nextCursor }
  }

  /**
   * Raw unified diff of a pull request, capped at DIFF_MAX_CHARS. Returns ''
   * when the discussion exposes no diffUrl (plain discussions, drafts).
   */
  async getDiscussionDiff(kind: RepoKind, repoId: string, num: number): Promise<string> {
    const url = `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}`
    const { body } = await this.getJson<{ diffUrl?: string }>(url, { ttl: 5_000 })
    if (!body.diffUrl) return ''
    const diffUrl = hubRelativeUrl(body.diffUrl, this.endpoint)
    const diff = await this.getText(diffUrl)
    if (diff.length <= DIFF_MAX_CHARS) return diff
    return `${diff.slice(0, DIFF_MAX_CHARS)}\n... (diff truncated)`
  }

  /**
   * Community posts feed. The endpoint sends no Link header, so pagination
   * advances a skip cursor by the number of items actually received (the
   * server may return fewer than the requested limit).
   */
  async getPosts(cursor?: string): Promise<Page<PostSummary>> {
    const url = cursor ?? `${this.endpoint}/api/posts?limit=30`
    const { body, nextUrl } = await this.getJson<{
      socialPosts?: unknown[]
      numTotalItems?: number
    }>(url)
    const items = (body.socialPosts ?? []).map((raw) => mapPost(raw as never, this.endpoint))
    let nextCursor = nextUrl
    if (!nextCursor && items.length > 0) {
      const next = new URL(url)
      const skip = Number(next.searchParams.get('skip') ?? '0') + items.length
      if (body.numTotalItems === undefined || skip < body.numTotalItems) {
        next.searchParams.set('skip', String(skip))
        nextCursor = next.toString()
      }
    }
    return { items, nextCursor }
  }

  /**
   * Personalized "following" activity feed — the real huggingface.co home feed.
   * Live-verified 2026-08-23: Bearer access tokens get 401 "Invalid username or
   * password" (same as likes/comments). Cookie-session only. Paginates by an
   * opaque cursor plus an advancing skip; `cursor` in the return is the
   * next-page URL.
   */
  async getRecentActivity(cursor?: string): Promise<ActivityFeed> {
    const url =
      cursor ?? `${this.endpoint}/api/recent-activity?limit=30&feedType=following&activityType=all`
    if (!this.getSessionCookie() || !this.allowsAuth(url)) throw new CookieRequiredError(url)
    const { body } = await this.getJson<{ recentActivity?: unknown[]; cursor?: string }>(url, {
      auth: 'cookie'
    })
    const feed = mapActivityFeed(body as never, this.endpoint)
    let nextCursor: string | undefined
    if (feed.cursor && (body.recentActivity?.length ?? 0) > 0) {
      const next = new URL(url)
      const skip = Number(next.searchParams.get('skip') ?? '0') + (body.recentActivity?.length ?? 0)
      next.searchParams.set('skip', String(skip))
      next.searchParams.set('cursor', feed.cursor)
      nextCursor = next.toString()
    }
    return { items: feed.items, cursor: nextCursor }
  }

  async getDiscussion(kind: RepoKind, repoId: string, num: number): Promise<DiscussionDetail> {
    const url = `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}`
    const { body } = await this.getJson<unknown>(url, { ttl: 5_000 })
    return mapDiscussionDetail(body as never)
  }

  async commentOnDiscussion(
    kind: RepoKind,
    repoId: string,
    num: number,
    comment: string
  ): Promise<void> {
    await this.sendJson(
      'POST',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}/comment`,
      { comment }
    )
  }

  /**
   * Open a new discussion (or draft PR, like huggingface_hub's
   * create_discussion/create_pull_request — same endpoint, `pullRequest`
   * flag). Bearer-token authenticated; returns the new thread number.
   */
  async createDiscussion(
    kind: RepoKind,
    repoId: string,
    title: string,
    description: string,
    pullRequest = false
  ): Promise<{ num: number }> {
    const res = await this.sendJson(
      'POST',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions`,
      { title, description, pullRequest }
    )
    const body = (await res.json().catch(() => ({}))) as { num?: number }
    return { num: body.num ?? 0 }
  }

  async whoAmI(): Promise<UserProfile> {
    const { body } = await this.getJson<unknown>(`${this.endpoint}/api/whoami-v2`, { ttl: 0 })
    return mapWhoAmI(body as never, this.endpoint)
  }

  /**
   * whoAmI with an explicit bearer token, for validating a pasted User Access
   * Token before it becomes the session. Deliberately OUT OF BAND: it skips
   * the response cache and the in-flight dedup (which key on URL, so a regular
   * whoAmI here could join the CURRENT session token's request and "validate"
   * the candidate against someone else's response), skips the request-slot
   * queue (validation must not starve behind stalled browsing requests), and
   * carries its own deadline — a Hub that never answers must fail the sign-in,
   * not spin it forever.
   */
  async whoAmIWithToken(token: string, opts: { timeoutMs?: number } = {}): Promise<WhoAmIDetailed> {
    const url = `${this.endpoint}/api/whoami-v2`
    const headers: Record<string, string> = { 'User-Agent': this.userAgent }
    if (this.allowsAuth(url)) headers.Authorization = `Bearer ${token}`
    const res = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000)
    })
    if (!res.ok) {
      await this.throwHttpError(res, 'GET', url)
    }
    return mapWhoAmIAuth((await res.json()) as never, this.endpoint)
  }

  /**
   * whoAmI with an explicit web-session cookie, for validating a captured
   * Hub login before it becomes the supplemental credential. Same out-of-band
   * rules as whoAmIWithToken: no cache, no dedup, no slot queue, own deadline.
   */
  async whoAmIWithCookie(
    cookie: string,
    opts: { timeoutMs?: number } = {}
  ): Promise<WhoAmIDetailed> {
    const url = `${this.endpoint}/api/whoami-v2`
    const headers: Record<string, string> = { 'User-Agent': this.userAgent }
    if (this.allowsAuth(url)) headers.Cookie = formatSessionCookie(cookie)
    const res = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000)
    })
    if (!res.ok) {
      await this.throwHttpError(res, 'GET', url)
    }
    return mapWhoAmIAuth((await res.json()) as never, this.endpoint)
  }

  /** Paged notification inbox (20/page on the Hub; `p` is zero-based). */
  async getNotifications(page = 0): Promise<NotificationsPage> {
    const url = new URL(`${this.endpoint}/api/notifications`)
    if (page > 0) url.searchParams.set('p', String(page))
    const { body } = await this.getJson<unknown>(url.toString(), { ttl: 10_000 })
    return mapNotificationsPage(body as never, this.endpoint)
  }

  /**
   * Marks discussions read/unread; an empty id list applies to all
   * notifications. Discussion ids are the ONLY per-item handle the Hub offers:
   * notifications carry no id of their own and there is no
   * mark-read-by-notification-id endpoint (openapi.json, verified 2026-07-12 —
   * every notification variant is additionalProperties:false with just
   * type/updatedAt/read/discussionEventId plus the type payload, and this
   * endpoint's body accepts only discussionIds). Notifications without a
   * discussion-backed id can therefore only be cleared by the applyToAll form.
   */
  async markNotificationsRead(discussionIds: string[], read: boolean): Promise<void> {
    const all = discussionIds.length === 0
    const url = `${this.endpoint}/api/notifications/mark-as-read${all ? '?applyToAll=true' : ''}`
    await this.sendJson('POST', url, all ? { read } : { discussionIds, read })
  }

  /** Deletes all notifications (the API only accepts explicit ids or applyToAll). */
  async clearNotifications(): Promise<void> {
    await this.sendJson('DELETE', `${this.endpoint}/api/notifications?applyToAll=true`)
  }

  /** List repos for an author, used by the follow poller. */
  async listByAuthor(kind: RepoKind, author: string, limit = 20): Promise<RepoSummary[]> {
    const page = await this.searchRepos({ kind, author, sort: 'updated', limit })
    return page.items
  }

  /** Fetch a text file (size-capped) for in-app preview. Throws on binary content. */
  async getFileText(
    kind: RepoKind,
    repoId: string,
    path: string,
    revision = 'main',
    maxBytes = 512 * 1024
  ): Promise<FileTextResult> {
    const url = this.resolveUrl(kind, repoId, revision, path)
    const res = await this.fetchWithPolicy(url, {
      headers: {
        ...this.headers(url),
        Range: `bytes=0-${maxBytes - 1}`,
        // Byte ranges are only meaningful without transfer compression.
        'Accept-Encoding': 'identity'
      }
    })
    if (res.status !== 200 && res.status !== 206) await this.throwHttpError(res, 'GET', url)
    // A 200 means the server ignored the Range; cap the read so maxBytes still holds.
    const { bytes, capped } =
      res.status === 200
        ? await readBodyCapped(res, maxBytes)
        : { bytes: new Uint8Array(await res.arrayBuffer()), capped: false }
    if (bytes.includes(0)) throw new HubApiError('binary file', undefined, url)
    const size = totalSizeFrom(res, bytes.byteLength)
    return {
      content: new TextDecoder().decode(bytes),
      truncated: capped || size > bytes.byteLength,
      size
    }
  }

  /**
   * Raw authenticated GET of a repo file via its resolve URL, returning the
   * streaming Response. Backs the desktop app's omhf-file:// protocol so
   * private/gated repo images render in-app — a direct <img> pointing at the
   * https resolve URL carries no Authorization header and 401s. Same
   * limiter/retry/auth policy as every other request; the caller consumes
   * (or cancels) the body.
   */
  async fetchFileResponse(
    kind: RepoKind,
    repoId: string,
    path: string,
    revision = 'main'
  ): Promise<Response> {
    const url = this.resolveUrl(kind, repoId, revision, path)
    const res = await this.fetchWithPolicy(url, { headers: this.headers(url) })
    if (!res.ok) await this.throwHttpError(res, 'GET', url)
    return res
  }

  /**
   * Authenticated byte-range read of a repo file, `start`..`end` inclusive
   * (HTTP Range semantics). Backs the renderer's parquet AsyncBuffer so a large
   * columnar file previews by fetching only its footer plus the visible rows,
   * never the whole file. The window is bounded by the IPC schema (< 64 MiB),
   * so a 206 buffers at most that. If the server ignores the Range and replies
   * 200, the only bytes reachable are from offset 0; a deep offset (e.g. a
   * footer read near EOF) would require buffering the whole file, so such a
   * read is refused past a hard ceiling rather than pulling the file into
   * memory — the caller degrades to a download prompt.
   */
  async fetchFileRange(
    kind: RepoKind,
    repoId: string,
    path: string,
    start: number,
    end: number,
    revision = 'main'
  ): Promise<Uint8Array> {
    const url = this.resolveUrl(kind, repoId, revision, path)
    const res = await this.fetchWithPolicy(url, {
      headers: {
        ...this.headers(url),
        Range: `bytes=${start}-${end}`,
        // Byte ranges are only meaningful without transfer compression.
        'Accept-Encoding': 'identity'
      }
    })
    if (res.status !== 200 && res.status !== 206) await this.throwHttpError(res, 'GET', url)
    // 206: the server honored the Range, so the body is exactly [start, end],
    // bounded by the schema's window cap.
    if (res.status === 206) return new Uint8Array(await res.arrayBuffer())
    // 200: the server ignored the Range. Reaching byte `end` means reading from
    // 0, so a deep offset would buffer (nearly) the whole file — refuse it.
    if (end >= RANGE_FALLBACK_MAX) {
      await res.body?.cancel()
      throw new HubApiError('server does not support range requests', res.status, url)
    }
    const { bytes } = await readBodyCapped(res, end + 1)
    return bytes.slice(start, end + 1)
  }

  /** Parse the safetensors JSON header via ranged requests (never downloads tensors). */
  async getSafetensorsHeader(
    kind: RepoKind,
    repoId: string,
    path: string,
    revision = 'main'
  ): Promise<SafetensorsHeader> {
    const url = this.resolveUrl(kind, repoId, revision, path)
    const lenBytes = await this.fetchRange(url, 0, 7)
    if (lenBytes.byteLength < 8) {
      throw new HubApiError('safetensors: file too short for a header', undefined, url)
    }
    // First 8 bytes are the little-endian u64 length of the JSON header.
    const headerLen = new DataView(lenBytes.buffer, lenBytes.byteOffset, 8).getBigUint64(0, true)
    if (headerLen <= 0n || headerLen > BigInt(SAFETENSORS_MAX_HEADER_BYTES)) {
      throw new HubApiError(`safetensors: implausible header length ${headerLen}`, undefined, url)
    }
    const len = Number(headerLen)
    const jsonBytes = await this.fetchRange(url, 8, 8 + len - 1)
    const parsed = JSON.parse(new TextDecoder().decode(jsonBytes)) as Record<string, unknown>
    let metadata: Record<string, string> | undefined
    const tensors: SafetensorsTensor[] = []
    let totalParams = 0
    for (const [name, value] of Object.entries(parsed)) {
      if (name === '__metadata__') {
        metadata = value as Record<string, string>
        continue
      }
      const entry = value as { dtype?: string; shape?: unknown }
      const shape = Array.isArray(entry.shape)
        ? entry.shape.filter((dim): dim is number => typeof dim === 'number')
        : []
      tensors.push({ name, dtype: entry.dtype ?? '', shape })
      // A scalar (empty shape) holds one element.
      totalParams += shape.reduce((acc, dim) => acc * dim, 1)
    }
    tensors.sort((a, b) => a.name.localeCompare(b.name))
    return { tensors, metadata, totalParams }
  }

  /**
   * The signed-in account's standing with a gated repo. auth-check answers
   * whether access is already granted (live-verified 2026-07-11: 200 granted,
   * 403 not yet); when not granted, the repo page's ask-access form supplies
   * the gate questions — its absence means a manual request is pending.
   */
  async getRepoAccessGate(kind: RepoKind, repoId: string): Promise<RepoAccessGate> {
    const checkUrl = `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/auth-check`
    const res = await this.fetchWithPolicy(checkUrl, { headers: this.headers(checkUrl) })
    if (res.ok) return { status: 'granted', fields: [] }
    if (res.status !== 401 && res.status !== 403) await this.throwHttpError(res, 'GET', checkUrl)
    const page = await this.fetchRepoPage(kind, repoId)
    const form = parseAskAccessForm(page)
    return form ? { status: 'ask', fields: form.fields } : { status: 'pending', fields: [] }
  }

  /**
   * Submit the gated-repo access form exactly like the Hub web app: urlencoded
   * POST to /{repo}/ask-access with the page's csrf token plus one entry per
   * gate question (live-captured 2026-07-11). Needs a Hub web session.
   */
  async askRepoAccess(
    kind: RepoKind,
    repoId: string,
    fields: Record<string, string>
  ): Promise<void> {
    const url = `${this.endpoint}/${RESOLVE_PREFIX[kind]}${repoId}/ask-access`
    if (!this.getSessionCookie() || !this.allowsAuth(url)) throw new CookieRequiredError(url)
    const form = parseAskAccessForm(await this.fetchRepoPage(kind, repoId))
    if (!form) throw new HubApiError('the repo offers no access-request form', 409, url)
    const res = await this.fetchWithPolicy(url, {
      method: 'POST',
      headers: {
        ...this.headers(url, 'cookie'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ csrf: form.csrf, ...fields }).toString()
    })
    if (!res.ok) await this.throwHttpError(res, 'POST', url)
  }

  /**
   * SSR sample rows from the dataset page — the Hub's own preview fallback
   * when the datasets-server viewer is unavailable. Authenticated with the
   * web session when connected (gated pages embed the sample only for
   * accounts with access), the bearer token otherwise.
   */
  async getDatasetSampleRows(repoId: string): Promise<DatasetRows | undefined> {
    return parseDatasetSampleRows(await this.fetchRepoPage('dataset', repoId))
  }

  /** Repo web page HTML, uncached (carries per-account gate state and csrf). */
  private async fetchRepoPage(kind: RepoKind, repoId: string): Promise<string> {
    const url = `${this.endpoint}/${RESOLVE_PREFIX[kind]}${repoId}`
    const auth = this.getSessionCookie() ? ('cookie' as const) : ('token' as const)
    const res = await this.fetchWithPolicy(url, { headers: this.headers(url, auth) })
    if (!res.ok) await this.throwHttpError(res, 'GET', url)
    return res.text()
  }

  /** Dataset viewer config/split list via the datasets-server API. */
  async getDatasetSplits(repoId: string): Promise<DatasetSplit[]> {
    const url = `${DATASETS_SERVER}/splits?dataset=${encodeURIComponent(repoId)}`
    const { body } = await this.getJson<{ splits?: Array<{ config?: string; split?: string }> }>(
      url
    )
    return (body.splits ?? []).map((s) => ({ config: s.config ?? '', split: s.split ?? '' }))
  }

  /** Paged dataset rows via the datasets-server API. */
  async getDatasetRows(
    repoId: string,
    config: string,
    split: string,
    offset = 0,
    length = 20
  ): Promise<DatasetRows> {
    const url = new URL(`${DATASETS_SERVER}/rows`)
    url.searchParams.set('dataset', repoId)
    url.searchParams.set('config', config)
    url.searchParams.set('split', split)
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('length', String(length))
    const { body } = await this.getJson<{
      features?: Array<{ name?: string }>
      rows?: Array<{ row?: Record<string, unknown> }>
      num_rows_total?: number
    }>(url.toString())
    const columns = (body.features ?? []).map((f) => f.name ?? '')
    const rows = (body.rows ?? []).map((r) => {
      const record = r.row ?? {}
      return columns.map((col) => formatCell(record[col]))
    })
    return { columns, rows, total: body.num_rows_total }
  }

  /**
   * Single post lookup. The direct /api/posts/{author}/{slug} endpoint errors,
   * so filter the feed by slug and match the author case-insensitively.
   */
  async getPostDetail(author: string, slug: string): Promise<PostSummary> {
    const url = `${this.endpoint}/api/posts?slug=${encodeURIComponent(slug)}`
    const { body } = await this.getJson<{ socialPosts?: unknown[] }>(url, { ttl: 60_000 })
    const wanted = author.toLowerCase()
    const post = (body.socialPosts ?? [])
      .map((raw) => mapPost(raw as never, this.endpoint))
      .find((p) => p.slug === slug && p.author.toLowerCase() === wanted)
    if (!post) throw new HubApiError('post not found', 404, url)
    return post
  }

  /**
   * Public profile overview. Users and orgs share one namespace on the Hub but
   * live on different endpoints, so a 404 on /users falls back to /organizations
   * (org payloads carry `name` instead of `user`; both are handled by the mapper).
   */
  async getUserOverview(username: string): Promise<UserOverview> {
    const encoded = encodeURIComponent(username)
    try {
      const { body } = await this.getJson<unknown>(`${this.endpoint}/api/users/${encoded}/overview`)
      return mapUserOverview(body as never, this.endpoint)
    } catch (err) {
      if (!isNotFound(err)) throw err
      const { body } = await this.getJson<unknown>(
        `${this.endpoint}/api/organizations/${encoded}/overview`
      )
      return mapUserOverview(body as never, this.endpoint, true)
    }
  }

  /**
   * Organization members. The Hub returns the full list in one shot (no Link
   * pagination); we cap at 40 for the profile avatar strip.
   */
  async getOrgMembers(org: string, limit = 40): Promise<FollowedAccount[]> {
    const url = `${this.endpoint}/api/organizations/${encodeURIComponent(org)}/members`
    const { body } = await this.getJson<
      Array<{ user?: string; fullname?: string; avatarUrl?: string; type?: string }>
    >(url, { ttl: 5 * 60_000 })
    return body
      .filter((m) => m.user)
      .slice(0, limit)
      .map((m) => ({
        name: m.user ?? '',
        fullname: m.fullname,
        avatarUrl: m.avatarUrl ? hubRelativeUrl(m.avatarUrl, this.endpoint) : undefined,
        isOrg: m.type === 'org'
      }))
  }

  /**
   * Accounts a user follows on the Hub. Live-verified: paginated via Link header
   * (500/page); drained up to 4 pages (2000 accounts) to bound the fan-out.
   */
  async getUserFollowing(username: string): Promise<FollowedAccount[]> {
    let url: string | undefined =
      `${this.endpoint}/api/users/${encodeURIComponent(username)}/following`
    const all: FollowedAccount[] = []
    let pages = 0
    while (url && pages < 4) {
      const page: {
        body: Array<{ user?: string; fullname?: string; avatarUrl?: string; type?: string }>
        nextUrl?: string
      } = await this.getJson(url, { ttl: 5 * 60_000 })
      for (const raw of page.body) {
        if (!raw.user) continue
        all.push({
          name: raw.user,
          fullname: raw.fullname,
          avatarUrl: raw.avatarUrl ? hubRelativeUrl(raw.avatarUrl, this.endpoint) : undefined,
          isOrg: raw.type === 'org'
        })
      }
      url = page.nextUrl
      pages++
    }
    return all
  }

  /** User/org lookup for @mention autocompletion. Failures degrade to an empty list. */
  async searchUsers(query: string): Promise<UserSearchResult[]> {
    const url = new URL(`${this.endpoint}/api/quicksearch`)
    url.searchParams.set('q', query)
    url.searchParams.set('type', 'user')
    try {
      const { body } = await this.getJson<{
        users?: Array<{ user?: string; fullname?: string; avatarUrl?: string }>
      }>(url.toString(), { ttl: 60_000 })
      return (body.users ?? [])
        .filter((u) => u.user)
        .slice(0, 8)
        .map((u) => ({
          name: u.user ?? '',
          fullname: u.fullname,
          avatarUrl: u.avatarUrl ? hubRelativeUrl(u.avatarUrl, this.endpoint) : undefined
        }))
    } catch {
      return []
    }
  }

  /** Org lookup for command palette / search-all. Failures degrade to []. */
  async searchOrgs(query: string): Promise<OrgSearchResult[]> {
    const url = new URL(`${this.endpoint}/api/quicksearch`)
    url.searchParams.set('q', query)
    url.searchParams.set('type', 'org')
    try {
      const { body } = await this.getJson<{
        orgs?: Array<{ name?: string; fullname?: string; avatarUrl?: string }>
      }>(url.toString(), { ttl: 60_000 })
      return (body.orgs ?? [])
        .filter((o) => o.name)
        .slice(0, 8)
        .map((o) => ({
          name: o.name ?? '',
          fullname: o.fullname,
          avatarUrl: o.avatarUrl ? hubRelativeUrl(o.avatarUrl, this.endpoint) : undefined
        }))
    } catch {
      return []
    }
  }

  /** Paper lookup for command palette / search-all. Failures degrade to []. */
  async searchPapers(query: string): Promise<PaperSearchResult[]> {
    const url = new URL(`${this.endpoint}/api/quicksearch`)
    url.searchParams.set('q', query)
    url.searchParams.set('type', 'paper')
    try {
      const { body } = await this.getJson<{
        papers?: Array<{ _id?: string; id?: string }>
      }>(url.toString(), { ttl: 60_000 })
      return (body.papers ?? [])
        .filter((p) => p._id && p.id)
        .slice(0, 8)
        .map((p) => ({ id: p._id ?? '', title: p.id ?? '' }))
    } catch {
      return []
    }
  }

  /** Collection lookup for command palette / search-all. Failures degrade to []. */
  async searchCollections(query: string): Promise<CollectionSearchResult[]> {
    const url = new URL(`${this.endpoint}/api/quicksearch`)
    url.searchParams.set('q', query)
    url.searchParams.set('type', 'collection')
    try {
      const { body } = await this.getJson<{
        collections?: Array<{ _id?: string; title?: string; description?: string }>
      }>(url.toString(), { ttl: 60_000 })
      return (body.collections ?? [])
        .filter((c) => c._id && c.title)
        .slice(0, 8)
        .map((c) => ({
          slug: c._id ?? '',
          title: c.title ?? '',
          description: c.description
        }))
    } catch {
      return []
    }
  }

  /**
   * True when at least one inference provider serves the model (or the classic
   * Inference API reports it warm). Errors degrade to false so UI simply hides
   * the playground.
   */
  async isInferenceAvailable(repoId: string): Promise<boolean> {
    const url = new URL(`${this.endpoint}/api/models/${repoId}`)
    url.searchParams.append('expand[]', 'inference')
    url.searchParams.append('expand[]', 'inferenceProviderMapping')
    try {
      const { body } = await this.getJson<{
        inference?: string
        inferenceProviderMapping?: Record<string, unknown> | unknown[]
      }>(url.toString(), { ttl: 10 * 60_000 })
      const mapping = body.inferenceProviderMapping
      const providers = Array.isArray(mapping)
        ? mapping.length
        : mapping
          ? Object.keys(mapping).length
          : 0
      return providers > 0 || body.inference === 'warm'
    } catch {
      return false
    }
  }

  /** Collections owned by a user or org. */
  async listCollections(owner: string): Promise<CollectionSummary[]> {
    const url = new URL(`${this.endpoint}/api/collections`)
    url.searchParams.set('owner', owner)
    url.searchParams.set('limit', '100')
    const { body } = await this.getJson<unknown[]>(url.toString())
    return body.map((raw) => mapCollectionSummary(raw as never))
  }

  /** Full collection with items. The slug is "owner/title-slug-<24hex>". */
  async getCollection(slug: string): Promise<CollectionDetail> {
    const { body } = await this.getJson<unknown>(`${this.endpoint}/api/collections/${slug}`)
    return mapCollectionDetail(body as never)
  }

  async createCollection(input: {
    namespace: string
    title: string
    description?: string
    private: boolean
  }): Promise<CollectionDetail> {
    // HF returns 400 if description is null; omit empty/undefined entirely.
    const payload: {
      title: string
      namespace: string
      private: boolean
      description?: string
    } = {
      title: input.title,
      namespace: input.namespace,
      private: input.private
    }
    if (input.description != null && input.description !== '') {
      payload.description = input.description
    }
    const res = await this.sendJson('POST', `${this.endpoint}/api/collections`, payload)
    return mapCollectionDetail((await res.json()) as never)
  }

  async updateCollection(
    slug: string,
    patch: {
      title?: string
      description?: string
      private?: boolean
      position?: number
      theme?: string
    }
  ): Promise<void> {
    await this.sendJson('PATCH', `${this.endpoint}/api/collections/${slug}`, patch)
  }

  async deleteCollection(slug: string): Promise<void> {
    await this.sendJson('DELETE', `${this.endpoint}/api/collections/${slug}`)
  }

  async addCollectionItem(
    slug: string,
    item: { type: 'model' | 'dataset' | 'space' | 'paper'; id: string },
    note?: string
  ): Promise<void> {
    await this.sendJson('POST', `${this.endpoint}/api/collections/${slug}/items`, { item, note })
  }

  async updateCollectionItem(
    slug: string,
    itemId: string,
    patch: { note?: string; position?: number }
  ): Promise<void> {
    await this.sendJson(
      'PATCH',
      `${this.endpoint}/api/collections/${slug}/items/${encodeURIComponent(itemId)}`,
      patch
    )
  }

  async removeCollectionItem(slug: string, itemId: string): Promise<void> {
    await this.sendJson(
      'DELETE',
      `${this.endpoint}/api/collections/${slug}/items/${encodeURIComponent(itemId)}`
    )
  }

  /**
   * Watch/unwatch users and orgs by their account HANDLE (username/org name).
   * Returns the resulting watch list from the response body — which reflects
   * the mutation immediately (an add appears in its own response).
   *
   * Live-verified 2026-07-11: the endpoint keys on the handle, not the 24-hex
   * internal id — an add with the internal id returns HTTP 200 but is silently
   * ignored. Watch mutations need the web session, so this authenticates with
   * the cookie when connected and falls back to the token otherwise (reads via
   * listWatched must keep working token-only). Do not send add and delete in
   * the same call: the endpoint 400s when both are non-empty. An empty
   * add+delete also 400s.
   */
  async updateWatch(changes: {
    add?: WatchTarget[]
    delete?: WatchTarget[]
  }): Promise<WatchedEntry[]> {
    const auth = this.getSessionCookie() ? ('cookie' as const) : ('token' as const)
    const res = await this.sendJson(
      'PATCH',
      `${this.endpoint}/api/settings/watch`,
      {
        add: changes.add ?? [],
        delete: changes.delete ?? []
      },
      { auth }
    )
    const body = (await res.json().catch(() => ({}))) as {
      watched?: Array<{ _id?: string; id?: string; name?: string; type?: string }>
    }
    return (body.watched ?? []).map((w) => ({
      internalId: w._id,
      name: w.name ?? w.id ?? '',
      type: w.type === 'org' ? ('org' as const) : ('user' as const)
    }))
  }

  /**
   * Current Hub watch list. There is no GET endpoint; a no-op DELETE of a
   * nonexistent handle returns 200 with the full list (live-verified
   * 2026-07-11).
   */
  async listWatched(): Promise<WatchedEntry[]> {
    return this.updateWatch({ delete: [{ id: '\0no-such-account\0', type: 'user' }] })
  }

  /**
   * Attempt to watch/unwatch and report whether the Hub actually applied it.
   * The response reflects the change, so `applied` is decided by whether the
   * target handle is present afterward. Without a web session the Hub ignores
   * the mutation (applied: false) and callers fall back to the website Watch
   * control.
   */
  async setWatch(
    target: WatchTarget,
    watching: boolean
  ): Promise<{ applied: boolean; watched: WatchedEntry[] }> {
    const watched = await this.updateWatch(watching ? { add: [target] } : { delete: [target] })
    const handle = target.id.toLowerCase()
    const present = watched.some((w) => w.name.toLowerCase() === handle)
    return { applied: present === watching, watched }
  }

  /** Repos the signed-in user administers, with storage usage. */
  async listMyRepos(): Promise<MyRepoEntry[]> {
    const { body } = await this.getJson<unknown[]>(`${this.endpoint}/api/settings/repositories`, {
      ttl: 10_000
    })
    return mapMyRepos(body as never[])
  }

  async updateRepoSettings(
    kind: RepoKind,
    repoId: string,
    patch: { private?: boolean; gated?: false | 'auto' | 'manual'; discussionsDisabled?: boolean }
  ): Promise<void> {
    await this.sendJson('PUT', `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/settings`, patch)
  }

  async moveRepo(kind: RepoKind, fromRepo: string, toRepo: string): Promise<void> {
    await this.sendJson('POST', `${this.endpoint}/api/repos/move`, {
      fromRepo,
      toRepo,
      type: kind
    })
  }

  /**
   * Not in the public OpenAPI spec; runtime-verified (the same call
   * huggingface_hub's delete_repo makes: name is the repo name, organization
   * the namespace).
   */
  async deleteRepo(kind: RepoKind, repoId: string): Promise<void> {
    const slash = repoId.indexOf('/')
    const body: Record<string, unknown> = {
      type: kind,
      name: slash === -1 ? repoId : repoId.slice(slash + 1)
    }
    if (slash !== -1) body.organization = repoId.slice(0, slash)
    await this.sendJson('DELETE', `${this.endpoint}/api/repos/delete`, body)
  }

  /** The Hub only defines /duplicate for Spaces (huggingface_hub's duplicate_space). */
  async duplicateSpace(
    repoId: string,
    toRepo: string,
    options: { private?: boolean } = {}
  ): Promise<{ url?: string }> {
    const res = await this.sendJson('POST', `${this.endpoint}/api/spaces/${repoId}/duplicate`, {
      repository: toRepo,
      private: options.private
    })
    const body = (await res.json()) as { url?: string }
    return { url: body.url }
  }

  async createBranch(
    kind: RepoKind,
    repoId: string,
    branch: string,
    startingPoint?: string
  ): Promise<void> {
    await this.sendJson(
      'POST',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/branch/${encodeURIComponent(branch)}`,
      startingPoint === undefined ? {} : { startingPoint }
    )
  }

  async deleteBranch(kind: RepoKind, repoId: string, branch: string): Promise<void> {
    await this.sendJson(
      'DELETE',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/branch/${encodeURIComponent(branch)}`
    )
  }

  /** The revision to tag is the path segment; the tag name travels in the body. */
  async createTag(
    kind: RepoKind,
    repoId: string,
    tag: string,
    revision = 'main',
    message?: string
  ): Promise<void> {
    await this.sendJson(
      'POST',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/tag/${encodeURIComponent(revision)}`,
      { tag, message }
    )
  }

  async deleteTag(kind: RepoKind, repoId: string, tag: string): Promise<void> {
    await this.sendJson(
      'DELETE',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/tag/${encodeURIComponent(tag)}`
    )
  }

  /** Access requests on a gated repo, filtered by status. Drains Link pagination. */
  async listAccessRequests(
    kind: GatedRepoKind,
    repoId: string,
    status: 'pending' | 'accepted' | 'rejected'
  ): Promise<AccessRequest[]> {
    let url: string | undefined =
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/user-access-request/${status}`
    const all: AccessRequest[] = []
    let pages = 0
    while (url && pages < LINK_DRAIN_MAX_PAGES) {
      const page: { body: unknown[]; nextUrl?: string } = await this.getJson(url, { ttl: 5_000 })
      all.push(...page.body.map((raw) => mapAccessRequest(raw as never, this.endpoint)))
      url = page.nextUrl
      pages++
    }
    return all
  }

  async handleAccessRequest(
    kind: GatedRepoKind,
    repoId: string,
    user: string,
    status: 'accepted' | 'rejected' | 'pending',
    rejectionReason?: string
  ): Promise<void> {
    await this.sendJson(
      'POST',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/user-access-request/handle`,
      { user, status, rejectionReason }
    )
  }

  async grantAccess(kind: GatedRepoKind, repoId: string, user: string): Promise<void> {
    await this.sendJson(
      'POST',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/user-access-request/grant`,
      { user }
    )
  }

  async listSpaceSecrets(repoId: string): Promise<SpaceSecret[]> {
    const { body } = await this.getJson<unknown>(`${this.endpoint}/api/spaces/${repoId}/secrets`)
    return mapSpaceSecrets(body as never)
  }

  async setSpaceSecret(
    repoId: string,
    key: string,
    value: string,
    description?: string
  ): Promise<void> {
    await this.sendJson('POST', `${this.endpoint}/api/spaces/${repoId}/secrets`, {
      key,
      value,
      description
    })
  }

  async deleteSpaceSecret(repoId: string, key: string): Promise<void> {
    await this.sendJson('DELETE', `${this.endpoint}/api/spaces/${repoId}/secrets`, { key })
  }

  async listSpaceVariables(repoId: string): Promise<SpaceVariable[]> {
    const { body } = await this.getJson<unknown>(`${this.endpoint}/api/spaces/${repoId}/variables`)
    return mapSpaceVariables(body as never)
  }

  async setSpaceVariable(
    repoId: string,
    key: string,
    value: string,
    description?: string
  ): Promise<void> {
    await this.sendJson('POST', `${this.endpoint}/api/spaces/${repoId}/variables`, {
      key,
      value,
      description
    })
  }

  async deleteSpaceVariable(repoId: string, key: string): Promise<void> {
    await this.sendJson('DELETE', `${this.endpoint}/api/spaces/${repoId}/variables`, { key })
  }

  /**
   * Bounded snapshot of the Space's SSE log stream: reads at most
   * SPACE_LOGS_MAX_BYTES or for SPACE_LOGS_WINDOW_MS, whichever comes first,
   * then returns the concatenated `data:` payload lines. Never hangs: every
   * read races the deadline, and a timeout before headers yields empty text.
   */
  async getSpaceLogsSnapshot(repoId: string, logType: 'build' | 'run'): Promise<{ text: string }> {
    const url = `${this.endpoint}/api/spaces/${repoId}/logs/${logType}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SPACE_LOGS_WINDOW_MS)
    const deadline = new Promise<{ done: true; value: undefined }>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }))
    })
    try {
      const res = await this.fetchWithPolicy(url, {
        headers: { ...this.headers(url), Accept: 'text/event-stream' },
        signal: controller.signal
      })
      if (!res.ok) await this.throwHttpError(res, 'GET', url)
      const reader = res.body?.getReader()
      if (!reader) return { text: '' }
      const decoder = new TextDecoder()
      let raw = ''
      let received = 0
      try {
        while (received < SPACE_LOGS_MAX_BYTES) {
          const chunk = await Promise.race([reader.read(), deadline])
          if (chunk.done || !chunk.value) break
          received += chunk.value.byteLength
          raw += decoder.decode(chunk.value, { stream: true })
        }
      } finally {
        void reader.cancel().catch(() => undefined)
      }
      raw += decoder.decode()
      return { text: sseDataText(raw) }
    } catch (err) {
      // Timed out before the headers arrived: an empty snapshot beats an error.
      if (controller.signal.aborted) return { text: '' }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** Not in the public OpenAPI spec; runtime-verified (used by huggingface_hub's restart_space). */
  async restartSpace(repoId: string, factory = false): Promise<void> {
    const suffix = factory ? '?factory=true' : ''
    await this.sendJson('POST', `${this.endpoint}/api/spaces/${repoId}/restart${suffix}`)
  }

  /**
   * Like/unlike a repo. Not in the public OpenAPI spec.
   *
   * Live-verified 2026-07-11: POST (like) with Bearer access tokens returns
   * 401 "Invalid username or password" — Hugging Face blocks programmatic
   * likes to prevent spam (huggingface_hub only exposes `unlike`), so the
   * like path authenticates as the Hub web session (CookieRequiredError when
   * none is connected). DELETE (unlike) works with write-role tokens and
   * stays on Bearer auth.
   */
  async setLike(kind: RepoKind, repoId: string, liked: boolean): Promise<void> {
    await this.sendJson(
      liked ? 'POST' : 'DELETE',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/like`,
      undefined,
      { auth: liked ? 'cookie' : 'token' }
    )
  }

  /**
   * Social follow/unfollow for a user or org — the same action as the Follow
   * button on huggingface.co profile pages. Not in the public OpenAPI spec;
   * runtime-verified 2026-07-11 (401 without auth; distinct from watch).
   */
  async setFollow(username: string, following: boolean, isOrg = false): Promise<void> {
    const encoded = encodeURIComponent(username)
    const base = isOrg
      ? `${this.endpoint}/api/organizations/${encoded}/follow`
      : `${this.endpoint}/api/users/${encoded}/follow`
    await this.sendJson(following ? 'POST' : 'DELETE', base)
  }

  /**
   * Repos a user has liked. Entries are minimal ({name, type}); buckets/kernels
   * are dropped. Drains Link pagination — isLiked() checks membership over this
   * list, so a partial page would misreport hearts past the first 100 likes.
   */
  async getUserLikes(username: string): Promise<RepoSummary[]> {
    let url: string | undefined =
      `${this.endpoint}/api/users/${encodeURIComponent(username)}/likes?limit=100`
    const items: RepoSummary[] = []
    let pages = 0
    while (url && pages < LINK_DRAIN_MAX_PAGES) {
      const page: { body: Array<{ repo?: { name?: string; type?: string } }>; nextUrl?: string } =
        await this.getJson(url)
      for (const entry of page.body) {
        const repo = entry.repo
        const kind = repo?.type
        if (!repo?.name || (kind !== 'model' && kind !== 'dataset' && kind !== 'space')) continue
        items.push(mapRepoSummary({ ...repo, id: repo.name } as never, kind))
      }
      url = page.nextUrl
      pages++
    }
    return items
  }

  /**
   * Community post comment. Live-verified 2026-07-11: Bearer access tokens
   * (classic write-role and fine-grained) get 401 "Invalid username or password"
   * — only a browser cookie session can post, so this authenticates as the Hub
   * web session (CookieRequiredError when none is connected).
   */
  async commentOnPost(
    author: string,
    slug: string,
    comment: string,
    replyToCommentId?: string
  ): Promise<void> {
    const base = `${this.endpoint}/api/posts/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`
    const url = replyToCommentId
      ? `${base}/comment/${encodeURIComponent(replyToCommentId)}/reply`
      : `${base}/comment`
    await this.sendJson('POST', url, { comment }, { auth: 'cookie' })
  }

  /**
   * Toggle an emoji reaction on a community post. Cookie-session only.
   * Live-captured 2026-07-11 from the web UI: add and remove are both POSTs
   * to .../reaction with {reaction, action: 'add' | 'remove'}.
   */
  async setPostReaction(
    author: string,
    slug: string,
    reaction: string,
    active: boolean
  ): Promise<void> {
    const url = `${this.endpoint}/api/posts/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/reaction`
    await this.sendJson(
      'POST',
      url,
      { reaction, action: active ? 'add' : 'remove' },
      { auth: 'cookie' }
    )
  }

  /**
   * Toggle an emoji reaction on a post comment. Cookie-session only.
   * Live-captured 2026-07-11: POST .../posts/{author}/{slug}/comment/{id}/reaction
   * with {reaction, action: 'add' | 'remove'} — same body as post and
   * discussion reactions.
   */
  async setPostCommentReaction(
    author: string,
    slug: string,
    commentId: string,
    reaction: string,
    active: boolean
  ): Promise<void> {
    const base = `${this.endpoint}/api/posts/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`
    await this.sendJson(
      'POST',
      `${base}/comment/${encodeURIComponent(commentId)}/reaction`,
      { reaction, action: active ? 'add' : 'remove' },
      { auth: 'cookie' }
    )
  }

  /**
   * Hide a comment on a community post — IRREVERSIBLE. Cookie-session only,
   * and the account needs moderation rights (post owner or the comment's
   * author). Live-verified 2026-07-11: POST .../comment/{id}/hide with
   * {reason}, where reason is a verbatim label from HUB_HIDE_REASONS
   * (optional; the Hub stores the display string, not a code).
   */
  async hidePostComment(
    author: string,
    slug: string,
    commentId: string,
    reason?: string
  ): Promise<void> {
    const url = `${this.endpoint}/api/posts/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/comment/${encodeURIComponent(commentId)}/hide`
    await this.sendJson('POST', url, reason ? { reason } : {}, { auth: 'cookie' })
  }

  /**
   * Upload a comment attachment to the Hub CDN and return its URL, to embed in
   * comment markdown. Cookie-session only. Live-captured 2026-07-11: POST
   * /uploads (NOT under /api/) with the raw file bytes as the body and the
   * file's Content-Type; the response body is the plain-text CDN URL.
   */
  async uploadCommentAsset(data: Uint8Array, contentType: string): Promise<string> {
    const url = `${this.endpoint}/uploads`
    if (!this.getSessionCookie() || !this.allowsAuth(url)) throw new CookieRequiredError(url)
    const res = await this.fetchWithPolicy(
      url,
      {
        method: 'POST',
        headers: { ...this.headers(url, 'cookie'), 'Content-Type': contentType },
        body: data as unknown as RequestInit['body']
      },
      { retryStatuses: [429] }
    )
    if (!res.ok) await this.throwHttpError(res, 'POST', url)
    return (await res.text()).trim()
  }

  /**
   * The Settings → Profile page, fetched with the web session and parsed for
   * the form values + csrf token. A signed-out (or rejected) session gets the
   * login page instead of the form, which surfaces as a 401 so the caller can
   * drop the stale cookie. Also returns any Set-Cookie pairs from the GET so
   * a follow-up form POST can forward CSRF companion cookies Node fetch
   * would otherwise drop.
   */
  private async fetchProfileSettingsPage(): Promise<{
    csrf: string
    settings: HubProfileSettings
    responseCookies: string[]
  }> {
    const url = `${this.endpoint}/settings/profile`
    if (!this.getSessionCookie() || !this.allowsAuth(url)) throw new CookieRequiredError(url)
    const res = await this.fetchWithPolicy(url, {
      headers: this.headers(url, 'cookie', { referer: url })
    })
    if (!res.ok) await this.throwHttpError(res, 'GET', url)
    const responseCookies = cookiePairsFromResponse(res)
    const page = parseProfileSettingsPage(await res.text())
    if (!page) throw new HubApiError('Hub web session was rejected (401)', 401, url)
    return { ...page, responseCookies }
  }

  /** Editable public-profile fields as currently saved on the Hub. */
  async getProfileSettings(): Promise<HubProfileSettings> {
    return (await this.fetchProfileSettingsPage()).settings
  }

  /**
   * Save the public profile. Mirrors the Hub form exactly (live-captured
   * 2026-07-11): urlencoded POST to /settings/profile with the page's csrf
   * token and every field, where an empty `avatar` means "keep the current
   * one" and a freshly uploaded /uploads URL replaces it. Forwards Set-Cookie
   * pairs from the preceding GET and uses redirect:manual so a success 302
   * is not followed into an unrelated failure.
   */
  async updateProfileSettings(update: HubProfileUpdate): Promise<void> {
    const { csrf, responseCookies } = await this.fetchProfileSettingsPage()
    const url = `${this.endpoint}/settings/profile`
    // Double-submit CSRF: if the GET did not Set-Cookie a csrf companion but
    // the form carries one, mirror it as a cookie (common Hub pattern). Skip
    // when the stored jar or response already has a csrf* cookie.
    const session = this.getSessionCookie() ?? ''
    const hasCsrfCookie =
      /\bcsrf[^=]*=/i.test(session) ||
      responseCookies.some((p) => /^csrf/i.test(p.split('=', 1)[0] ?? ''))
    const extras =
      !hasCsrfCookie && csrf !== '' ? [...responseCookies, `csrf=${csrf}`] : responseCookies
    const body = new URLSearchParams({
      csrf,
      fullname: update.fullname,
      avatar: update.avatar ?? '',
      primaryOrg: update.primaryOrg,
      homepage: update.homepage,
      details: update.details,
      github: update.github,
      twitter: update.twitter,
      linkedin: update.linkedin,
      bluesky: update.bluesky
    })
    const res = await this.fetchWithPolicy(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...this.headers(url, 'cookie', { referer: url, extraCookies: extras }),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    })
    if (res.status >= 200 && res.status < 300) {
      this.invalidateCache()
      return
    }
    // Hub form saves typically 302/303 back to the profile page.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location') ?? ''
      if (/\/login(?:\?|$)/i.test(loc)) {
        throw new HubApiError('Hub web session was rejected (401)', 401, url)
      }
      // Any other redirect (including relative /settings/profile) counts as saved.
      this.invalidateCache()
      return
    }
    await this.throwHttpError(res, 'POST', url)
  }

  /**
   * Comments on a community post. There is no JSON endpoint — the Hub embeds
   * the thread in the post page's SocialPost component props, so this fetches
   * the HTML page and parses that JSON island. Live-verified 2026-07-11: the
   * island (with socialPost.comments) is present in the anonymous/token SSR
   * HTML, not just cookie'd requests, so this works signed out.
   */
  async getPostComments(author: string, slug: string): Promise<PostComment[]> {
    const url = `${this.endpoint}/posts/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`
    const html = await this.getText(url)
    return parsePostComments(html, this.endpoint)
  }

  /**
   * Whether the web session may create community posts. The Hub gates posting
   * behind a beta (/api/posts/can-post returns {canPost, reason};
   * live-verified 2026-07-11). Posting is cookie-only, so without a web
   * session this reports canPost: false locally.
   */
  async canCreatePost(): Promise<CanPostResult> {
    const url = `${this.endpoint}/api/posts/can-post`
    if (!this.getSessionCookie()) return { canPost: false }
    const res = await this.fetchWithPolicy(url, { headers: this.headers(url, 'cookie') })
    if (!res.ok) await this.throwHttpError(res, 'GET', url)
    const body = (await res.json()) as { canPost?: boolean; reason?: string }
    return { canPost: body.canPost === true, reason: body.reason }
  }

  /**
   * Create a community post. Cookie-session only, and additionally gated by
   * the Hub's posting beta (check canCreatePost first). Endpoint shape from
   * community usage of the web app — could not be live-verified on a
   * non-beta account; errors surface verbatim to the caller.
   */
  async createPost(content: string): Promise<{ slug?: string }> {
    const res = await this.sendJson(
      'POST',
      `${this.endpoint}/api/posts`,
      { rawContent: content },
      { auth: 'cookie' }
    )
    const body = (await res.json().catch(() => ({}))) as {
      slug?: string
      socialPost?: { slug?: string }
    }
    return { slug: body.slug ?? body.socialPost?.slug }
  }

  /**
   * Toggle a Daily Papers upvote. Cookie-session only (social action).
   * Live-captured 2026-07-11: POST /api/papers/{id}/upvote to upvote,
   * DELETE to remove. The papers APIs expose no per-user upvote state, so
   * callers track their own toggle optimistically.
   */
  async setPaperUpvote(paperId: string, upvoted: boolean): Promise<void> {
    await this.sendJson(
      upvoted ? 'POST' : 'DELETE',
      `${this.endpoint}/api/papers/${encodeURIComponent(paperId)}/upvote`,
      {},
      { auth: 'cookie' }
    )
  }

  /**
   * Toggle a collection upvote. Cookie-session only (social action).
   * Live-captured 2026-07-11: POST/DELETE /api/collections/{slug}/upvote.
   * Collection detail responses carry isUpvotedByUser for the initial state.
   */
  async setCollectionUpvote(slug: string, upvoted: boolean): Promise<void> {
    await this.sendJson(
      upvoted ? 'POST' : 'DELETE',
      `${this.endpoint}/api/collections/${slug}/upvote`,
      {},
      { auth: 'cookie' }
    )
  }

  /**
   * Toggle an emoji reaction on a discussion comment. Cookie-session only.
   * Live-captured 2026-07-11: POST .../discussions/{num}/comment/{commentId}/reaction
   * with {reaction, action: 'add' | 'remove'} — same body shape as posts.
   */
  async setDiscussionCommentReaction(
    kind: RepoKind,
    repoId: string,
    num: number,
    commentId: string,
    reaction: string,
    active: boolean
  ): Promise<void> {
    const url = `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}/comment/${encodeURIComponent(commentId)}/reaction`
    await this.sendJson(
      'POST',
      url,
      { reaction, action: active ? 'add' : 'remove' },
      { auth: 'cookie' }
    )
  }

  async commentOnPaper(paperId: string, comment: string, replyToCommentId?: string): Promise<void> {
    const base = `${this.endpoint}/api/papers/${encodeURIComponent(paperId)}`
    const url = replyToCommentId
      ? `${base}/comment/${encodeURIComponent(replyToCommentId)}/reply`
      : `${base}/comment`
    // Prefer the web session when connected (paper comments share the post
    // comment machinery, which is cookie-gated for some token kinds); token
    // stays the fallback so token-only sessions keep their current behavior.
    const auth = this.getSessionCookie() ? ('cookie' as const) : ('token' as const)
    await this.sendJson('POST', url, { comment }, { auth })
  }

  /**
   * Toggle an emoji reaction on a paper comment. Cookie-session only, same
   * undocumented .../comment/{id}/reaction pattern as discussion/post
   * comments — openapi.json omits reaction endpoints entirely (for every repo
   * type), but a live unauthenticated probe returns 401, not 404, confirming
   * the route exists (verified 2026-07-13).
   */
  async setPaperCommentReaction(
    paperId: string,
    commentId: string,
    reaction: string,
    active: boolean
  ): Promise<void> {
    const url = `${this.endpoint}/api/papers/${encodeURIComponent(paperId)}/comment/${encodeURIComponent(commentId)}/reaction`
    await this.sendJson(
      'POST',
      url,
      { reaction, action: active ? 'add' : 'remove' },
      { auth: 'cookie' }
    )
  }

  async mergePullRequest(
    kind: RepoKind,
    repoId: string,
    num: number,
    comment?: string
  ): Promise<void> {
    await this.sendJson(
      'POST',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}/merge`,
      { comment }
    )
  }

  async setDiscussionStatus(
    kind: RepoKind,
    repoId: string,
    num: number,
    status: 'open' | 'closed',
    comment?: string
  ): Promise<void> {
    await this.sendJson(
      'POST',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}/status`,
      { status, comment }
    )
  }

  async setDiscussionTitle(
    kind: RepoKind,
    repoId: string,
    num: number,
    title: string
  ): Promise<void> {
    await this.sendJson(
      'POST',
      `${this.endpoint}/api/${API_PATH[kind]}/${repoId}/discussions/${num}/title`,
      { title }
    )
  }

  /** Current billing period usage for the signed-in user, flattened for display. */
  async getBillingUsage(): Promise<BillingUsage> {
    const { body } = await this.getJson<unknown>(`${this.endpoint}/api/settings/billing/usage`, {
      ttl: 60_000
    })
    return mapBillingUsage(body as never)
  }
}
