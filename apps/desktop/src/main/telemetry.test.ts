import { DEFAULT_SETTINGS } from '@oh-my-huggingface/shared'
import { describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from './db'
import {
  applyExplicitTelemetryDecline,
  DEFAULT_POSTHOG_HOST,
  TelemetryService,
  type TelemetryEvent
} from './telemetry'

const INSTALL_ID_1 = '11111111-1111-4111-8111-111111111111'
const INSTALL_ID_2 = '22222222-2222-4222-8222-222222222222'
const CONSENT_CLAIM_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONSENT_CLAIM_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CONSENT_PROMPT_KEY = 'telemetry.consent-prompt.v1'
const INSTALLATION_ID_KEY = 'telemetry.installation-id.v1'

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
          get: (key: string) => (values.has(key) ? { value: values.get(key) } : undefined)
        }
      }
      if (sql.startsWith('INSERT INTO kv')) {
        return {
          run: (key: string, value: string) => {
            values.set(key, value)
          }
        }
      }
      if (sql.startsWith('INSERT OR IGNORE INTO kv')) {
        return {
          run: (key: string, value: string) => {
            if (values.has(key)) return { changes: 0 }
            values.set(key, value)
            return { changes: 1 }
          }
        }
      }
      if (sql.startsWith('DELETE FROM kv')) {
        return {
          run: (key: string) => {
            values.delete(key)
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

function successResponse(): Response {
  return new Response(null, { status: 200 })
}

function makeService(overrides: Partial<ConstructorParameters<typeof TelemetryService>[0]> = {}) {
  const { db, values, immediateCalls } = createKvDb()
  const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) => successResponse())
  const service = new TelemetryService({
    db,
    enabled: () => true,
    apiKey: 'phc_public_test_key',
    endpoint: 'https://us.i.posthog.com',
    appVersion: '1.2.3',
    platform: 'linux',
    arch: 'x64',
    locale: () => 'en',
    fetchImpl,
    createId: () => INSTALL_ID_1,
    createConsentClaimId: () => CONSENT_CLAIM_ID_1,
    ...overrides
  })
  return { service, fetchImpl, values, immediateCalls }
}

describe('TelemetryService', () => {
  it("defaults release builds to this repository's US Cloud ingestion region", () => {
    expect(DEFAULT_POSTHOG_HOST).toBe('https://us.i.posthog.com')
  })

  it('defaults new installations to telemetry on', () => {
    expect(DEFAULT_SETTINGS.telemetryEnabled).toBe(true)
  })

  it('persists and reuses one consent reservation across service instances', () => {
    const backing = createKvDb()
    const createFirstClaimId = vi.fn(() => CONSENT_CLAIM_ID_1)
    const first = makeService({
      db: backing.db,
      createConsentClaimId: createFirstClaimId
    })

    expect(first.service.isConfigured()).toBe(true)
    expect(first.service.claimConsentPrompt()).toEqual({ claimId: CONSENT_CLAIM_ID_1 })
    expect(first.service.claimConsentPrompt()).toEqual({ claimId: CONSENT_CLAIM_ID_1 })
    expect(createFirstClaimId).toHaveBeenCalledOnce()

    const createSecondClaimId = vi.fn(() => CONSENT_CLAIM_ID_2)
    const reloaded = makeService({
      db: backing.db,
      createConsentClaimId: createSecondClaimId
    })
    expect(reloaded.service.claimConsentPrompt()).toEqual({ claimId: CONSENT_CLAIM_ID_1 })
    expect(createSecondClaimId).not.toHaveBeenCalled()

    expect(first.fetchImpl).not.toHaveBeenCalled()
    expect(reloaded.fetchImpl).not.toHaveBeenCalled()
    expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)
    expect(JSON.parse(backing.values.get(CONSENT_PROMPT_KEY)!)).toEqual({
      version: 2,
      claimId: CONSENT_CLAIM_ID_1,
      status: 'reserved',
      resolution: null
    })
    expect(backing.immediateCalls()).toBe(3)
  })

  it('acknowledges display idempotently without resolving or consuming the claim', () => {
    const backing = createKvDb()
    const { service, fetchImpl } = makeService({ db: backing.db })
    const claim = service.claimConsentPrompt()
    expect(claim).toEqual({ claimId: CONSENT_CLAIM_ID_1 })
    if (claim === false) throw new Error('expected a consent claim')

    expect(service.acknowledgeConsentPrompt(CONSENT_CLAIM_ID_2)).toEqual({
      accepted: false,
      newlyAccepted: false
    })
    expect(service.acknowledgeConsentPrompt('not-a-uuid')).toEqual({
      accepted: false,
      newlyAccepted: false
    })
    expect(service.acknowledgeConsentPrompt(claim.claimId)).toEqual({
      accepted: true,
      newlyAccepted: true
    })
    expect(service.acknowledgeConsentPrompt(claim.claimId)).toEqual({
      accepted: true,
      newlyAccepted: false
    })
    expect(service.claimConsentPrompt()).toEqual({ claimId: CONSENT_CLAIM_ID_1 })
    const reloaded = makeService({
      db: backing.db,
      createConsentClaimId: () => CONSENT_CLAIM_ID_2
    })
    expect(reloaded.service.claimConsentPrompt()).toEqual({ claimId: CONSENT_CLAIM_ID_1 })

    expect(JSON.parse(backing.values.get(CONSENT_PROMPT_KEY)!)).toEqual({
      version: 2,
      claimId: CONSENT_CLAIM_ID_1,
      status: 'displayed',
      resolution: null
    })
    expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(reloaded.fetchImpl).not.toHaveBeenCalled()
    // claim + wrong-token ack + first ack + idempotent ack + two later claims.
    // The syntactically invalid UUID is rejected before touching SQLite.
    expect(backing.immediateCalls()).toBe(6)
  })

  it('resolves only an explicit decline from a displayed claim and is idempotent', () => {
    const { service, fetchImpl, values, immediateCalls } = makeService()
    const claim = service.claimConsentPrompt()
    if (claim === false) throw new Error('expected a consent claim')

    expect(service.resolveConsentPrompt(claim.claimId, 'decline')).toEqual({
      accepted: false,
      newlyResolved: false
    })
    expect(service.acknowledgeConsentPrompt(claim.claimId)).toEqual({
      accepted: true,
      newlyAccepted: true
    })
    expect(service.resolveConsentPrompt(CONSENT_CLAIM_ID_2, 'decline')).toEqual({
      accepted: false,
      newlyResolved: false
    })
    expect(service.resolveConsentPrompt('not-a-uuid', 'decline')).toEqual({
      accepted: false,
      newlyResolved: false
    })
    expect(service.resolveConsentPrompt(claim.claimId, 'decline')).toEqual({
      accepted: true,
      newlyResolved: true,
      decision: 'decline'
    })
    expect(service.resolveConsentPrompt(claim.claimId, 'decline')).toEqual({
      accepted: true,
      newlyResolved: false,
      decision: 'decline'
    })
    expect(service.acknowledgeConsentPrompt(claim.claimId)).toEqual({
      accepted: false,
      newlyAccepted: false
    })
    expect(service.claimConsentPrompt()).toBe(false)

    expect(JSON.parse(values.get(CONSENT_PROMPT_KEY)!)).toEqual({
      version: 2,
      claimId: CONSENT_CLAIM_ID_1,
      status: 'resolved',
      resolution: 'declined'
    })
    expect(values.has(INSTALLATION_ID_KEY)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    // Invalid UUIDs are rejected before SQLite. After a stored decline, a later
    // claim is a read-only status check and does not open a write transaction.
    // Every other operation is an IMMEDIATE transaction so competing renderers
    // cannot resolve twice.
    expect(immediateCalls()).toBe(7)
  })

  it('records explicit acceptance locally and recovers a corrupt consent row', () => {
    const corrupt = '{not-json'
    const backing = createKvDb({ [CONSENT_PROMPT_KEY]: corrupt })
    const createConsentClaimId = vi.fn(() => CONSENT_CLAIM_ID_2)
    const { service, fetchImpl } = makeService({
      db: backing.db,
      enabled: () => false,
      createConsentClaimId
    })

    expect(service.recordExplicitConsentAcceptance()).toBe(true)
    expect(service.recordExplicitConsentAcceptance()).toBe(true)
    expect(service.claimConsentPrompt()).toBe(false)
    expect(service.resolveConsentPrompt(CONSENT_CLAIM_ID_2, 'decline')).toEqual({
      accepted: false,
      newlyResolved: false
    })
    expect(JSON.parse(backing.values.get(CONSENT_PROMPT_KEY)!)).toEqual({
      version: 2,
      claimId: CONSENT_CLAIM_ID_2,
      status: 'resolved',
      resolution: 'accepted'
    })
    expect(createConsentClaimId).toHaveBeenCalledOnce()
    expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves the current claim when settings explicitly accept after display or decline', () => {
    const { service, values } = makeService()
    const claim = service.claimConsentPrompt()
    if (claim === false) throw new Error('expected a consent claim')
    service.acknowledgeConsentPrompt(claim.claimId)
    service.resolveConsentPrompt(claim.claimId, 'decline')

    expect(service.recordExplicitConsentAcceptance()).toBe(true)
    expect(JSON.parse(values.get(CONSENT_PROMPT_KEY)!)).toEqual({
      version: 2,
      claimId: claim.claimId,
      status: 'resolved',
      resolution: 'accepted'
    })
  })

  it('records a direct settings opt-out as decline without re-prompting a legacy state', () => {
    const backing = createKvDb({
      [CONSENT_PROMPT_KEY]: JSON.stringify({
        version: 1,
        claimId: CONSENT_CLAIM_ID_1,
        shown: true
      })
    })
    const { service, fetchImpl } = makeService({ db: backing.db, enabled: () => false })

    expect(service.recordExplicitConsentDecline()).toBe(true)
    expect(service.recordExplicitConsentDecline()).toBe(true)
    expect(service.claimConsentPrompt()).toBe(false)
    expect(JSON.parse(backing.values.get(CONSENT_PROMPT_KEY)!)).toEqual({
      version: 2,
      claimId: CONSENT_CLAIM_ID_1,
      status: 'resolved',
      resolution: 'declined'
    })
    expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('migrates both v0.0.11 shown states without losing their claim token', () => {
    for (const shown of [false, true]) {
      const backing = createKvDb({
        [CONSENT_PROMPT_KEY]: JSON.stringify({
          version: 1,
          claimId: CONSENT_CLAIM_ID_1,
          shown
        })
      })
      const { service, fetchImpl } = makeService({
        db: backing.db,
        createConsentClaimId: () => CONSENT_CLAIM_ID_2
      })

      expect(service.claimConsentPrompt()).toEqual({ claimId: CONSENT_CLAIM_ID_1 })
      expect(JSON.parse(backing.values.get(CONSENT_PROMPT_KEY)!)).toEqual({
        version: 2,
        claimId: CONSENT_CLAIM_ID_1,
        status: shown ? 'displayed' : 'reserved',
        resolution: null
      })
      expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('migrates an enabled v0.0.11 state to a reclaimable disclosure instead of treating it as accepted', () => {
    const backing = createKvDb({
      [CONSENT_PROMPT_KEY]: JSON.stringify({
        version: 1,
        claimId: CONSENT_CLAIM_ID_1,
        shown: true
      })
    })
    const { service, fetchImpl } = makeService({ db: backing.db })

    expect(service.claimConsentPrompt()).toEqual({ claimId: CONSENT_CLAIM_ID_1 })
    expect(JSON.parse(backing.values.get(CONSENT_PROMPT_KEY)!)).toEqual({
      version: 2,
      claimId: CONSENT_CLAIM_ID_1,
      status: 'displayed',
      resolution: null
    })
    expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('still offers the opt-out disclosure when telemetry is already enabled', () => {
    const { service, values, fetchImpl, immediateCalls } = makeService()

    expect(service.claimConsentPrompt()).toEqual({ claimId: CONSENT_CLAIM_ID_1 })
    expect(JSON.parse(values.get(CONSENT_PROMPT_KEY)!)).toEqual({
      version: 2,
      claimId: CONSENT_CLAIM_ID_1,
      status: 'reserved',
      resolution: null
    })
    expect(values.has(INSTALLATION_ID_KEY)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(immediateCalls()).toBe(1)
  })

  it('does not offer the opt-out disclosure when telemetry is already off', () => {
    const fresh = makeService({ enabled: () => false })
    expect(fresh.service.claimConsentPrompt()).toBe(false)
    expect(fresh.values.has(CONSENT_PROMPT_KEY)).toBe(false)
    expect(fresh.values.has(INSTALLATION_ID_KEY)).toBe(false)
    expect(fresh.fetchImpl).not.toHaveBeenCalled()
    expect(fresh.immediateCalls()).toBe(0)

    const backing = createKvDb({
      [CONSENT_PROMPT_KEY]: JSON.stringify({
        version: 1,
        claimId: CONSENT_CLAIM_ID_1,
        shown: true
      })
    })
    const upgraded = makeService({
      db: backing.db,
      enabled: () => false,
      createConsentClaimId: () => CONSENT_CLAIM_ID_2
    })

    expect(upgraded.service.claimConsentPrompt()).toBe(false)
    expect(backing.values.get(CONSENT_PROMPT_KEY)).toBe(
      JSON.stringify({
        version: 1,
        claimId: CONSENT_CLAIM_ID_1,
        shown: true
      })
    )
    expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)
    expect(upgraded.fetchImpl).not.toHaveBeenCalled()
    expect(upgraded.immediateCalls()).toBe(0)
  })

  it('treats only a resolved decline as an explicit opt-out', () => {
    expect(makeService().service.hasExplicitDecline()).toBe(false)
    expect(makeService({ enabled: () => false }).service.hasExplicitDecline()).toBe(false)

    const declined = createKvDb({
      [CONSENT_PROMPT_KEY]: JSON.stringify({
        version: 2,
        claimId: CONSENT_CLAIM_ID_1,
        status: 'resolved',
        resolution: 'declined'
      })
    })
    expect(makeService({ db: declined.db }).service.hasExplicitDecline()).toBe(true)

    const accepted = createKvDb({
      [CONSENT_PROMPT_KEY]: JSON.stringify({
        version: 2,
        claimId: CONSENT_CLAIM_ID_1,
        status: 'resolved',
        resolution: 'accepted'
      })
    })
    expect(makeService({ db: accepted.db }).service.hasExplicitDecline()).toBe(false)
  })

  it('forces the opt-out default off when a stored decline is present', () => {
    const backing = createKvDb({
      [CONSENT_PROMPT_KEY]: JSON.stringify({
        version: 2,
        claimId: CONSENT_CLAIM_ID_1,
        status: 'resolved',
        resolution: 'declined'
      }),
      [INSTALLATION_ID_KEY]: INSTALL_ID_1
    })
    let telemetryEnabled = true
    const settings = {
      get: () => ({ telemetryEnabled }),
      set: (patch: { telemetryEnabled: boolean }) => {
        telemetryEnabled = patch.telemetryEnabled
      }
    }
    const { service } = makeService({
      db: backing.db,
      enabled: () => telemetryEnabled
    })

    applyExplicitTelemetryDecline(settings, service)
    expect(telemetryEnabled).toBe(false)
    expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)

    applyExplicitTelemetryDecline(settings, service)
    expect(telemetryEnabled).toBe(false)
  })

  it('does not change an enabled setting when no explicit decline is stored', () => {
    let telemetryEnabled = true
    const settings = {
      get: () => ({ telemetryEnabled }),
      set: (patch: { telemetryEnabled: boolean }) => {
        telemetryEnabled = patch.telemetryEnabled
      }
    }
    const { service, values } = makeService({
      enabled: () => telemetryEnabled,
      createId: () => INSTALL_ID_1
    })

    applyExplicitTelemetryDecline(settings, service)
    expect(telemetryEnabled).toBe(true)
    expect(values.has(INSTALLATION_ID_KEY)).toBe(false)
  })

  it('contains settings persistence failures so startup can continue', async () => {
    const backing = createKvDb({
      [CONSENT_PROMPT_KEY]: JSON.stringify({
        version: 2,
        claimId: CONSENT_CLAIM_ID_1,
        status: 'resolved',
        resolution: 'declined'
      }),
      [INSTALLATION_ID_KEY]: INSTALL_ID_1
    })
    const settings = {
      get: () => ({ telemetryEnabled: true }),
      set: (): never => {
        throw new Error('sqlite readonly')
      }
    }
    const { service, fetchImpl, immediateCalls } = makeService({
      db: backing.db,
      enabled: () => settings.get().telemetryEnabled
    })

    expect(() => applyExplicitTelemetryDecline(settings, service)).not.toThrow()
    expect(settings.get().telemetryEnabled).toBe(true)
    expect(service.hasExplicitDecline()).toBe(true)
    expect(service.getStatus().enabled).toBe(false)
    expect(service.claimConsentPrompt()).toBe(false)
    expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)

    await expect(service.capture('app_launched')).resolves.toEqual({ status: 'skipped' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(immediateCalls()).toBe(0)
    expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)
  })

  it('does not create consent state when the build is unconfigured', () => {
    for (const { service, values, immediateCalls } of [
      makeService({ apiKey: '', enabled: () => false }),
      makeService({ fetchImpl: null, enabled: () => false }),
      makeService({ endpoint: 'http://posthog.test', enabled: () => false })
    ]) {
      expect(service.claimConsentPrompt()).toBe(false)
      expect(values.size).toBe(0)
      expect(immediateCalls()).toBe(0)
    }
  })

  it('strictly requires the injected consent token source to return UUIDv4', () => {
    for (const createConsentClaimId of [
      () => '11111111-1111-1111-8111-111111111111',
      () => 'predictable',
      () => {
        throw new Error('random source unavailable')
      }
    ]) {
      const { service, values, fetchImpl } = makeService({
        createConsentClaimId
      })
      expect(service.claimConsentPrompt()).toBe(false)
      expect(values.has(CONSENT_PROMPT_KEY)).toBe(false)
      expect(values.has(INSTALLATION_ID_KEY)).toBe(false)
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it.each([
    'legacy-shown-at-2026-08-24T00:00:00.000Z',
    '{not-json',
    JSON.stringify({ version: 2, claimId: CONSENT_CLAIM_ID_1, shown: false }),
    JSON.stringify({
      version: 2,
      claimId: CONSENT_CLAIM_ID_1,
      status: 'reserved',
      resolution: 'declined'
    }),
    JSON.stringify({
      version: 2,
      claimId: CONSENT_CLAIM_ID_1,
      status: 'resolved',
      resolution: null
    }),
    JSON.stringify({ version: 1, claimId: 'not-a-uuid', shown: false }),
    JSON.stringify({ version: 1, claimId: CONSENT_CLAIM_ID_1, shown: 'no' })
  ])('fails closed for unknown or corrupt consent state without re-prompting: %s', (state) => {
    const backing = createKvDb({ [CONSENT_PROMPT_KEY]: state })
    const createConsentClaimId = vi.fn(() => CONSENT_CLAIM_ID_2)
    const { service, fetchImpl } = makeService({
      db: backing.db,
      createConsentClaimId
    })

    expect(service.claimConsentPrompt()).toBe(false)
    expect(service.acknowledgeConsentPrompt(CONSENT_CLAIM_ID_1)).toEqual({
      accepted: false,
      newlyAccepted: false
    })
    expect(service.resolveConsentPrompt(CONSENT_CLAIM_ID_1, 'decline')).toEqual({
      accepted: false,
      newlyResolved: false
    })
    expect(backing.values.get(CONSENT_PROMPT_KEY)).toBe(state)
    expect(backing.values.has(INSTALLATION_ID_KEY)).toBe(false)
    expect(createConsentClaimId).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does nothing until the injected enabled getter returns true', async () => {
    let enabled = false
    const { service, fetchImpl, values } = makeService({ enabled: () => enabled })

    await expect(service.capture('app_launched')).resolves.toEqual({ status: 'skipped' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(values.size).toBe(0)
    expect(service.getStatus().lastCapture).toBeUndefined()

    enabled = true
    await expect(service.capture('app_launched')).resolves.toEqual({ status: 'sent' })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(values.get('telemetry.installation-id.v1')).toBe(INSTALL_ID_1)
    expect(service.getStatus()).toMatchObject({
      configured: true,
      enabled: true,
      lastCapture: { event: 'app_launched', status: 'sent' }
    })
    expect(service.getStatus().lastCapture).not.toHaveProperty('distinct_id')
  })

  it('exposes an unconfigured status without creating an identity', () => {
    const { service, values } = makeService({ apiKey: '', enabled: () => false })
    expect(service.getStatus()).toEqual({
      configured: false,
      enabled: false
    })
    expect(values.size).toBe(0)
  })

  it('requires a literal boolean true even when persisted settings are malformed', async () => {
    for (const malformed of ['false', 1, {}, []]) {
      const { service, fetchImpl, values } = makeService({
        enabled: () => malformed as unknown as boolean
      })

      await expect(service.capture('app_launched')).resolves.toEqual({ status: 'skipped' })
      expect(service.claimConsentPrompt()).toBe(false)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(values.has(INSTALLATION_ID_KEY)).toBe(false)
      expect(values.has(CONSENT_PROMPT_KEY)).toBe(false)
    }
  })

  it('matches the documented PostHog raw single-event schema and property allow-list', async () => {
    const { service, fetchImpl } = makeService({
      endpoint: 'https://us.i.posthog.com/some/ignored/path?secret=discarded#fragment'
    })

    await expect(
      service.capture('star_prompt_opened', { prompt_number: 1, action: 'open' })
    ).resolves.toEqual({ status: 'sent' })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://us.i.posthog.com/i/v0/e/')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toEqual({
      api_key: 'phc_public_test_key',
      event: 'star_prompt_opened',
      distinct_id: INSTALL_ID_1,
      properties: {
        $geoip_disable: true,
        $process_person_profile: false,
        schema_version: 1,
        app_version: '1.2.3',
        platform: 'linux',
        arch: 'x64',
        locale: 'en',
        prompt_number: 1,
        action: 'open'
      }
    })
    expect(Object.keys(body).sort()).toEqual(['api_key', 'distinct_id', 'event', 'properties'])
    expect(body.properties).not.toHaveProperty('distinct_id')
    expect(JSON.stringify(body)).not.toMatch(/account|username|repo|path|token/i)
  })

  it('rejects events outside the runtime whitelist even if the type boundary is bypassed', async () => {
    const { service, fetchImpl } = makeService()

    await expect(service.capture('repo_opened' as 'app_launched')).resolves.toEqual({
      status: 'skipped'
    })

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects invalid low-cardinality fields and never forwards extra properties', async () => {
    const { service, fetchImpl } = makeService()
    const unsafe = service as unknown as {
      capture(event: string, properties?: unknown): Promise<unknown>
    }

    await expect(
      unsafe.capture('star_prompt_opened', { prompt_number: 0, action: 'open' })
    ).resolves.toEqual({ status: 'skipped' })
    await expect(
      unsafe.capture('star_prompt_opened', { prompt_number: 1, action: 'later' })
    ).resolves.toEqual({ status: 'skipped' })
    await expect(unsafe.capture('app_launched', { repo_id: 'private/model' })).resolves.toEqual({
      status: 'skipped'
    })
    await expect(
      unsafe.capture('star_prompt_exhausted', { prompt_number: 1, action: 'exhausted' })
    ).resolves.toEqual({ status: 'skipped' })
    await expect(
      unsafe.capture('star_prompt_exhausted', { prompt_number: 2, action: 'later' })
    ).resolves.toEqual({ status: 'skipped' })
    await expect(
      unsafe.capture('star_prompt_exhausted', { prompt_number: 3, action: 'exhausted' })
    ).resolves.toEqual({ status: 'skipped' })
    expect(fetchImpl).not.toHaveBeenCalled()

    await unsafe.capture('star_prompt_opened', {
      prompt_number: 2,
      action: 'open',
      account: 'someone',
      repo_id: 'private/model',
      path: '/home/someone/token'
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))
    expect(body.distinct_id).toBe(INSTALL_ID_1)
    expect(body.properties).toEqual({
      $geoip_disable: true,
      $process_person_profile: false,
      schema_version: 1,
      app_version: '1.2.3',
      platform: 'linux',
      arch: 'x64',
      locale: 'en',
      prompt_number: 2,
      action: 'open'
    })
  })

  it('accepts every documented event in the fixed whitelist', async () => {
    const { service, fetchImpl } = makeService()
    const events: TelemetryEvent[] = [
      'telemetry_enabled',
      'app_launched',
      'star_prompt_shown',
      'star_prompt_opened',
      'star_prompt_snoozed',
      'star_prompt_exhausted',
      'star_prompt_disabled'
    ]

    await service.capture('telemetry_enabled')
    await service.capture('app_launched')
    await service.capture('star_prompt_shown', { prompt_number: 1, action: 'shown' })
    await service.capture('star_prompt_opened', { prompt_number: 1, action: 'open' })
    await service.capture('star_prompt_snoozed', { prompt_number: 1, action: 'later' })
    await service.capture('star_prompt_exhausted', { prompt_number: 2, action: 'exhausted' })
    await service.capture('star_prompt_disabled', { prompt_number: 2, action: 'disable' })

    expect(fetchImpl).toHaveBeenCalledTimes(events.length)
    expect(
      fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).event as string)
    ).toEqual(events)
  })

  it('persists one installation UUID and reuses it across service instances', async () => {
    const { db, values } = createKvDb()
    const firstFetch = vi.fn(async (_input: string | URL, _init?: RequestInit) => successResponse())
    const first = new TelemetryService({
      db,
      enabled: () => true,
      apiKey: 'key',
      endpoint: 'https://example.test',
      appVersion: '1',
      platform: 'linux',
      arch: 'x64',
      locale: () => 'en',
      fetchImpl: firstFetch,
      createId: () => INSTALL_ID_1
    })
    await first.capture('app_launched')

    const secondFetch = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      successResponse()
    )
    const second = new TelemetryService({
      db,
      enabled: () => true,
      apiKey: 'key',
      endpoint: 'https://example.test/i/v0/e/',
      appVersion: '2',
      platform: 'darwin',
      arch: 'arm64',
      locale: () => 'zh-CN',
      fetchImpl: secondFetch,
      createId: () => INSTALL_ID_2
    })
    await second.capture('app_launched')

    expect(values.get('telemetry.installation-id.v1')).toBe(INSTALL_ID_1)
    const secondBody = JSON.parse(String(secondFetch.mock.calls[0]![1]?.body))
    expect(secondBody.distinct_id).toBe(INSTALL_ID_1)
    expect(secondBody.properties.locale).toBe('zh-CN')
  })

  it('replaces a malformed stored identity with a UUID', async () => {
    const { db, values } = createKvDb({ 'telemetry.installation-id.v1': 'not-a-uuid' })
    const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) => successResponse())
    const service = new TelemetryService({
      db,
      enabled: () => true,
      apiKey: 'key',
      endpoint: 'https://example.test',
      appVersion: '1',
      platform: 'linux',
      arch: 'x64',
      locale: () => 'en',
      fetchImpl,
      createId: () => INSTALL_ID_2
    })

    await service.capture('app_launched')

    expect(values.get('telemetry.installation-id.v1')).toBe(INSTALL_ID_2)
  })

  it('clears the stored identity and creates a new one on the next opted-in event', async () => {
    const ids = [INSTALL_ID_1, INSTALL_ID_2]
    const { service, fetchImpl, values } = makeService({ createId: () => ids.shift()! })
    await service.capture('app_launched')

    expect(service.clearIdentity()).toBe(true)
    expect(values.has('telemetry.installation-id.v1')).toBe(false)
    await service.capture('app_launched')

    expect(values.get('telemetry.installation-id.v1')).toBe(INSTALL_ID_2)
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies.map((body) => body.distinct_id)).toEqual([INSTALL_ID_1, INSTALL_ID_2])
  })

  it('rotates any stale identity before a new explicit re-enable lifecycle', async () => {
    const backing = createKvDb({ [INSTALLATION_ID_KEY]: INSTALL_ID_1 })
    const { service, fetchImpl } = makeService({
      db: backing.db,
      createId: () => INSTALL_ID_2
    })

    expect(service.prepareIdentityForOptIn()).toBe(true)
    expect(backing.values.get(INSTALLATION_ID_KEY)).toBe(INSTALL_ID_2)
    await expect(service.capture('telemetry_enabled')).resolves.toEqual({ status: 'sent' })

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))
    expect(body.distinct_id).toBe(INSTALL_ID_2)
  })

  it('does not create an identity when a re-enable is attempted in an unconfigured build', () => {
    const { service, values } = makeService({ apiKey: '' })

    expect(service.prepareIdentityForOptIn()).toBe(false)
    expect(values.has(INSTALLATION_ID_KEY)).toBe(false)
  })

  it('does not send to an insecure or credential-bearing endpoint', async () => {
    for (const endpoint of [
      'http://posthog.example.test',
      'https://user:pass@posthog.example.test',
      'not a url'
    ]) {
      const { service, fetchImpl } = makeService({ endpoint })
      await expect(service.capture('app_launched')).resolves.toEqual({ status: 'skipped' })
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('contains internal failures without throwing into application behavior', async () => {
    const throwingDb = {
      prepare: () => {
        throw new Error('database unavailable')
      }
    } as unknown as AppDatabase
    const cases = [
      makeService({
        enabled: () => {
          throw new Error('settings unavailable')
        }
      }).service,
      makeService({ db: throwingDb }).service,
      makeService({
        createId: () => {
          throw new Error('random unavailable')
        }
      }).service,
      makeService({
        locale: () => {
          throw new Error('locale unavailable')
        }
      }).service
    ]

    for (const service of cases) {
      await expect(service.capture('app_launched')).resolves.toEqual({
        status: 'failed',
        reason: 'internal'
      })
    }
  })

  it('reports network and non-2xx delivery failures without throwing', async () => {
    const network = makeService({
      fetchImpl: vi.fn(async () => Promise.reject(new Error('offline')))
    }).service
    const rejected = makeService({
      fetchImpl: vi.fn(async () => new Response(null, { status: 503 }))
    }).service

    await expect(network.capture('app_launched')).resolves.toEqual({
      status: 'failed',
      reason: 'network'
    })
    await expect(rejected.capture('app_launched')).resolves.toEqual({
      status: 'failed',
      reason: 'http',
      httpStatus: 503
    })
  })

  it('abandons a hung request after the bounded timeout', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const fetchImpl = vi.fn(
        (_input: string | URL, init?: RequestInit) =>
          new Promise<Response>(() => {
            if (init?.signal) signals.push(init.signal)
          })
      )
      const { service } = makeService({ fetchImpl, timeoutMs: 25 })

      const capture = service.capture('app_launched')
      await vi.advanceTimersByTimeAsync(25)

      await expect(capture).resolves.toEqual({ status: 'failed', reason: 'timeout' })
      expect(signals[0]?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
