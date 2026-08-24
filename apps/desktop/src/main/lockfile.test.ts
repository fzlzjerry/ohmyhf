import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  LockfileRestoreEvent,
  OhmyhfLockV1,
  SecurityPreflightResult,
  SecurityReport
} from '@oh-my-huggingface/shared'
import { LockfileManager } from './lockfile'

const COMMIT = 'a'.repeat(40)
const LFS = 'b'.repeat(64)
const CHALLENGE = '11111111-1111-4111-8111-111111111111'
const GRANT = '22222222-2222-4222-8222-222222222222'

function lock(overrides: Partial<OhmyhfLockV1> = {}): OhmyhfLockV1 {
  return {
    format: 'ohmyhf-lock/v1',
    version: 1,
    createdAt: '2026-08-24T00:00:00.000Z',
    hubEndpoint: 'https://huggingface.co',
    resources: [
      {
        kind: 'model',
        repoId: 'org/model',
        requestedRevision: 'v1',
        resolvedCommit: COMMIT,
        files: [{ path: 'model.gguf', size: 100, lfsSha256: LFS }]
      }
    ],
    ...overrides
  }
}

function report(): SecurityReport {
  return {
    kind: 'model',
    repoId: 'org/model',
    revision: 'v1',
    resolvedCommit: COMMIT,
    overall: 'unknown',
    evidence: [{ source: 'hub', status: 'unknown', filePath: 'model.gguf' }],
    reasons: ['scan-unknown'],
    fingerprint: `sha256:${'c'.repeat(64)}`,
    checkedAt: '2026-08-24T00:00:00.000Z'
  }
}

function hub(baseUrl = 'https://huggingface.co') {
  return {
    baseUrl,
    resolveRevision: vi.fn().mockResolvedValue({ resolvedCommit: COMMIT }),
    getRepoDetail: vi.fn().mockResolvedValue({ sha: COMMIT }),
    getFileTree: vi.fn().mockResolvedValue([
      {
        type: 'file',
        path: 'model.gguf',
        size: 100,
        lfs: { oid: LFS, size: 100 }
      }
    ])
  }
}

function security(decision: 'allow' | 'confirm' | 'block' = 'confirm') {
  const result: SecurityPreflightResult = {
    decision,
    report: report(),
    reasons: decision === 'allow' ? [] : ['scan-unknown'],
    ...(decision === 'confirm' ? { challengeId: CHALLENGE } : {})
  }
  return {
    preflight: vi.fn().mockResolvedValue(result),
    authorize: vi.fn().mockImplementation(async (_request, grantId?: string) => {
      if (decision === 'block') throw new Error('security.blocked')
      if (decision === 'confirm' && grantId !== GRANT) {
        throw new Error('security.confirmationRequired')
      }
      return report()
    }),
    confirm: vi.fn().mockImplementation((challengeId: string) => {
      if (challengeId !== CHALLENGE) throw new Error('security.challengeExpired')
      return { grantId: GRANT, expiresAt: '2026-08-24T00:05:00.000Z' }
    })
  }
}

function dependencies(
  input: {
    currentHub?: ReturnType<typeof hub>
    currentSecurity?: ReturnType<typeof security>
    cached?: boolean
    cachedPath?: string
    contextForEndpoint?: ReturnType<typeof vi.fn>
  } = {}
) {
  const currentHub = input.currentHub ?? hub()
  const currentSecurity = input.currentSecurity ?? security()
  const cache = {
    resolveFilePath: vi.fn().mockImplementation(async () =>
      input.cached
        ? {
            absolutePath: input.cachedPath ?? '/cache/model.gguf',
            info: {
              kind: 'model',
              repoId: 'org/model',
              commit: COMMIT,
              path: 'model.gguf',
              size: 100
            }
          }
        : null
    ),
    snapshot: vi.fn().mockResolvedValue(input.cached ? { commit: COMMIT, files: [] } : null)
  }
  const downloads = {
    list: vi.fn().mockReturnValue([]),
    startWithHub: vi.fn().mockResolvedValue([
      {
        id: 'download-id',
        kind: 'model',
        repoId: 'org/model',
        resolvedCommit: COMMIT,
        status: 'queued'
      }
    ])
  }
  const localRuntime = {
    discover: vi
      .fn()
      .mockResolvedValue([
        { kind: 'llama.cpp', available: true, capabilities: { chat: true, streaming: true } }
      ]),
    savePreset: vi.fn()
  }
  const restoreEvents: LockfileRestoreEvent[] = []
  return {
    value: {
      hub: currentHub,
      security: currentSecurity,
      cache,
      downloads,
      localRuntime,
      broadcastRestore: (event: LockfileRestoreEvent) => restoreEvents.push(event),
      contextForEndpoint: input.contextForEndpoint
    } as never,
    currentHub,
    currentSecurity,
    cache,
    downloads,
    localRuntime,
    restoreEvents
  }
}

describe('LockfileManager exact inspection and restore', () => {
  it('enriches cached subset files with local SHA-256 without exporting local paths', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'ohmyhf-lock-export-'))
    const path = join(folder, 'model.gguf')
    await writeFile(path, Buffer.alloc(100, 7))
    try {
      const deps = dependencies({ cached: true, cachedPath: path })
      const prepared = await new LockfileManager(deps.value).prepareExport(
        lock({ hubEndpoint: 'https://huggingface.co/' })
      )
      expect(prepared.hubEndpoint).toBe('https://huggingface.co')
      expect(prepared.resources[0]?.files?.[0]?.localSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(prepared)).not.toContain(folder)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('surfaces exact security warnings, mints a scoped challenge and queues only missing files', async () => {
    const deps = dependencies()
    const manager = new LockfileManager(deps.value)
    const inspection = await manager.inspect(lock())

    expect(inspection).toMatchObject({
      endpointMatches: true,
      endpointConfirmed: true,
      resources: [
        {
          resolvedCommit: COMMIT,
          cachedFiles: 0,
          missingFiles: 1,
          mismatchedFiles: 0,
          currentSecurityDecision: 'confirm',
          securityReasons: ['scan-unknown'],
          securityChallengeId: CHALLENGE,
          errors: []
        }
      ]
    })
    expect(manager.protectedCommits('model', 'org/model')).toEqual(new Set([COMMIT]))
    expect(manager.confirmSecurity(inspection.inspectionId, 0, CHALLENGE)).toMatchObject({
      grantId: GRANT
    })
    const result = await manager.restore(inspection.inspectionId, {
      securityGrantIds: [GRANT]
    })
    expect(result).toEqual({
      queuedDownloadIds: ['download-id'],
      readyResources: [],
      blockedResources: []
    })
    expect(deps.currentSecurity.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'lock-restore',
        repoId: 'org/model',
        resolvedCommit: COMMIT,
        files: ['model.gguf']
      }),
      GRANT
    )
    expect(deps.downloads.startWithHub).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 'v1',
        resolvedCommit: COMMIT,
        files: ['model.gguf']
      }),
      expect.objectContaining({ baseUrl: 'https://huggingface.co' })
    )
    expect(manager.protectedCommits('model', 'org/model')).toEqual(new Set())
    expect(deps.restoreEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'restoring', completedResources: 0 }),
        expect.objectContaining({ status: 'completed', completedResources: 1 })
      ])
    )
  })

  it('uses anonymous then authenticated throwaway clients for a different endpoint', async () => {
    const anonymousHub = hub('https://mirror.example')
    const authenticatedHub = hub('https://mirror.example')
    const anonymousSecurity = security('allow')
    const authenticatedSecurity = security('confirm')
    const factory = vi.fn((endpoint: string, authenticated: boolean) => {
      expect(endpoint).toBe('https://mirror.example')
      return authenticated
        ? { hub: authenticatedHub, security: authenticatedSecurity }
        : { hub: anonymousHub, security: anonymousSecurity }
    })
    const deps = dependencies({ contextForEndpoint: factory })
    const manager = new LockfileManager(deps.value)
    const initial = await manager.inspect(lock({ hubEndpoint: 'https://mirror.example' }))

    expect(initial).toMatchObject({ endpointMatches: false, endpointConfirmed: false })
    expect(factory).toHaveBeenCalledWith('https://mirror.example', false)
    expect(deps.currentHub.resolveRevision).not.toHaveBeenCalled()
    expect(anonymousHub.resolveRevision).toHaveBeenCalled()
    await expect(manager.restore(initial.inspectionId, { confirmEndpoint: true })).rejects.toThrow(
      'lockfile.endpointConfirmationRequired'
    )

    // A consumed inspection cannot be replayed; inspect again, then perform
    // the explicit authenticated endpoint refresh.
    const next = await manager.inspect(lock({ hubEndpoint: 'https://mirror.example' }))
    const refreshed = await manager.confirmEndpoint(next.inspectionId)
    expect(refreshed).toMatchObject({
      endpointMatches: false,
      endpointConfirmed: true,
      resources: [{ currentSecurityDecision: 'confirm', securityChallengeId: CHALLENGE }]
    })
    expect(factory).toHaveBeenCalledWith('https://mirror.example', true)
    const grant = manager.confirmSecurity(next.inspectionId, 0, CHALLENGE)
    const result = await manager.restore(next.inspectionId, {
      confirmEndpoint: true,
      securityGrantIds: [grant.grantId]
    })
    expect(result.blockedResources).toEqual([])
    expect(authenticatedSecurity.authorize).toHaveBeenCalled()
    expect(deps.downloads.startWithHub).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ baseUrl: 'https://mirror.example' })
    )
  })

  it('blocks a full snapshot when the Hub omits immutable file object ids', async () => {
    const incompleteHub = hub()
    incompleteHub.getFileTree.mockResolvedValueOnce([
      { type: 'file', path: 'model.gguf', size: 100 }
    ])
    const deps = dependencies({ currentHub: incompleteHub })
    const manager = new LockfileManager(deps.value)
    const inspection = await manager.inspect(
      lock({ resources: [{ ...lock().resources[0]!, files: undefined }] })
    )
    expect(inspection.resources[0]).toMatchObject({
      mismatchedFiles: 1,
      errors: ['remote-object-id-missing:model.gguf']
    })
  })

  it('restores runtime parameters as a ready preset without starting a model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmyhf-lock-test-'))
    const cachedPath = join(root, 'model.gguf')
    const content = Buffer.alloc(100, 7)
    await writeFile(cachedPath, content)
    try {
      const deps = dependencies({
        cached: true,
        cachedPath,
        currentSecurity: security('allow')
      })
      const manager = new LockfileManager(deps.value)
      const value = lock()
      value.resources[0]!.files![0]!.localSha256 = createHash('sha256')
        .update(content)
        .digest('hex')
      value.resources[0]!.runtime = {
        runtime: 'llama.cpp',
        filePath: 'model.gguf',
        contextLength: 2048,
        maxTokens: 256,
        temperature: 0.4,
        gpuLayers: 12
      }
      const inspection = await manager.inspect(value)
      const restored = await manager.restore(inspection.inspectionId)

      expect(restored).toEqual({
        queuedDownloadIds: [],
        readyResources: [{ kind: 'model', repoId: 'org/model', resolvedCommit: COMMIT }],
        blockedResources: []
      })
      expect(deps.localRuntime.savePreset).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://huggingface.co',
          runtime: 'llama.cpp',
          contextLength: 2048,
          gpuLayers: 12
        })
      )
      expect(deps.downloads.startWithHub).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks a remote metadata mismatch before download or preset side effects', async () => {
    const deps = dependencies({ currentSecurity: security('allow') })
    const manager = new LockfileManager(deps.value)
    const value = lock()
    value.resources[0]!.files![0]!.size = 101
    const inspection = await manager.inspect(value)
    expect(inspection.resources[0]).toMatchObject({
      mismatchedFiles: 1,
      errors: ['remote-metadata:model.gguf']
    })
    const restored = await manager.restore(inspection.inspectionId)
    expect(restored.blockedResources[0]?.reason).toContain('remote-metadata:model.gguf')
    expect(deps.downloads.startWithHub).not.toHaveBeenCalled()
    expect(deps.localRuntime.savePreset).not.toHaveBeenCalled()
  })

  it('rejects mismatched challenge/resource bindings and inspection replay', async () => {
    const deps = dependencies()
    const manager = new LockfileManager(deps.value)
    const inspection = await manager.inspect(lock())
    expect(() => manager.confirmSecurity(inspection.inspectionId, 0, GRANT)).toThrow(
      'security.grantScopeMismatch'
    )
    await manager.restore(inspection.inspectionId, { securityGrantIds: [GRANT] })
    await expect(manager.restore(inspection.inspectionId)).rejects.toThrow(
      'lockfile.inspectionExpired'
    )
  })
})
