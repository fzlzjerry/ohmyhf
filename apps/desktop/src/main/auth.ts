import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { net, safeStorage } from 'electron'
import type {
  AuthState,
  HubSessionConnectResult,
  TokenSignInResult,
  UserProfile
} from '@oh-my-huggingface/shared'
import { hubRelativeUrl } from '@oh-my-huggingface/shared'
import type { HubClient } from '@oh-my-huggingface/hub-api'
import { isForbidden, isUnauthorized } from '@oh-my-huggingface/hub-api'
import type { AppDatabase } from './db'

/**
 * Credentials live OUTSIDE the per-profile userData so every session — packaged,
 * dev, and any extra profile — shares one login. Still safeStorage-encrypted;
 * never plaintext. Tests isolate themselves via OMH_CREDENTIALS_DIR.
 */
function credentialsFile(): string {
  const dir = process.env.OMH_CREDENTIALS_DIR ?? join(homedir(), '.oh_my_hf')
  return join(dir, 'credentials.json')
}

interface StoredToken {
  accessToken: string
  /**
   * How the token was obtained. Only `'token'` (pasted User Access Token) is
   * supported. Legacy OAuth grants (`mode` absent or `'oauth'`) are discarded
   * on restore so the user re-signs in with an access token.
   */
  mode?: 'oauth' | 'token'
  /** User-chosen token name from whoami-v2, for the Account UI. */
  tokenDisplayName?: string
  /** 'read' | 'write' | 'fineGrained' from whoami-v2, when reported. */
  tokenRole?: string
  /**
   * Supplemental Hub web-session credentials: a full Cookie header
   * (`token=…; csrf=…`) from login capture, or a legacy raw `token` value.
   * Unlocks the social writes / settings form POSTs the Hub blocks for Bearer
   * tokens. Extra fields inside the same encrypted envelope keep
   * the version-1 file forward/backward compatible.
   */
  sessionCookie?: string
  /** Whoami name the cookie validated as, for the Account UI. */
  sessionUsername?: string
}

/**
 * Retry backoff after a transient (network/5xx/403) whoAmI failure at startup:
 * starts low so a brief blip resolves fast, doubles up to the ceiling.
 */
const RETRY_FLOOR_MS = 5_000
const RETRY_CEIL_MS = 60_000
/** While offline, poll cheap net.isOnline() so reconnect triggers an immediate re-check. */
const ONLINE_POLL_MS = 5_000
/** Re-validate the session periodically so a token revoked mid-run is detected. */
const REVALIDATE_MS = 15 * 60_000
/** Random spread added per cycle so many clients don't re-validate in lockstep. */
const REVALIDATE_JITTER_MS = 60_000
/** Collapse bursts of fs.watch events into one credentials-file check. */
const WATCH_DEBOUNCE_MS = 500

export class AuthManager {
  private state: AuthState = { status: 'signedOut' }
  private token: StoredToken | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryDelay = RETRY_FLOOR_MS
  private onlineTimer: NodeJS.Timeout | null = null
  private revalidateTimer: NodeJS.Timeout | null = null
  private revalidateInFlight = false
  private credentialsWatcher: FSWatcher | null = null
  private watchDebounce: NodeJS.Timeout | null = null
  /** True while persistToken() rewrites the shared file, so the watcher ignores our own churn. */
  private persisting = false
  /** Whether this session believes the shared file currently holds its token. */
  private tokenOnDisk = false
  /**
   * Bumped whenever the session owner changes intent (sign-out, new sign-in).
   * An in-flight whoAmI from a previous epoch must discard its result instead
   * of resurrecting a token the user just discarded.
   */
  private epoch = 0
  private client!: HubClient

  constructor(
    private readonly db: AppDatabase,
    private readonly onChange: (state: AuthState) => void
  ) {}

  attachClient(client: HubClient): void {
    if (this.client !== client) this.epoch += 1
    this.client = client
  }

  getState(): AuthState {
    return this.state
  }

  /** Called by HubClient on every request. */
  accessToken(): string | undefined {
    return this.token?.accessToken
  }

  /** Called by HubClient on cookie-authenticated (social write) requests. */
  sessionCookie(): string | undefined {
    return this.token?.sessionCookie
  }

  private setState(state: AuthState): void {
    this.state = state
    // Only signed-in sessions re-validate; the timer dies with the session.
    if (state.status === 'signedIn') this.scheduleRevalidate()
    else this.clearRevalidate()
    this.onChange(state)
  }

  private signedInState(user: UserProfile): AuthState {
    return {
      status: 'signedIn',
      user,
      method: 'token',
      tokenDisplayName: this.token?.tokenDisplayName,
      tokenRole: this.token?.tokenRole,
      hubSession: Boolean(this.token?.sessionCookie)
    }
  }

  private persistToken(): void {
    this.persisting = true
    try {
      const file = credentialsFile()
      if (!this.token) {
        this.tokenOnDisk = false
        rmSync(file, { force: true })
        this.db.prepare('DELETE FROM auth WHERE id = 1').run()
        return
      }
      if (!safeStorage.isEncryptionAvailable()) {
        // Hard rule: never store the token unencrypted. Session stays in memory only.
        console.warn('[auth] OS encryption unavailable; token will not be persisted')
        this.tokenOnDisk = false
        return
      }
      const cipher = safeStorage.encryptString(JSON.stringify(this.token))
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
      // Atomic replace: concurrent sessions read this file, a torn write must be impossible.
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, cipher: cipher.toString('base64') }), {
        mode: 0o600
      })
      renameSync(tmp, file)
      this.tokenOnDisk = true
      // The pre-shared-credentials location; clear it so there is one source of truth.
      this.db.prepare('DELETE FROM auth WHERE id = 1').run()
    } finally {
      this.persisting = false
    }
  }

  /**
   * Decrypt the shared credentials file without side effects. Used to adopt a
   * token another session already installed, so concurrent sessions stay in sync.
   */
  private readSharedToken(): StoredToken | null {
    if (!safeStorage.isEncryptionAvailable()) return null
    const file = credentialsFile()
    if (!existsSync(file)) return null
    try {
      const { cipher } = JSON.parse(readFileSync(file, 'utf8')) as { cipher: string }
      return JSON.parse(safeStorage.decryptString(Buffer.from(cipher, 'base64'))) as StoredToken
    } catch {
      return null
    }
  }

  private loadPersistedToken(): StoredToken | null {
    if (!safeStorage.isEncryptionAvailable()) return null
    const file = credentialsFile()
    if (existsSync(file)) {
      try {
        const { cipher } = JSON.parse(readFileSync(file, 'utf8')) as { cipher: string }
        return JSON.parse(safeStorage.decryptString(Buffer.from(cipher, 'base64'))) as StoredToken
      } catch (err) {
        console.warn('[auth] failed to decrypt shared credentials, discarding', err)
        rmSync(file, { force: true })
      }
    }
    // Legacy location (pre-shared-credentials): migrate out of the profile DB.
    const row = this.db.prepare('SELECT token_cipher FROM auth WHERE id = 1').get() as
      { token_cipher: Buffer } | undefined
    if (!row) return null
    let token: StoredToken
    try {
      token = JSON.parse(safeStorage.decryptString(row.token_cipher)) as StoredToken
    } catch (err) {
      console.warn('[auth] failed to decrypt stored token, discarding', err)
      this.db.prepare('DELETE FROM auth WHERE id = 1').run()
      return null
    }
    this.token = token
    try {
      this.persistToken()
    } catch (err) {
      console.warn(
        '[auth] migrating legacy token to the shared file failed; keeping it in memory',
        err
      )
    }
    return token
  }

  /** Retry later WITHOUT touching stored credentials — transient failures only. */
  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      void this.init()
    }, this.retryDelay)
    this.retryTimer.unref?.()
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_CEIL_MS)
    this.watchOnline()
  }

  /** Cancel the startup retry loop (a definitive outcome was reached) and reset its backoff. */
  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.onlineTimer) clearInterval(this.onlineTimer)
    this.onlineTimer = null
    this.retryDelay = RETRY_FLOOR_MS
  }

  /**
   * Backoff alone leaves a restored session signed out for up to the ceiling
   * after connectivity returns; poll net.isOnline() while offline so the retry
   * fires the moment we are back online.
   */
  private watchOnline(): void {
    if (this.onlineTimer || net.isOnline()) return
    this.onlineTimer = setInterval(() => {
      if (!net.isOnline()) return
      if (this.onlineTimer) clearInterval(this.onlineTimer)
      this.onlineTimer = null
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = null
      void this.init()
    }, ONLINE_POLL_MS)
    this.onlineTimer.unref?.()
  }

  /**
   * Only pasted User Access Tokens are accepted. Legacy OAuth grants (no mode,
   * or mode === 'oauth') are cleared so the user signs in with a token.
   */
  private acceptToken(token: StoredToken | null): StoredToken | null {
    if (!token) return null
    if (token.mode === 'token' && token.accessToken) return token
    console.warn('[auth] discarding legacy OAuth session; sign in with an access token')
    return null
  }

  /** Restore the session at startup (also the retry entry point after transient failures). */
  async init(): Promise<void> {
    if (this.state.status !== 'signedOut') return
    this.ensureCredentialsWatch()
    // Prefer a sibling session's shared file (dev + packaged share ~/.oh_my_hf).
    const rawShared = this.readSharedToken()
    const rawLoaded = this.loadPersistedToken() ?? this.token
    const accepted = this.acceptToken(rawShared) ?? this.acceptToken(rawLoaded)
    if ((rawShared !== null || rawLoaded !== null) && accepted === null) {
      // Legacy OAuth grant on disk — wipe it so the user pastes an access token.
      this.token = null
      this.persistToken()
      return
    }
    this.token = accepted
    if (!this.token) return
    const startEpoch = this.epoch
    const sessionToken = this.token
    try {
      this.persistToken()
    } catch {
      // Memory-only is fine for this run.
    }
    try {
      const user = await this.client.whoAmI()
      if (this.epoch !== startEpoch || this.token !== sessionToken) return
      this.clearRetry()
      this.setState(this.signedInState(user))
    } catch (err) {
      if (this.epoch !== startEpoch || this.token !== sessionToken) return
      if (isUnauthorized(err)) {
        // Definitive 401 only: the token was revoked. A 403 (WAF challenge,
        // geo block, proxy) is transient and must never wipe stored credentials.
        await this.signOut()
        return
      }
      console.warn('[auth] whoAmI failed at startup', err)
      this.scheduleRetry()
    }
  }

  /**
   * Deleting ~/.oh_my_hf/credentials.json is the documented "sign out
   * everywhere" gesture; honor it for running sessions too. Watching the
   * directory (not the file) survives the atomic rename-based rewrites.
   */
  private ensureCredentialsWatch(): void {
    if (this.credentialsWatcher) return
    const file = credentialsFile()
    try {
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
      const watcher = watch(join(file, '..'), (_event, filename) => {
        if (filename && filename !== 'credentials.json') return
        if (this.watchDebounce) clearTimeout(this.watchDebounce)
        this.watchDebounce = setTimeout(() => {
          this.watchDebounce = null
          this.onCredentialsFsEvent()
        }, WATCH_DEBOUNCE_MS)
        this.watchDebounce.unref?.()
      })
      watcher.on('error', (err) => {
        console.warn('[auth] credentials watch failed', err)
        watcher.close()
        if (this.credentialsWatcher === watcher) this.credentialsWatcher = null
      })
      watcher.unref?.()
      this.credentialsWatcher = watcher
    } catch (err) {
      // Best effort: without a watcher the delete-to-sign-out contract only
      // applies at the next startup.
      console.warn('[auth] cannot watch shared credentials', err)
    }
  }

  private onCredentialsFsEvent(): void {
    // Our own persistToken() writes/removals must not loop back into a sign-out.
    if (this.persisting || !this.tokenOnDisk) return
    if (this.state.status !== 'signedIn' || !this.token) return
    if (existsSync(credentialsFile())) return
    // Another session (or the user) deleted the file: drop the in-memory
    // session too, without re-deleting anything.
    console.warn('[auth] shared credentials removed externally; signing out this session')
    this.epoch += 1
    this.clearRetry()
    this.token = null
    this.tokenOnDisk = false
    this.client.invalidateCache()
    this.setState({ status: 'signedOut' })
  }

  /** Periodic whoAmI while signed in, so a token revoked mid-run is detected. */
  private scheduleRevalidate(): void {
    if (this.revalidateTimer) clearTimeout(this.revalidateTimer)
    this.revalidateTimer = setTimeout(
      () => {
        void this.revalidate()
      },
      REVALIDATE_MS + Math.random() * REVALIDATE_JITTER_MS
    )
    this.revalidateTimer.unref?.()
  }

  private clearRevalidate(): void {
    if (this.revalidateTimer) clearTimeout(this.revalidateTimer)
    this.revalidateTimer = null
  }

  private async revalidate(): Promise<void> {
    if (this.state.status !== 'signedIn' || !this.token) return
    if (this.revalidateInFlight) {
      this.scheduleRevalidate()
      return
    }
    this.revalidateInFlight = true
    const startEpoch = this.epoch
    try {
      await this.client.whoAmI()
    } catch (err) {
      if (this.epoch === startEpoch && isUnauthorized(err)) {
        console.warn('[auth] session token was revoked; signing out')
        await this.signOut()
        return
      }
      // Transient (network/5xx/403): keep the session and try again next cycle.
    } finally {
      this.revalidateInFlight = false
    }
    if (this.epoch === startEpoch && this.state.status === 'signedIn') this.scheduleRevalidate()
  }

  /**
   * Sign in with a pasted User Access Token. The candidate is validated with
   * an out-of-band, deadline-bounded whoAmI and NOTHING is touched until it
   * proves valid: a failed, slow, or hung paste leaves the current session
   * and the shared credentials file exactly as they were.
   */
  async signInWithToken(raw: string): Promise<TokenSignInResult> {
    const accessToken = raw.trim()
    if (!accessToken) return { ok: false, error: 'invalid' }
    const startEpoch = this.epoch
    let validated: { user: UserProfile; tokenDisplayName?: string; tokenRole?: string }
    try {
      validated = await this.client.whoAmIWithToken(accessToken)
    } catch (err) {
      // 'invalid' only on a definitive 401; a 403 (WAF/geo/proxy block) does
      // not condemn the token.
      return {
        ok: false,
        error: isUnauthorized(err) ? 'invalid' : isForbidden(err) ? 'forbidden' : 'network'
      }
    }
    if (this.epoch !== startEpoch) {
      // The user signed out (or in) mid-validation; that newer intent owns
      // the session — discard the candidate without touching anything.
      return { ok: false, error: 'network' }
    }
    this.epoch += 1
    this.clearRetry()
    this.token = {
      accessToken,
      mode: 'token',
      tokenDisplayName: validated.tokenDisplayName,
      tokenRole: validated.tokenRole
    }
    try {
      this.persistToken()
    } catch {
      // Memory-only is fine for this run.
    }
    this.client.invalidateCache()
    this.setState(this.signedInState(validated.user))
    return { ok: true, state: this.state }
  }

  /**
   * Install a captured Hub web-session cookie as the supplemental credential.
   * Requires an existing token session (the cookie augments it, never replaces
   * it) and validates out of band with the same epoch discipline as
   * signInWithToken: nothing is touched until the cookie proves valid, and a
   * cookie that belongs to a different account than the token session is
   * rejected before persistence.
   */
  async connectHubSession(cookie: string): Promise<HubSessionConnectResult> {
    const trimmed = cookie.trim()
    if (!trimmed || this.state.status !== 'signedIn' || !this.token) {
      return { ok: false, error: 'invalid' }
    }
    const sessionUser = this.state.user
    const startEpoch = this.epoch
    let validated: { user: UserProfile }
    try {
      validated = await this.client.whoAmIWithCookie(trimmed)
    } catch (err) {
      // Same 401/403 split as signInWithToken: only a definitive 401 marks
      // the cookie invalid.
      return {
        ok: false,
        error: isUnauthorized(err) ? 'invalid' : isForbidden(err) ? 'forbidden' : 'network'
      }
    }
    if (this.epoch !== startEpoch || this.state.status !== 'signedIn' || !this.token) {
      // The user signed out (or re-signed-in) mid-validation; newer intent wins.
      return { ok: false, error: 'network' }
    }
    if (validated.user.name.toLowerCase() !== sessionUser.name.toLowerCase()) {
      return { ok: false, error: 'mismatch' }
    }
    this.token = { ...this.token, sessionCookie: trimmed, sessionUsername: validated.user.name }
    try {
      this.persistToken()
    } catch {
      // Memory-only is fine for this run (mirrors init()).
    }
    this.setState(this.signedInState(sessionUser))
    return { ok: true, state: this.state }
  }

  /**
   * Drop the web-session cookie, keeping the token session signed in. Also the
   * landing point when a cookie-backed call comes back 401 (cookie expired).
   */
  async disconnectHubSession(): Promise<AuthState> {
    if (this.token?.sessionCookie) {
      const { sessionCookie: _cookie, sessionUsername: _name, ...rest } = this.token
      this.token = rest
      try {
        this.persistToken()
      } catch {
        // Memory-only is fine for this run.
      }
      if (this.state.status === 'signedIn') {
        this.setState(this.signedInState(this.state.user))
      }
    }
    return this.state
  }

  /**
   * Re-fetch whoami and broadcast the updated profile (avatar, fullname, …).
   * Soft-fails on transient errors so a successful profile save still returns
   * to the caller. Busts Chromium's HTTP cache for stable `/avatars/` URLs.
   */
  async refreshUser(): Promise<AuthState> {
    if (this.state.status !== 'signedIn' || !this.token) return this.state
    const startEpoch = this.epoch
    const sessionToken = this.token
    try {
      const user = await this.client.whoAmI()
      if (this.epoch !== startEpoch || this.token !== sessionToken) return this.state
      this.setState(
        this.signedInState({
          ...user,
          avatarUrl: bustAvatarCache(user.avatarUrl, this.client.baseUrl)
        })
      )
    } catch (err) {
      if (this.epoch !== startEpoch || this.token !== sessionToken) return this.state
      console.warn('[auth] refreshUser failed', err)
    }
    return this.state
  }

  async signOut(): Promise<AuthState> {
    this.epoch += 1
    this.clearRetry()
    this.token = null
    try {
      this.persistToken()
    } catch (err) {
      // The file may linger on disk; this session still signs out cleanly.
      console.warn('[auth] failed to remove persisted credentials', err)
    }
    this.client.invalidateCache()
    this.setState({ status: 'signedOut' })
    return this.state
  }
}

/** Append ?v= so Chromium does not keep a stale Hub /avatars/… image. */
function bustAvatarCache(url: string | undefined, endpoint?: string | null): string | undefined {
  if (!url) return undefined
  try {
    const abs = hubRelativeUrl(url, endpoint)
    const parsed = new URL(abs)
    if (!parsed.pathname.includes('/avatars/')) return abs
    parsed.searchParams.set('v', String(Date.now()))
    return parsed.toString()
  } catch {
    return url
  }
}
