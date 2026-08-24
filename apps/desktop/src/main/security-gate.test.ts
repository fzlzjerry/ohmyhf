import { describe, expect, it } from 'vitest'
import {
  securityEvidenceFingerprint,
  type SecurityEvidence,
  type SecurityPreflightRequest,
  type SecurityReport
} from '@oh-my-huggingface/shared'
import { SecurityGate } from './security-gate'

const COMMIT = 'a'.repeat(40)
const baseRequest: SecurityPreflightRequest = {
  action: 'download',
  kind: 'model',
  repoId: 'org/model',
  revision: 'v1',
  resolvedCommit: COMMIT,
  files: ['model.gguf']
}

function makeReport(evidence: SecurityEvidence[]): SecurityReport {
  const overall = evidence.some((item) => item.status === 'malicious')
    ? 'malicious'
    : evidence.every((item) => item.status === 'safe')
      ? 'safe'
      : 'unknown'
  return {
    kind: 'model',
    repoId: 'org/model',
    revision: 'v1',
    resolvedCommit: COMMIT,
    overall,
    evidence,
    reasons: overall === 'malicious' ? ['confirmed-malicious'] : [],
    fingerprint: securityEvidenceFingerprint({
      repoId: 'org/model',
      resolvedCommit: COMMIT,
      evidence
    }),
    checkedAt: '2026-08-24T00:00:00.000Z'
  }
}

function fixture(
  initial: SecurityReport,
  ttlMs = 1_000
): {
  gate: SecurityGate
  setReport: (report: SecurityReport) => void
  advance: (milliseconds: number) => void
} {
  let report = initial
  let now = 10_000
  const hub = {
    baseUrl: 'https://huggingface.co',
    async resolveRevision() {
      return {
        requested: COMMIT,
        resolvedCommit: COMMIT,
        type: 'commit' as const,
        isDefault: false,
        readOnly: true
      }
    },
    async getSecurityReport() {
      return report
    }
  }
  return {
    gate: new SecurityGate(hub, () => now, ttlMs),
    setReport: (next) => {
      report = next
    },
    advance: (milliseconds) => {
      now += milliseconds
    }
  }
}

describe('SecurityGate', () => {
  it('allows independently safe evidence without minting a challenge', async () => {
    const { gate } = fixture(
      makeReport([{ source: 'scanner', status: 'safe', filePath: 'model.gguf' }])
    )
    const preflight = await gate.preflight(baseRequest)
    expect(preflight).toMatchObject({ decision: 'allow' })
    expect(preflight.challengeId).toBeUndefined()
    await expect(gate.authorize(baseRequest)).resolves.toMatchObject({ overall: 'safe' })
  })

  it('never offers a challenge for confirmed malicious selected files', async () => {
    const { gate } = fixture(
      makeReport([{ source: 'scanner', status: 'malicious', filePath: 'model.gguf' }])
    )
    const preflight = await gate.preflight(baseRequest)
    expect(preflight).toMatchObject({ decision: 'block' })
    expect(preflight.challengeId).toBeUndefined()
    await expect(gate.authorize(baseRequest)).rejects.toThrow('security.blocked')
  })

  it('binds a one-shot grant to action, commit, file set, endpoint, and evidence', async () => {
    const { gate } = fixture(makeReport([{ source: 'scanner', status: 'unknown' }]))
    const preflight = await gate.preflight(baseRequest)
    expect(preflight.decision).toBe('confirm')
    const grant = gate.confirm(preflight.challengeId!)

    await expect(
      gate.authorize({ ...baseRequest, action: 'export' }, grant.grantId)
    ).rejects.toThrow('security.grantScopeMismatch')
    await expect(gate.authorize(baseRequest, grant.grantId)).rejects.toThrow(
      'security.grantExpired'
    )
  })

  it('rejects expired grants and evidence changes before the side effect', async () => {
    const original = makeReport([{ source: 'scanner', status: 'unknown' }])
    const expiring = fixture(original, 100)
    const challenge = await expiring.gate.preflight(baseRequest)
    const grant = expiring.gate.confirm(challenge.challengeId!)
    expiring.advance(101)
    await expect(expiring.gate.authorize(baseRequest, grant.grantId)).rejects.toThrow(
      'security.grantExpired'
    )

    const changing = fixture(original)
    const nextChallenge = await changing.gate.preflight(baseRequest)
    const nextGrant = changing.gate.confirm(nextChallenge.challengeId!)
    changing.setReport(
      makeReport([{ source: 'scanner', status: 'unknown', message: 'scanner restarted' }])
    )
    await expect(changing.gate.authorize(baseRequest, nextGrant.grantId)).rejects.toThrow(
      'security.evidenceChanged'
    )
  })

  it('accepts a persisted acknowledgement only while its exact evidence is unchanged', async () => {
    const original = makeReport([{ source: 'scanner', status: 'unknown' }])
    const { gate, setReport } = fixture(original)
    const acknowledgement = gate.acknowledgement(baseRequest, original)
    await expect(gate.authorizeAcknowledged(baseRequest, acknowledgement)).resolves.toMatchObject({
      fingerprint: original.fingerprint
    })
    await expect(
      gate.authorizeAcknowledged({ ...baseRequest, action: 'export' }, acknowledgement)
    ).rejects.toThrow('security.acknowledgementScopeMismatch')
    setReport(makeReport([{ source: 'scanner', status: 'safe', filePath: 'model.gguf' }]))
    await expect(gate.authorizeAcknowledged(baseRequest, acknowledgement)).rejects.toThrow(
      'security.evidenceChanged'
    )
  })
})
