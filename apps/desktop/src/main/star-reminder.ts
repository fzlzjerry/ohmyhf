import { randomUUID } from 'node:crypto'
import type { AppDatabase } from './db'

export const STAR_REMINDER_KV_KEY = 'star-reminder:v1'
export const STAR_REMINDER_MIN_SESSIONS = 3
export const STAR_REMINDER_MAX_PROMPTS = 2
export const STAR_REMINDER_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000

const STATE_VERSION = 1 as const

export type StarReminderTerminal = 'opened' | 'disabled' | 'exhausted'
export type StarReminderAction = 'open' | 'later' | 'disable'
export type StarReminderOutcome = 'opened' | 'snoozed' | 'exhausted' | 'disabled'

/**
 * Device-local state for the low-frequency GitHub star reminder. This is kept
 * outside AppSettings so importing preferences cannot reset a previous opt-out.
 */
export interface StarReminderState {
  version: typeof STATE_VERSION
  sessionCount: number
  promptCount: number
  snoozedUntil: number | null
  terminal: StarReminderTerminal | null
  lastReservedSession: number | null
  lastPromptedAt: number | null
  activeClaimId: string | null
  activeClaimReservedAt: number | null
  activePromptNumber: number | null
}

/** A reservation; it consumes no display until acknowledgeShown() succeeds. */
export interface StarReminderClaim {
  claimId: string
  reservedAt: number
}

export type StarReminderAcknowledge =
  { accepted: false } | { accepted: true; promptNumber: number; newlyAccepted: boolean }

export type StarReminderResponse =
  { accepted: false } | { accepted: true; outcome: StarReminderOutcome; promptNumber: number }

export interface StarReminderOptions {
  db: AppDatabase
  /**
   * A cheap, synchronous predicate such as `SELECT EXISTS(...)`. It should
   * become true after the user completes at least one meaningful action.
   */
  hasMeaningfulActivity: () => boolean
  /** Epoch-millisecond clock, injectable for deterministic tests. */
  now?: () => number
  /** Cryptographically random claim-token source, injectable for deterministic tests. */
  createClaimId?: () => string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function defaultState(): StarReminderState {
  return {
    version: STATE_VERSION,
    sessionCount: 0,
    promptCount: 0,
    snoozedUntil: null,
    terminal: null,
    lastReservedSession: null,
    lastPromptedAt: null,
    activeClaimId: null,
    activeClaimReservedAt: null,
    activePromptNumber: null
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isOptionalTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isTerminal(value: unknown): value is StarReminderTerminal | null {
  return value === null || value === 'opened' || value === 'disabled' || value === 'exhausted'
}

function isClaimId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * Treat malformed state as a fresh install rather than letting corrupt JSON
 * break app startup. A fresh state still needs three subsequent session starts
 * and meaningful activity before it can claim a prompt.
 */
function parseState(value: string): StarReminderState {
  try {
    const raw = JSON.parse(value) as Partial<StarReminderState>
    if (
      raw.version !== STATE_VERSION ||
      !isNonNegativeInteger(raw.sessionCount) ||
      !isNonNegativeInteger(raw.promptCount) ||
      raw.promptCount > STAR_REMINDER_MAX_PROMPTS ||
      !isOptionalTimestamp(raw.snoozedUntil) ||
      !isTerminal(raw.terminal) ||
      !isOptionalTimestamp(raw.lastPromptedAt) ||
      !(
        raw.lastReservedSession === null ||
        (isNonNegativeInteger(raw.lastReservedSession) &&
          raw.lastReservedSession <= raw.sessionCount)
      ) ||
      !(raw.activeClaimId === null || isClaimId(raw.activeClaimId)) ||
      !isOptionalTimestamp(raw.activeClaimReservedAt) ||
      !(
        raw.activePromptNumber === null ||
        (isNonNegativeInteger(raw.activePromptNumber) &&
          raw.activePromptNumber >= 1 &&
          raw.activePromptNumber <= raw.promptCount)
      ) ||
      (raw.activeClaimId === null &&
        (raw.activeClaimReservedAt !== null || raw.activePromptNumber !== null)) ||
      (raw.activeClaimId !== null &&
        (raw.activeClaimReservedAt === null ||
          raw.lastReservedSession === null ||
          raw.terminal !== null ||
          (raw.activePromptNumber !== null && raw.lastPromptedAt === null)))
    ) {
      return defaultState()
    }
    return raw as StarReminderState
  } catch {
    return defaultState()
  }
}

function assertAction(value: string): asserts value is StarReminderAction {
  if (value !== 'open' && value !== 'later' && value !== 'disable') {
    throw new TypeError(`Unknown star reminder action: ${value}`)
  }
}

/**
 * Persistent state machine for the optional GitHub star reminder.
 *
 * Every read-modify-write operation uses a better-sqlite3 IMMEDIATE
 * transaction. In particular, `sessionStart()` cannot lose an increment when
 * two app processes briefly overlap during development.
 */
export class StarReminderService {
  private readonly now: () => number
  private readonly createClaimId: () => string

  constructor(private readonly options: StarReminderOptions) {
    this.now = options.now ?? Date.now
    this.createClaimId = options.createClaimId ?? randomUUID
  }

  /** Atomically records one real main-process launch. Call exactly once at startup. */
  sessionStart(): StarReminderState {
    return this.mutate((state) => {
      if (state.sessionCount < Number.MAX_SAFE_INTEGER) state.sessionCount += 1
      // An unacknowledged reservation never consumed a display. An acknowledged
      // prompt already incremented promptCount, so clearing either form is safe.
      state.activeClaimId = null
      state.activeClaimReservedAt = null
      state.activePromptNumber = null
      return state
    })
  }

  /** Read the normalized persisted state without changing eligibility. */
  getState(): StarReminderState {
    return this.read()
  }

  /**
   * Atomically reserves one display opportunity. The lifetime counter changes
   * only after the renderer acknowledges that the card is actually visible.
   */
  claim(): StarReminderClaim | null {
    return this.mutate((state, save) => {
      if (state.terminal !== null) return null
      if (
        state.lastReservedSession === state.sessionCount &&
        state.activeClaimId !== null &&
        state.activeClaimReservedAt !== null
      ) {
        return {
          claimId: state.activeClaimId,
          reservedAt: state.activeClaimReservedAt
        }
      }
      if (state.sessionCount < STAR_REMINDER_MIN_SESSIONS) return null
      if (state.promptCount >= STAR_REMINDER_MAX_PROMPTS) return null
      const now = this.readNow()
      if (state.snoozedUntil !== null && now < state.snoozedUntil) return null
      if (state.lastReservedSession === state.sessionCount) return null
      if (!this.options.hasMeaningfulActivity()) return null

      const claimId = this.createClaimId()
      if (!isClaimId(claimId)) {
        throw new Error('Star reminder claim id source must return a random UUID v4')
      }
      state.lastReservedSession = state.sessionCount
      state.activeClaimId = claimId
      state.activeClaimReservedAt = now
      state.activePromptNumber = null
      save()
      return { claimId, reservedAt: now }
    })
  }

  /**
   * Confirms that a reserved card reached the visible renderer. The first
   * acknowledgement consumes the display; retries recover the same number with
   * newlyAccepted=false so a lost IPC response cannot burn the reservation.
   */
  acknowledgeShown(claimId: string): StarReminderAcknowledge {
    if (!isClaimId(claimId)) return { accepted: false }
    return this.mutate((state, save) => {
      if (
        state.terminal === null &&
        state.activeClaimId === claimId &&
        state.activePromptNumber !== null
      ) {
        return {
          accepted: true,
          promptNumber: state.activePromptNumber,
          newlyAccepted: false
        }
      }
      if (
        state.terminal !== null ||
        state.activeClaimId !== claimId ||
        state.promptCount >= STAR_REMINDER_MAX_PROMPTS
      ) {
        return { accepted: false }
      }

      state.promptCount += 1
      state.lastPromptedAt = this.readNow()
      state.activePromptNumber = state.promptCount
      save()
      return { accepted: true, promptNumber: state.promptCount, newlyAccepted: true }
    })
  }

  /**
   * Resolves an acknowledged prompt. The claim token is consumed in the same
   * IMMEDIATE transaction as its outcome, so competing replies cannot both win.
   */
  respond(claimId: string, action: StarReminderAction): StarReminderResponse {
    assertAction(action)
    if (!isClaimId(claimId)) return { accepted: false }
    return this.mutate((state, save) => {
      if (
        state.terminal !== null ||
        state.activeClaimId !== claimId ||
        state.activePromptNumber === null
      ) {
        return { accepted: false }
      }

      const promptNumber = state.activePromptNumber
      state.activeClaimId = null
      state.activeClaimReservedAt = null
      state.activePromptNumber = null
      let outcome: StarReminderOutcome
      if (action === 'open') {
        state.terminal = 'opened'
        state.snoozedUntil = null
        outcome = 'opened'
      } else if (action === 'disable') {
        state.terminal = 'disabled'
        state.snoozedUntil = null
        outcome = 'disabled'
      } else if (state.promptCount >= STAR_REMINDER_MAX_PROMPTS) {
        state.terminal = 'exhausted'
        state.snoozedUntil = null
        outcome = 'exhausted'
      } else {
        state.snoozedUntil = this.readNow() + STAR_REMINDER_SNOOZE_MS
        outcome = 'snoozed'
      }
      save()
      return { accepted: true, outcome, promptNumber }
    })
  }

  private readNow(): number {
    const value = this.now()
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('Star reminder clock must return a non-negative finite timestamp')
    }
    return Math.trunc(value)
  }

  private read(): StarReminderState {
    const row = this.options.db
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(STAR_REMINDER_KV_KEY) as { value: string } | undefined
    return row ? parseState(row.value) : defaultState()
  }

  private write(state: StarReminderState): void {
    this.options.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(STAR_REMINDER_KV_KEY, JSON.stringify(state))
  }

  /**
   * `save()` is exposed to the callback for the uncommon case where a method
   * returns a non-state result. If it is not called, changed state is persisted
   * automatically when the callback returns the state object.
   */
  private mutate<T>(update: (state: StarReminderState, save: () => void) => T): T {
    const transaction = this.options.db.transaction(() => {
      const state = this.read()
      let saved = false
      const save = (): void => {
        if (saved) return
        this.write(state)
        saved = true
      }
      const result = update(state, save)
      if (!saved && result === state) save()
      return result
    })
    return transaction.immediate()
  }
}
