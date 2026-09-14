import { describe, expect, it } from 'vitest'
import { HUB_SESSION_REQUIRED_CODE } from '@oh-my-huggingface/shared'
import { classifyError, isAuthError, isHubSessionRequired, sanitizeErrorDetails } from './errors'

/** Message shape the hub client emits: "GET <url> failed: <status> <statusText>". */
const hubError = (status: number, statusText: string): Error =>
  new Error(`GET https://huggingface.co/api/models failed: ${status} ${statusText}`)

describe('classifyError', () => {
  it('maps HTTP statuses recovered from the message', () => {
    expect(classifyError(hubError(401, 'Unauthorized'))).toEqual({ kind: 'auth', status: 401 })
    expect(classifyError(hubError(403, 'Forbidden'))).toEqual({ kind: 'gated', status: 403 })
    expect(classifyError(hubError(404, 'Not Found'))).toEqual({ kind: 'notFound', status: 404 })
    expect(classifyError(hubError(429, 'Too Many Requests'))).toEqual({
      kind: 'rateLimit',
      status: 429
    })
  })

  it('classifies 5xx as server errors', () => {
    expect(classifyError(hubError(500, 'Internal Server Error'))).toEqual({
      kind: 'server',
      status: 500
    })
    expect(classifyError(hubError(503, 'Service Unavailable'))).toEqual({
      kind: 'server',
      status: 503
    })
  })

  it('leaves unmapped 4xx statuses unknown but keeps the status', () => {
    expect(classifyError(hubError(422, 'Unprocessable Entity'))).toEqual({
      kind: 'unknown',
      status: 422
    })
  })

  it('recognizes network-failure shapes without a status', () => {
    expect(classifyError(new Error('fetch failed'))).toEqual({ kind: 'network' })
    expect(classifyError(new Error('getaddrinfo ENOTFOUND huggingface.co'))).toEqual({
      kind: 'network'
    })
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toEqual({
      kind: 'network'
    })
    expect(classifyError(new Error('read ECONNRESET'))).toEqual({ kind: 'network' })
    expect(classifyError(new Error('request timed out'))).toEqual({ kind: 'network' })
    expect(classifyError(new Error('The operation was aborted'))).toEqual({ kind: 'network' })
  })

  it('distinguishes security blocks, renewed approval, and an explicitly canceled review', () => {
    expect(
      classifyError(
        new Error("Error invoking remote method 'downloads:resume': Error: security.blocked")
      )
    ).toEqual({ kind: 'securityBlocked' })
    expect(classifyError('security.evidenceChanged')).toEqual({ kind: 'securityReview' })
    expect(classifyError(new Error('security.confirmationCanceled'))).toEqual({ kind: 'canceled' })
  })

  it('does not mistake security-like repository names for local security decisions', () => {
    expect(
      classifyError(new Error('fetch failed for https://hub.test/security.blocked/model'))
    ).toEqual({
      kind: 'network'
    })
  })

  it('falls back to unknown for anything else, including non-Errors', () => {
    expect(classifyError(new Error('something exploded'))).toEqual({ kind: 'unknown' })
    expect(classifyError('plain string failure')).toEqual({ kind: 'unknown' })
    expect(classifyError(undefined)).toEqual({ kind: 'unknown' })
  })

  it('does not treat status-like numbers outside the message shape as statuses', () => {
    // "429" alone (e.g. inside a repo name) must not classify as rate limit.
    expect(classifyError(new Error('repo org/model-429 not readable'))).toEqual({
      kind: 'unknown'
    })
  })
})

describe('isAuthError', () => {
  it('matches 401/403 statuses and auth words in flattened IPC messages', () => {
    expect(
      isAuthError('GET https://huggingface.co/api/notifications failed: 401 Unauthorized')
    ).toBe(true)
    expect(isAuthError('GET https://huggingface.co/api/notifications failed: 403 Forbidden')).toBe(
      true
    )
    expect(isAuthError('Invalid credentials: unauthorized')).toBe(true)
  })

  it('does not match other failures or digits embedded in longer numbers', () => {
    expect(
      isAuthError('GET https://huggingface.co/api/models failed: 500 Internal Server Error')
    ).toBe(false)
    expect(isAuthError('fetch failed')).toBe(false)
    expect(isAuthError('repo org/model-4013 not readable')).toBe(false)
  })
})

describe('isHubSessionRequired', () => {
  it('detects the sentinel riding the message across IPC', () => {
    expect(isHubSessionRequired(new Error(`boom ${HUB_SESSION_REQUIRED_CODE}`))).toBe(true)
    expect(isHubSessionRequired(new Error('boom'))).toBe(false)
    expect(isHubSessionRequired('not an error')).toBe(false)
  })
})

describe('sanitizeErrorDetails', () => {
  it('redacts credentials, authenticated query values, and user paths', () => {
    const details = sanitizeErrorDetails(
      new Error(
        'Bearer secret-value hf_1234567890 GET https://hub.test/api?token=top-secret at /Users/alice/project/main.ts:1'
      )
    )

    expect(details).not.toContain('secret-value')
    expect(details).not.toContain('hf_1234567890')
    expect(details).not.toContain('top-secret')
    expect(details).not.toContain('/Users/alice')
    expect(details).toContain('<redacted>')
    expect(details).toContain('/<path>')
  })

  it('bounds copied diagnostics', () => {
    expect(sanitizeErrorDetails('x'.repeat(3_000))).toHaveLength(2_002)
  })
})
