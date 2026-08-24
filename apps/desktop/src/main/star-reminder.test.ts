import { describe, expect, it } from 'vitest'
import type { AppDatabase } from './db'
import {
  STAR_REMINDER_KV_KEY,
  STAR_REMINDER_MAX_PROMPTS,
  STAR_REMINDER_MIN_SESSIONS,
  STAR_REMINDER_SNOOZE_MS,
  StarReminderService
} from './star-reminder'

/**
 * better-sqlite3 is compiled for Electron's ABI, while Vitest runs on Node.
 * This small transactional kv fake exercises the service without loading the
 * native binding. Its IMMEDIATE wrapper snapshots state so thrown callbacks
 * have the same rollback behavior as SQLite.
 */
function createKvDb(initial: Record<string, string> = {}): {
  db: AppDatabase
  values: Map<string, string>
  immediateCalls: () => number
} {
  const values = new Map(Object.entries(initial))
  let immediateCalls = 0

  const runTransaction = <T>(fn: () => T): T => {
    const before = new Map(values)
    try {
      return fn()
    } catch (error) {
      values.clear()
      for (const [key, value] of before) values.set(key, value)
      throw error
    }
  }

  const db = {
    prepare(sql: string) {
      if (sql.startsWith('SELECT value FROM kv')) {
        return {
          get: (key: string) => {
            const value = values.get(key)
            return value === undefined ? undefined : { value }
          }
        }
      }
      if (sql.startsWith('INSERT INTO kv')) {
        return {
          run: (key: string, value: string) => {
            values.set(key, value)
            return { changes: 1 }
          }
        }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    transaction<T>(fn: () => T) {
      const wrapped = () => runTransaction(fn)
      wrapped.deferred = wrapped
      wrapped.immediate = () => {
        immediateCalls += 1
        return runTransaction(fn)
      }
      wrapped.exclusive = wrapped
      return wrapped
    }
  } as unknown as AppDatabase

  return { db, values, immediateCalls: () => immediateCalls }
}

let nextClaimId = 1

function uniqueClaimId(): string {
  const suffix = (nextClaimId++).toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${suffix}`
}

function makeService({
  db = createKvDb().db,
  eligible = () => true,
  clock = { now: 1_700_000_000_000 },
  createClaimId = uniqueClaimId
}: {
  db?: AppDatabase
  eligible?: () => boolean
  clock?: { now: number }
  createClaimId?: () => string
} = {}): { service: StarReminderService; clock: { now: number } } {
  return {
    service: new StarReminderService({
      db,
      hasMeaningfulActivity: eligible,
      now: () => clock.now,
      createClaimId
    }),
    clock
  }
}

function startSessions(service: StarReminderService, count: number): void {
  for (let i = 0; i < count; i += 1) service.sessionStart()
}

describe('StarReminderService', () => {
  it('atomically counts session starts in one dedicated kv row', () => {
    const backing = createKvDb()
    const first = makeService({ db: backing.db }).service
    const second = makeService({ db: backing.db }).service

    first.sessionStart()
    second.sessionStart()
    first.sessionStart()

    expect(first.getState()).toMatchObject({
      sessionCount: 3,
      promptCount: 0,
      terminal: null
    })
    expect(backing.immediateCalls()).toBe(3)
    expect([...backing.values.keys()]).toEqual([STAR_REMINDER_KV_KEY])
  })

  it('requires three launches and meaningful activity before reserving a claim', () => {
    let meaningful = false
    let checks = 0
    const { service, clock } = makeService({
      eligible: () => {
        checks += 1
        return meaningful
      }
    })

    startSessions(service, STAR_REMINDER_MIN_SESSIONS - 1)
    expect(service.claim()).toBeNull()
    expect(checks).toBe(0)

    service.sessionStart()
    expect(service.claim()).toBeNull()
    expect(checks).toBe(1)
    expect(service.getState().promptCount).toBe(0)

    meaningful = true
    expect(service.claim()).toMatchObject({
      claimId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      reservedAt: clock.now
    })
    expect(service.getState()).toMatchObject({
      sessionCount: STAR_REMINDER_MIN_SESSIONS,
      promptCount: 0,
      lastReservedSession: STAR_REMINDER_MIN_SESSIONS,
      lastPromptedAt: null,
      activeClaimId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      activeClaimReservedAt: clock.now,
      activePromptNumber: null
    })
  })

  it('clears an unacknowledged reservation on session start without burning a display', () => {
    const backing = createKvDb()
    const first = makeService({ db: backing.db }).service
    startSessions(first, STAR_REMINDER_MIN_SESSIONS)
    const abandoned = first.claim()!
    // Renderer reloads/retries recover the same reservation and token.
    expect(first.claim()).toEqual(abandoned)
    expect(first.getState().promptCount).toBe(0)

    const restarted = makeService({ db: backing.db }).service
    restarted.sessionStart()
    expect(restarted.getState()).toMatchObject({
      promptCount: 0,
      lastPromptedAt: null,
      activeClaimId: null,
      activeClaimReservedAt: null,
      activePromptNumber: null
    })
    const replacement = restarted.claim()!
    expect(replacement.claimId).not.toBe(abandoned.claimId)
    expect(restarted.getState().promptCount).toBe(0)
  })

  it('acknowledges a visible claim exactly once and assigns its prompt number', () => {
    const backing = createKvDb()
    const { service, clock } = makeService({ db: backing.db })
    startSessions(service, STAR_REMINDER_MIN_SESSIONS)
    const claim = service.claim()!
    const guessed = 'ffffffff-ffff-4fff-bfff-ffffffffffff'

    expect(service.acknowledgeShown(guessed)).toEqual({ accepted: false })
    expect(service.acknowledgeShown('not-a-token')).toEqual({ accepted: false })
    expect(service.getState().promptCount).toBe(0)

    expect(service.acknowledgeShown(claim.claimId)).toEqual({
      accepted: true,
      promptNumber: 1,
      newlyAccepted: true
    })
    expect(service.acknowledgeShown(claim.claimId)).toEqual({
      accepted: true,
      promptNumber: 1,
      newlyAccepted: false
    })
    expect(service.claim()).toEqual(claim)
    expect(service.getState()).toMatchObject({
      promptCount: 1,
      lastPromptedAt: clock.now,
      activeClaimId: claim.claimId,
      activePromptNumber: 1
    })
  })

  it('allows respond only after acknowledgement and consumes the token once', () => {
    const { service } = makeService()
    startSessions(service, STAR_REMINDER_MIN_SESSIONS)
    const claim = service.claim()!

    expect(service.respond(claim.claimId, 'later')).toEqual({ accepted: false })
    expect(service.getState()).toMatchObject({ promptCount: 0, activeClaimId: claim.claimId })

    expect(service.acknowledgeShown(claim.claimId)).toMatchObject({ accepted: true })
    expect(service.respond(claim.claimId, 'later')).toEqual({
      accepted: true,
      outcome: 'snoozed',
      promptNumber: 1
    })
    expect(service.respond(claim.claimId, 'open')).toEqual({ accepted: false })
    expect(service.acknowledgeShown(claim.claimId)).toEqual({ accepted: false })
  })

  it('snoozes the first later for exactly 30 days and exhausts the second', () => {
    const { service, clock } = makeService()
    startSessions(service, STAR_REMINDER_MIN_SESSIONS)
    const first = service.claim()!
    expect(service.acknowledgeShown(first.claimId)).toEqual({
      accepted: true,
      promptNumber: 1,
      newlyAccepted: true
    })

    const closedAt = clock.now
    expect(service.respond(first.claimId, 'later')).toEqual({
      accepted: true,
      outcome: 'snoozed',
      promptNumber: 1
    })
    expect(service.getState()).toMatchObject({
      promptCount: 1,
      snoozedUntil: closedAt + STAR_REMINDER_SNOOZE_MS,
      terminal: null,
      activeClaimId: null,
      activePromptNumber: null
    })

    service.sessionStart()
    clock.now = closedAt + STAR_REMINDER_SNOOZE_MS - 1
    expect(service.claim()).toBeNull()

    // The exact boundary is eligible; no additional first-seen delay applies.
    clock.now = closedAt + STAR_REMINDER_SNOOZE_MS
    const second = service.claim()!
    expect(second).toMatchObject({ reservedAt: clock.now })
    expect(service.acknowledgeShown(second.claimId)).toEqual({
      accepted: true,
      promptNumber: 2,
      newlyAccepted: true
    })
    expect(service.respond(second.claimId, 'later')).toEqual({
      accepted: true,
      outcome: 'exhausted',
      promptNumber: 2
    })
    expect(service.getState()).toMatchObject({
      promptCount: STAR_REMINDER_MAX_PROMPTS,
      snoozedUntil: null,
      terminal: 'exhausted',
      activeClaimId: null,
      activePromptNumber: null
    })

    clock.now += 365 * 24 * 60 * 60 * 1000
    service.sessionStart()
    expect(service.claim()).toBeNull()
  })

  it.each([
    ['open', 'opened'],
    ['disable', 'disabled']
  ] as const)('%s permanently ends the reminder', (action, terminal) => {
    const backing = createKvDb()
    const { service } = makeService({ db: backing.db })
    startSessions(service, STAR_REMINDER_MIN_SESSIONS)
    const claim = service.claim()!
    expect(service.acknowledgeShown(claim.claimId)).toEqual({
      accepted: true,
      promptNumber: 1,
      newlyAccepted: true
    })

    expect(service.respond(claim.claimId, action)).toEqual({
      accepted: true,
      outcome: terminal,
      promptNumber: 1
    })

    // Persistence, not an in-memory flag, prevents future prompts.
    const restarted = makeService({ db: backing.db }).service
    restarted.sessionStart()
    expect(restarted.claim()).toBeNull()
    expect(restarted.getState().terminal).toBe(terminal)
  })

  it('never acknowledges more than two visible displays even across renderer exits', () => {
    const backing = createKvDb()
    const first = makeService({ db: backing.db }).service
    startSessions(first, STAR_REMINDER_MIN_SESSIONS)
    const firstClaim = first.claim()!
    expect(first.acknowledgeShown(firstClaim.claimId)).toEqual({
      accepted: true,
      promptNumber: 1,
      newlyAccepted: true
    })

    const second = makeService({ db: backing.db }).service
    second.sessionStart()
    expect(second.getState().activeClaimId).toBeNull()
    const secondClaim = second.claim()!
    expect(second.acknowledgeShown(secondClaim.claimId)).toEqual({
      accepted: true,
      promptNumber: 2,
      newlyAccepted: true
    })

    const third = makeService({ db: backing.db }).service
    third.sessionStart()
    expect(third.claim()).toBeNull()
    expect(third.getState().promptCount).toBe(STAR_REMINDER_MAX_PROMPTS)
  })

  it('returns newlyAccepted for only one of two competing acknowledgements', () => {
    const backing = createKvDb()
    const owner = makeService({ db: backing.db }).service
    startSessions(owner, STAR_REMINDER_MIN_SESSIONS)
    const claim = owner.claim()!

    const first = makeService({ db: backing.db }).service
    const second = makeService({ db: backing.db }).service
    expect(first.acknowledgeShown(claim.claimId)).toEqual({
      accepted: true,
      promptNumber: 1,
      newlyAccepted: true
    })
    expect(second.acknowledgeShown(claim.claimId)).toEqual({
      accepted: true,
      promptNumber: 1,
      newlyAccepted: false
    })
    expect(owner.getState().promptCount).toBe(1)
  })

  it('atomically accepts only one of two competing responses', () => {
    const backing = createKvDb()
    const owner = makeService({ db: backing.db }).service
    startSessions(owner, STAR_REMINDER_MIN_SESSIONS)
    const claim = owner.claim()!
    owner.acknowledgeShown(claim.claimId)

    const firstResponder = makeService({ db: backing.db }).service
    const secondResponder = makeService({ db: backing.db }).service
    expect(firstResponder.respond(claim.claimId, 'later')).toEqual({
      accepted: true,
      outcome: 'snoozed',
      promptNumber: 1
    })
    expect(secondResponder.respond(claim.claimId, 'open')).toEqual({ accepted: false })
    expect(owner.getState()).toMatchObject({
      terminal: null,
      activeClaimId: null,
      promptCount: 1
    })
  })

  it('rejects guessed and stale response tokens without consuming the real one', () => {
    const { service } = makeService()
    startSessions(service, STAR_REMINDER_MIN_SESSIONS)
    const claim = service.claim()!
    service.acknowledgeShown(claim.claimId)
    const guessed = 'ffffffff-ffff-4fff-bfff-ffffffffffff'

    expect(service.respond(guessed, 'later')).toEqual({ accepted: false })
    expect(service.respond('not-a-token', 'later')).toEqual({ accepted: false })
    expect(service.getState().activeClaimId).toBe(claim.claimId)
    expect(() => service.respond(claim.claimId, 'unknown' as never)).toThrowError(
      'Unknown star reminder action: unknown'
    )
    expect(service.respond(claim.claimId, 'open')).toMatchObject({ accepted: true })
  })

  it('rolls back a claim when the meaningful-activity predicate throws', () => {
    let shouldThrow = true
    const { service } = makeService({
      eligible: () => {
        if (shouldThrow) throw new Error('activity query failed')
        return true
      }
    })
    startSessions(service, STAR_REMINDER_MIN_SESSIONS)

    expect(() => service.claim()).toThrowError('activity query failed')
    expect(service.getState().promptCount).toBe(0)

    shouldThrow = false
    expect(service.claim()).toMatchObject({ claimId: expect.any(String) })
  })

  it('rolls back a claim when the token source is not a random UUID v4', () => {
    const { service } = makeService({ createClaimId: () => 'predictable' })
    startSessions(service, STAR_REMINDER_MIN_SESSIONS)

    expect(() => service.claim()).toThrowError(
      'Star reminder claim id source must return a random UUID v4'
    )
    expect(service.getState()).toMatchObject({ promptCount: 0, activeClaimId: null })
  })

  it('recovers malformed persisted state without bypassing the launch threshold', () => {
    const backing = createKvDb({ [STAR_REMINDER_KV_KEY]: '{not-json' })
    const service = makeService({ db: backing.db }).service

    expect(service.getState()).toMatchObject({ sessionCount: 0, promptCount: 0, terminal: null })
    startSessions(service, STAR_REMINDER_MIN_SESSIONS - 1)
    expect(service.claim()).toBeNull()
    service.sessionStart()
    expect(service.claim()).toMatchObject({ claimId: expect.any(String) })
  })

  it('rejects an invalid injected clock without consuming a prompt', () => {
    const clock = { now: Number.NaN }
    const { service } = makeService({ clock })
    startSessions(service, STAR_REMINDER_MIN_SESSIONS)

    expect(() => service.claim()).toThrowError(
      'Star reminder clock must return a non-negative finite timestamp'
    )
    expect(service.getState().promptCount).toBe(0)
  })

  it('rolls back acknowledgement and later when the injected clock fails', () => {
    const clock = { now: 1_700_000_000_000 }
    const { service } = makeService({ clock })
    startSessions(service, STAR_REMINDER_MIN_SESSIONS)
    const claim = service.claim()!

    clock.now = Number.NaN
    expect(() => service.acknowledgeShown(claim.claimId)).toThrowError(
      'Star reminder clock must return a non-negative finite timestamp'
    )
    expect(service.getState()).toMatchObject({
      promptCount: 0,
      activeClaimId: claim.claimId,
      activePromptNumber: null
    })

    clock.now = 1_700_000_000_001
    expect(service.acknowledgeShown(claim.claimId)).toEqual({
      accepted: true,
      promptNumber: 1,
      newlyAccepted: true
    })
    clock.now = Number.NaN
    expect(() => service.respond(claim.claimId, 'later')).toThrowError(
      'Star reminder clock must return a non-negative finite timestamp'
    )
    expect(service.getState()).toMatchObject({
      activeClaimId: claim.claimId,
      activePromptNumber: 1,
      snoozedUntil: null
    })

    clock.now = 1_700_000_000_002
    expect(service.respond(claim.claimId, 'later')).toMatchObject({
      accepted: true,
      outcome: 'snoozed'
    })
  })
})
