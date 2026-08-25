import { randomUUID } from 'node:crypto'
import type { TelemetryStatus } from '@oh-my-huggingface/shared'
import type { AppDatabase } from './db'

/**
 * Default cloud ingestion origin for this repository's PostHog project.
 *
 * The project is hosted in PostHog US Cloud. Project tokens are region-bound:
 * sending this project's token to the EU collector can return an accepted HTTP
 * response while the event never appears in the US project. Release workflows
 * still require POSTHOG_HOST explicitly; this default protects local/package
 * builds and keeps every compiled fallback aligned with the configured region.
 */
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

export const TELEMETRY_EVENTS = [
  'telemetry_enabled',
  'app_launched',
  'star_prompt_shown',
  'star_prompt_opened',
  'star_prompt_snoozed',
  'star_prompt_exhausted',
  'star_prompt_disabled'
] as const

export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number]

export type StarPromptTelemetryEvent = Exclude<TelemetryEvent, 'telemetry_enabled' | 'app_launched'>

export interface TelemetryEventProperties {
  telemetry_enabled: undefined
  app_launched: undefined
  star_prompt_shown: { prompt_number: number; action: 'shown' }
  star_prompt_opened: { prompt_number: number; action: 'open' }
  star_prompt_snoozed: { prompt_number: number; action: 'later' }
  star_prompt_exhausted: { prompt_number: 2; action: 'exhausted' }
  star_prompt_disabled: { prompt_number: number; action: 'disable' }
}

type CaptureArguments<E extends TelemetryEvent> = TelemetryEventProperties[E] extends undefined
  ? []
  : [properties: TelemetryEventProperties[E]]

export type TelemetryFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type TelemetryCaptureResult =
  | { status: 'sent' }
  | { status: 'skipped' }
  | {
      status: 'failed'
      reason: 'http' | 'network' | 'timeout' | 'internal'
      httpStatus?: number
    }

export type ConsentPromptClaim = false | { claimId: string }

export type ConsentPromptAcknowledgeResult =
  { accepted: false; newlyAccepted: false } | { accepted: true; newlyAccepted: boolean }

export type ConsentPromptResolveResult =
  | { accepted: false; newlyResolved: false }
  | { accepted: true; newlyResolved: boolean; decision: 'decline' }

export interface TelemetryOptions {
  db: AppDatabase
  enabled: () => boolean
  apiKey: string
  endpoint: string
  appVersion: string
  platform: string
  arch: string
  locale: () => string
  /**
   * The main process owns routing policy. Callers must inject a proxy-aware
   * implementation or pass null to disable delivery explicitly.
   */
  fetchImpl: TelemetryFetch | null
  createId?: () => string
  /** Separate UUIDv4 source for the local, never-transmitted consent reservation. */
  createConsentClaimId?: () => string
  timeoutMs?: number
}

interface KvRow {
  value: string
}

interface LegacyConsentPromptState {
  version: 1
  claimId: string
  shown: boolean
}

type ConsentPromptState =
  | {
      version: 2
      claimId: string
      status: 'reserved' | 'displayed'
      resolution: null
    }
  | {
      version: 2
      claimId: string
      status: 'resolved'
      resolution: 'accepted' | 'declined'
    }

type StoredConsentPromptState = LegacyConsentPromptState | ConsentPromptState

interface PostHogPayload {
  api_key: string
  event: TelemetryEvent
  distinct_id: string
  properties: {
    $geoip_disable: true
    $process_person_profile: false
    schema_version: 1
    app_version: string
    platform: string
    arch: string
    locale: string
    prompt_number?: number
    action?: 'shown' | 'open' | 'later' | 'exhausted' | 'disable'
  }
}

const INSTALLATION_ID_KEY = 'telemetry.installation-id.v1'
const CONSENT_PROMPT_KEY = 'telemetry.consent-prompt.v1'
const POSTHOG_EVENT_PATH = '/i/v0/e/'
const DEFAULT_TIMEOUT_MS = 2_000
const TELEMETRY_SCHEMA_VERSION = 1 as const
const CONSENT_PROMPT_STATE_VERSION = 2 as const
const EVENT_SET = new Set<string>(TELEMETRY_EVENTS)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function postHogEndpoint(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
    url.pathname = POSTHOG_EVENT_PATH
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  return typeof value === 'string' && EVENT_SET.has(value)
}

type StarPromptAction = 'shown' | 'open' | 'later' | 'exhausted' | 'disable'

const STAR_PROMPT_ACTIONS: Record<StarPromptTelemetryEvent, StarPromptAction> = {
  star_prompt_shown: 'shown',
  star_prompt_opened: 'open',
  star_prompt_snoozed: 'later',
  star_prompt_exhausted: 'exhausted',
  star_prompt_disabled: 'disable'
}

function starPromptProperties(
  event: TelemetryEvent,
  value: unknown
): { prompt_number: number; action: StarPromptAction } | null | undefined {
  if (event === 'telemetry_enabled' || event === 'app_launched') {
    return value === undefined ? undefined : null
  }
  if (!value || typeof value !== 'object') return null
  const candidate = value as { prompt_number?: unknown; action?: unknown }
  const expectedAction = STAR_PROMPT_ACTIONS[event]
  if (
    !Number.isSafeInteger(candidate.prompt_number) ||
    (candidate.prompt_number as number) < 1 ||
    (candidate.prompt_number as number) > 2 ||
    (event === 'star_prompt_exhausted' && candidate.prompt_number !== 2) ||
    candidate.action !== expectedAction
  ) {
    return null
  }
  return {
    prompt_number: candidate.prompt_number as number,
    action: expectedAction
  }
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value)
}

function parseConsentPromptState(value: string): StoredConsentPromptState | null {
  try {
    const raw = JSON.parse(value) as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object' || !isUuidV4(raw.claimId)) return null

    if (raw.version === 1 && typeof raw.shown === 'boolean') {
      return {
        version: 1,
        claimId: raw.claimId,
        shown: raw.shown
      }
    }

    if (
      raw.version === CONSENT_PROMPT_STATE_VERSION &&
      (raw.status === 'reserved' || raw.status === 'displayed') &&
      raw.resolution === null
    ) {
      return {
        version: CONSENT_PROMPT_STATE_VERSION,
        claimId: raw.claimId,
        status: raw.status,
        resolution: null
      }
    }

    if (
      raw.version === CONSENT_PROMPT_STATE_VERSION &&
      raw.status === 'resolved' &&
      (raw.resolution === 'accepted' || raw.resolution === 'declined')
    ) {
      return {
        version: CONSENT_PROMPT_STATE_VERSION,
        claimId: raw.claimId,
        status: 'resolved',
        resolution: raw.resolution
      }
    }
    return null
  } catch {
    return null
  }
}

function migrateConsentPromptState(state: StoredConsentPromptState): ConsentPromptState {
  if (state.version === CONSENT_PROMPT_STATE_VERSION) return state
  return {
    version: CONSENT_PROMPT_STATE_VERSION,
    claimId: state.claimId,
    status: state.shown ? 'displayed' : 'reserved',
    resolution: null
  }
}

function resolvedConsentPromptState(
  claimId: string,
  resolution: 'accepted' | 'declined'
): ConsentPromptState {
  return {
    version: CONSENT_PROMPT_STATE_VERSION,
    claimId,
    status: 'resolved',
    resolution
  }
}

/**
 * Minimal, opt-out PostHog transport owned by the main process. Callers can choose
 * only a fixed event name; no account, repository, path, search, or arbitrary
 * property can enter the payload.
 */
export class TelemetryService {
  private readonly db: AppDatabase
  private readonly enabled: () => boolean
  private readonly apiKey: string
  private readonly endpoint: string | null
  private readonly appVersion: string
  private readonly platform: string
  private readonly arch: string
  private readonly locale: () => string
  private readonly fetchImpl: TelemetryFetch | null
  private readonly createId: () => string
  private readonly createConsentClaimId: () => string
  private readonly timeoutMs: number
  private installationId: string | null = null
  private lastCapture: TelemetryStatus['lastCapture']

  constructor(options: TelemetryOptions) {
    this.db = options.db
    this.enabled = options.enabled
    this.apiKey = options.apiKey.trim()
    this.endpoint = postHogEndpoint(options.endpoint)
    this.appVersion = options.appVersion
    this.platform = options.platform
    this.arch = options.arch
    this.locale = options.locale
    this.fetchImpl = options.fetchImpl
    this.createId = options.createId ?? randomUUID
    this.createConsentClaimId = options.createConsentClaimId ?? randomUUID
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  /** Whether this build has a valid HTTPS collector and public ingestion key. */
  isConfigured(): boolean {
    return this.endpoint !== null && this.apiKey !== '' && this.fetchImpl !== null
  }

  /** Local-only view for Settings. Never includes the installation identifier. */
  getStatus(): TelemetryStatus {
    return {
      configured: this.isConfigured(),
      enabled: this.enabled() === true,
      lastCapture: this.lastCapture
    }
  }

  /**
   * Atomically reserves the opt-out disclosure. A renderer crash, reload, or
   * acknowledgement without a decision receives the same claim again. Only an
   * explicit keep/decline resolves it; reserving creates no installation
   * identity and emits no event. An enabled setting is not a decision: the
   * opt-out default can send events before this card is resolved.
   */
  claimConsentPrompt(): ConsentPromptClaim {
    try {
      if (!this.isConfigured()) return false

      const transaction = this.db.transaction((): ConsentPromptClaim => {
        const row = this.db
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get(CONSENT_PROMPT_KEY) as KvRow | undefined
        if (row) {
          const storedState = parseConsentPromptState(row.value)
          // An unknown or corrupt state fails closed so a disk fault cannot
          // unexpectedly repeat a consent solicitation.
          if (!storedState) return false
          const state = migrateConsentPromptState(storedState)

          if (storedState.version !== CONSENT_PROMPT_STATE_VERSION) {
            this.writeConsentPromptState(state)
          }
          if (state.status === 'resolved') return false
          return { claimId: state.claimId }
        }

        const claimId = this.safeCreateConsentClaimId()
        if (!claimId) return false

        this.writeConsentPromptState({
          version: CONSENT_PROMPT_STATE_VERSION,
          claimId,
          status: 'reserved',
          resolution: null
        })
        return { claimId }
      })
      return transaction.immediate()
    } catch {
      return false
    }
  }

  /** Whether this installation already recorded an explicit telemetry opt-out. */
  hasExplicitDecline(): boolean {
    try {
      const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(CONSENT_PROMPT_KEY) as
        KvRow | undefined
      if (!row) return false
      const storedState = parseConsentPromptState(row.value)
      if (!storedState) return false
      const state = migrateConsentPromptState(storedState)
      return state.status === 'resolved' && state.resolution === 'declined'
    } catch {
      return false
    }
  }

  /**
   * Marks a matching reservation as actually displayed. Retrying the same
   * token is idempotent; this is not a consent decision and remains reclaimable
   * after a renderer reload or application exit.
   */
  acknowledgeConsentPrompt(claimId: string): ConsentPromptAcknowledgeResult {
    if (!isUuidV4(claimId)) return { accepted: false, newlyAccepted: false }
    try {
      const transaction = this.db.transaction((): ConsentPromptAcknowledgeResult => {
        const row = this.db
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get(CONSENT_PROMPT_KEY) as KvRow | undefined
        if (!row) return { accepted: false, newlyAccepted: false }
        const state = parseConsentPromptState(row.value)
        if (!state || state.claimId !== claimId) {
          return { accepted: false, newlyAccepted: false }
        }
        const current = migrateConsentPromptState(state)
        if (current.status === 'resolved') {
          return { accepted: false, newlyAccepted: false }
        }
        if (current.status === 'displayed') {
          if (state.version !== CONSENT_PROMPT_STATE_VERSION) {
            this.writeConsentPromptState(current)
          }
          return { accepted: true, newlyAccepted: false }
        }

        this.writeConsentPromptState({
          ...current,
          status: 'displayed'
        })
        return { accepted: true, newlyAccepted: true }
      })
      return transaction.immediate()
    } catch {
      return { accepted: false, newlyAccepted: false }
    }
  }

  /**
   * Persists an explicit decline from a displayed card. A retry with the same
   * token and decision is idempotent; reserved, mismatched, corrupt, and
   * conflicting resolved states are rejected.
   */
  resolveConsentPrompt(claimId: string, decision: 'decline'): ConsentPromptResolveResult {
    if (!isUuidV4(claimId) || decision !== 'decline') {
      return { accepted: false, newlyResolved: false }
    }
    try {
      const transaction = this.db.transaction((): ConsentPromptResolveResult => {
        const row = this.db
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get(CONSENT_PROMPT_KEY) as KvRow | undefined
        if (!row) return { accepted: false, newlyResolved: false }
        const storedState = parseConsentPromptState(row.value)
        if (!storedState || storedState.claimId !== claimId) {
          return { accepted: false, newlyResolved: false }
        }
        const state = migrateConsentPromptState(storedState)
        if (state.status === 'resolved') {
          return state.resolution === 'declined'
            ? { accepted: true, newlyResolved: false, decision }
            : { accepted: false, newlyResolved: false }
        }
        if (state.status !== 'displayed') {
          return { accepted: false, newlyResolved: false }
        }

        this.writeConsentPromptState({
          version: CONSENT_PROMPT_STATE_VERSION,
          claimId,
          status: 'resolved',
          resolution: 'declined'
        })
        return { accepted: true, newlyResolved: true, decision }
      })
      return transaction.immediate()
    } catch {
      return { accepted: false, newlyResolved: false }
    }
  }

  /**
   * Records a successful settings confirmation as the explicit keep decision.
   * This local state contains no installation identity and sends no event.
   */
  recordExplicitConsentAcceptance(): boolean {
    return this.recordExplicitConsentDecision('accepted')
  }

  /** Records a successful settings opt-out as an explicit decline decision. */
  recordExplicitConsentDecline(): boolean {
    return this.recordExplicitConsentDecision('declined')
  }

  private recordExplicitConsentDecision(resolution: 'accepted' | 'declined'): boolean {
    try {
      const transaction = this.db.transaction((): boolean => {
        const row = this.db
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get(CONSENT_PROMPT_KEY) as KvRow | undefined
        const storedState = row ? parseConsentPromptState(row.value) : null
        if (
          storedState?.version === CONSENT_PROMPT_STATE_VERSION &&
          storedState.status === 'resolved' &&
          storedState.resolution === resolution
        ) {
          return true
        }

        // An explicit current decision can safely replace a corrupt old row.
        const claimId = storedState?.claimId ?? this.safeCreateConsentClaimId()
        if (!claimId) return false
        this.writeConsentPromptState(resolvedConsentPromptState(claimId, resolution))
        return true
      })
      return transaction.immediate()
    } catch {
      return false
    }
  }

  async capture<E extends TelemetryEvent>(
    event: E,
    ...args: CaptureArguments<E>
  ): Promise<TelemetryCaptureResult> {
    const remember = (result: TelemetryCaptureResult): TelemetryCaptureResult => {
      if (isTelemetryEvent(event)) {
        this.lastCapture = {
          event,
          status: result.status,
          at: new Date().toISOString()
        }
      }
      return result
    }
    try {
      if (
        !isTelemetryEvent(event) ||
        !this.endpoint ||
        !this.apiKey ||
        !this.fetchImpl ||
        this.enabled() !== true
      ) {
        return { status: 'skipped' }
      }
      const eventProperties = starPromptProperties(event, args[0])
      if (eventProperties === null) return remember({ status: 'skipped' })
      const distinctId = this.getInstallationId()
      if (!distinctId) return remember({ status: 'failed', reason: 'internal' })

      const payload: PostHogPayload = {
        api_key: this.apiKey,
        event,
        distinct_id: distinctId,
        properties: {
          $geoip_disable: true,
          $process_person_profile: false,
          schema_version: TELEMETRY_SCHEMA_VERSION,
          app_version: this.appVersion,
          platform: this.platform,
          arch: this.arch,
          locale: this.locale(),
          ...eventProperties
        }
      }

      const controller = new AbortController()
      let timeout: NodeJS.Timeout | undefined
      const request = Promise.resolve()
        .then(() =>
          this.fetchImpl!(this.endpoint!, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
          })
        )
        .then(
          (response): TelemetryCaptureResult =>
            response.ok
              ? { status: 'sent' }
              : { status: 'failed', reason: 'http', httpStatus: response.status },
          (): TelemetryCaptureResult => ({ status: 'failed', reason: 'network' })
        )
      const deadline = new Promise<TelemetryCaptureResult>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort()
          resolve({ status: 'failed', reason: 'timeout' })
        }, this.timeoutMs)
        timeout.unref?.()
      })
      const result = await Promise.race([request, deadline])
      if (timeout) clearTimeout(timeout)
      return remember(result)
    } catch {
      // Telemetry must never affect application behavior.
      return remember({ status: 'failed', reason: 'internal' })
    }
  }

  /**
   * Creates and persists a fresh identity for an explicit re-enable. This rotates
   * any stale row even if a previous best-effort opt-out deletion encountered
   * a storage error; no event can reuse the previous lifecycle's identifier.
   */
  prepareIdentityForOptIn(): boolean {
    if (!this.isConfigured()) return false
    this.installationId = null
    const id = this.safeCreateId()
    if (!id) return false
    try {
      this.db
        .prepare(
          'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
        .run(INSTALLATION_ID_KEY, id)
      this.installationId = id
      return true
    } catch {
      return false
    }
  }

  clearIdentity(): boolean {
    this.installationId = null
    try {
      this.db.prepare('DELETE FROM kv WHERE key = ?').run(INSTALLATION_ID_KEY)
      return true
    } catch {
      // Do not include the identifier or database error in logs.
      console.error('[telemetry] failed to delete the local installation identifier')
      return false
    }
  }

  private safeCreateId(): string | null {
    try {
      const id = this.createId()
      return isUuid(id) ? id : null
    } catch {
      return null
    }
  }

  private safeCreateConsentClaimId(): string | null {
    try {
      const id = this.createConsentClaimId()
      return isUuidV4(id) ? id : null
    } catch {
      return null
    }
  }

  private writeConsentPromptState(state: ConsentPromptState): void {
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(CONSENT_PROMPT_KEY, JSON.stringify(state))
  }

  private getInstallationId(): string | null {
    if (this.installationId) return this.installationId
    try {
      const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(INSTALLATION_ID_KEY) as
        KvRow | undefined
      if (row && isUuid(row.value)) {
        this.installationId = row.value
        return row.value
      }

      const id = this.safeCreateId()
      if (!id) return null
      this.db
        .prepare(
          'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
        .run(INSTALLATION_ID_KEY, id)
      this.installationId = id
      return id
    } catch {
      return null
    }
  }
}

/**
 * A stored decline must win over the opt-out default. Older builds recorded
 * "No thanks" without writing settings, so an upgrade would otherwise start
 * sending events from a user who already refused.
 */
export function applyExplicitTelemetryDecline(
  settings: {
    get(): { telemetryEnabled: boolean }
    set(patch: { telemetryEnabled: boolean }): unknown
  },
  telemetry: Pick<TelemetryService, 'hasExplicitDecline' | 'clearIdentity'>
): void {
  if (!telemetry.hasExplicitDecline()) return
  if (settings.get().telemetryEnabled === true) {
    settings.set({ telemetryEnabled: false })
  }
  telemetry.clearIdentity()
}
