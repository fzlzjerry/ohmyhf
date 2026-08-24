import { createHash, randomUUID } from 'node:crypto'
import type { HubClient } from '@oh-my-huggingface/hub-api'
import {
  evaluateSecurityPolicy,
  normalizeResolvedCommit,
  type SecurityAcknowledgement,
  type SecurityGrant,
  type SecurityPreflightRequest,
  type SecurityPreflightResult,
  type SecurityReport
} from '@oh-my-huggingface/shared'

const DEFAULT_TTL_MS = 5 * 60_000

interface ConfirmationChallenge {
  requestKey: string
  report: SecurityReport
  expiresAt: number
}

interface StoredGrant extends ConfirmationChallenge {
  used: boolean
}

type SecurityHub = Pick<HubClient, 'resolveRevision' | 'getSecurityReport'>

function canonicalFiles(files: string[] | undefined): string[] | undefined {
  if (files === undefined) return undefined
  return [...new Set(files)].sort((a, b) => a.localeCompare(b))
}

/**
 * The renderer may ask what a policy decision is, but only this main-process
 * gate can mint and consume an action-scoped confirmation. Every protected
 * side effect calls `authorize`, which refreshes Hub evidence and rejects a
 * moved ref, changed evidence, expired grant, or replayed grant.
 */
export class SecurityGate {
  private readonly challenges = new Map<string, ConfirmationChallenge>()
  private readonly grants = new Map<string, StoredGrant>()

  constructor(
    private readonly hub: SecurityHub,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS
  ) {}

  private requestKey(request: SecurityPreflightRequest): string {
    return JSON.stringify({
      endpoint: this.hubEndpoint(),
      action: request.action,
      kind: request.kind,
      repoId: request.repoId,
      revision: request.revision,
      resolvedCommit: request.resolvedCommit.toLowerCase(),
      files: canonicalFiles(request.files) ?? null
    })
  }

  private acknowledgementBinding(
    request: SecurityPreflightRequest,
    evidenceFingerprint: string
  ): string {
    return `sha256:${createHash('sha256')
      .update(`${this.requestKey(request)}\0${evidenceFingerprint}`)
      .digest('hex')}`
  }

  private hubEndpoint(): string {
    const value = (this.hub as SecurityHub & { baseUrl?: string }).baseUrl
    return (value ?? 'unknown').replace(/\/+$/, '')
  }

  private purgeExpired(): void {
    const now = this.now()
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id)
    }
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= now || grant.used) this.grants.delete(id)
    }
  }

  private async currentReport(request: SecurityPreflightRequest): Promise<SecurityReport> {
    const expected = normalizeResolvedCommit(request.resolvedCommit)
    if (!expected) throw new Error('security.invalidCommit')

    // Prove that the immutable commit is still accessible. The symbolic ref is
    // deliberately not re-resolved here: branches may move during a long
    // download, while the requested+resolved identity must remain reproducible.
    const resolved = await this.hub.resolveRevision(request.kind, request.repoId, expected)
    if (resolved.resolvedCommit !== expected) throw new Error('security.commitChanged')

    const report = await this.hub.getSecurityReport(
      request.kind,
      request.repoId,
      request.revision,
      expected
    )
    if (report.resolvedCommit.toLowerCase() !== expected) {
      throw new Error('security.reportCommitMismatch')
    }
    return report
  }

  async preflight(request: SecurityPreflightRequest): Promise<SecurityPreflightResult> {
    this.purgeExpired()
    const normalizedRequest: SecurityPreflightRequest = {
      ...request,
      resolvedCommit: request.resolvedCommit.toLowerCase(),
      files: canonicalFiles(request.files)
    }
    const report = await this.currentReport(normalizedRequest)
    const policy = evaluateSecurityPolicy(report, normalizedRequest.files, normalizedRequest.action)
    if (policy.decision !== 'confirm') {
      return { decision: policy.decision, report, reasons: policy.reasons }
    }

    const challengeId = randomUUID()
    this.challenges.set(challengeId, {
      requestKey: this.requestKey(normalizedRequest),
      report,
      expiresAt: this.now() + this.ttlMs
    })
    return {
      decision: 'confirm',
      report,
      reasons: policy.reasons,
      challengeId
    }
  }

  confirm(challengeId: string): SecurityGrant {
    this.purgeExpired()
    const challenge = this.challenges.get(challengeId)
    if (!challenge) throw new Error('security.challengeExpired')
    this.challenges.delete(challengeId)
    const grantId = randomUUID()
    this.grants.set(grantId, { ...challenge, used: false })
    return { grantId, expiresAt: new Date(challenge.expiresAt).toISOString() }
  }

  /** Refresh evidence and consume exactly one matching grant before a side effect. */
  async authorize(request: SecurityPreflightRequest, grantId?: string): Promise<SecurityReport> {
    this.purgeExpired()
    const normalizedRequest: SecurityPreflightRequest = {
      ...request,
      resolvedCommit: request.resolvedCommit.toLowerCase(),
      files: canonicalFiles(request.files)
    }
    const report = await this.currentReport(normalizedRequest)
    const policy = evaluateSecurityPolicy(report, normalizedRequest.files, normalizedRequest.action)
    if (policy.decision === 'block') throw new Error('security.blocked')
    if (policy.decision === 'allow') return report
    if (!grantId) throw new Error('security.confirmationRequired')

    const grant = this.grants.get(grantId)
    // Delete before returning or throwing after scope lookup. This makes every
    // presented grant one-shot, including failed replay/scope attempts.
    this.grants.delete(grantId)
    if (!grant || grant.used || grant.expiresAt <= this.now()) {
      throw new Error('security.grantExpired')
    }
    grant.used = true
    if (grant.requestKey !== this.requestKey(normalizedRequest)) {
      throw new Error('security.grantScopeMismatch')
    }
    if (grant.report.fingerprint !== report.fingerprint) {
      throw new Error('security.evidenceChanged')
    }
    return report
  }

  acknowledgement(
    request: SecurityPreflightRequest,
    report: SecurityReport
  ): SecurityAcknowledgement {
    const normalizedRequest: SecurityPreflightRequest = {
      ...request,
      resolvedCommit: request.resolvedCommit.toLowerCase(),
      files: canonicalFiles(request.files)
    }
    return {
      fingerprint: report.fingerprint,
      binding: this.acknowledgementBinding(normalizedRequest, report.fingerprint),
      acceptedAt: new Date(this.now()).toISOString()
    }
  }

  /**
   * Resume a long-running, already-confirmed operation. The acknowledgement is
   * only valid for this exact request and evidence fingerprint; it is not a
   * reusable grant and cannot authorize a changed report.
   */
  async authorizeAcknowledged(
    request: SecurityPreflightRequest,
    acknowledgement: SecurityAcknowledgement
  ): Promise<SecurityReport> {
    const normalizedRequest: SecurityPreflightRequest = {
      ...request,
      resolvedCommit: request.resolvedCommit.toLowerCase(),
      files: canonicalFiles(request.files)
    }
    const report = await this.currentReport(normalizedRequest)
    const policy = evaluateSecurityPolicy(report, normalizedRequest.files, normalizedRequest.action)
    if (policy.decision === 'block') throw new Error('security.blocked')
    if (report.fingerprint !== acknowledgement.fingerprint) {
      throw new Error('security.evidenceChanged')
    }
    if (
      acknowledgement.binding !==
      this.acknowledgementBinding(normalizedRequest, acknowledgement.fingerprint)
    ) {
      throw new Error('security.acknowledgementScopeMismatch')
    }
    return report
  }
}
