import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assessModelFit,
  classifyRevision,
  evaluateSecurityPolicy,
  ohmyhfLockV1Schema,
  securityEvidenceFingerprint,
  type MachineProfile,
  type RepoRefs,
  type SecurityEvidence,
  type SecurityReport
} from '@oh-my-huggingface/shared'

const COMMIT = 'a'.repeat(40)
const OTHER_COMMIT = 'b'.repeat(40)

const refs: RepoRefs = {
  defaultBranch: 'main',
  branches: [
    { type: 'branch', name: 'main', ref: 'refs/heads/main', targetCommit: COMMIT, isDefault: true },
    {
      type: 'branch',
      name: 'feature/slash',
      ref: 'refs/heads/feature/slash',
      targetCommit: OTHER_COMMIT
    }
  ],
  tags: [{ type: 'tag', name: 'v1.0', ref: 'refs/tags/v1.0', targetCommit: COMMIT }],
  pullRequests: [
    { type: 'pull-request', name: 'PR #7', ref: 'refs/pr/7', targetCommit: OTHER_COMMIT }
  ]
}

describe('immutable revision classification', () => {
  it('distinguishes writable branches from read-only tags, commits, and PR refs', () => {
    expect(classifyRevision('main', COMMIT, refs)).toMatchObject({
      type: 'branch',
      isDefault: true,
      readOnly: false
    })
    expect(classifyRevision('feature/slash', OTHER_COMMIT, refs)).toMatchObject({
      type: 'branch',
      requested: 'feature/slash',
      readOnly: false
    })
    expect(classifyRevision('v1.0', COMMIT, refs)).toMatchObject({
      type: 'tag',
      readOnly: true
    })
    expect(classifyRevision('refs/pr/7', OTHER_COMMIT, refs)).toMatchObject({
      type: 'pull-request',
      readOnly: true
    })
    expect(classifyRevision(COMMIT.toUpperCase(), COMMIT)).toMatchObject({
      type: 'commit',
      requested: COMMIT,
      resolvedCommit: COMMIT,
      readOnly: true
    })
  })

  it('rejects a non-40-character resolved identity', () => {
    expect(() => classifyRevision('main', 'abc', refs)).toThrow('revision.invalidCommit')
  })

  it('rejects a missing reference instead of silently substituting main', () => {
    expect(() => classifyRevision('', COMMIT)).toThrow('revision.defaultUnavailable')
  })
})

function report(evidence: SecurityEvidence[], overall: SecurityReport['overall']): SecurityReport {
  return {
    kind: 'model',
    repoId: 'org/model',
    revision: 'main',
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

describe('security policy', () => {
  it('allows only independently safe selected files with no local risk rule', () => {
    const value = report(
      [{ source: 'hub-malware', status: 'safe', filePath: 'model.gguf' }],
      'safe'
    )
    expect(evaluateSecurityPolicy(value, ['model.gguf'], 'local-run')).toEqual({
      decision: 'allow',
      reasons: []
    })
  })

  it('hard-blocks selected or unscoped confirmed malware', () => {
    const selected = report(
      [{ source: 'hub-malware', status: 'malicious', filePath: 'model.gguf' }],
      'malicious'
    )
    expect(evaluateSecurityPolicy(selected, ['model.gguf'], 'download').decision).toBe('block')

    const repository = report([{ source: 'hub-malware', status: 'malicious' }], 'malicious')
    expect(evaluateSecurityPolicy(repository, ['README.md'], 'download').decision).toBe('block')
    const unattributed = report([], 'malicious')
    expect(evaluateSecurityPolicy(unattributed, ['README.md'], 'download').decision).toBe('block')
  })

  it('requires confirmation for unrelated malware, unknown evidence, and pickle files', () => {
    const unrelated = report(
      [
        { source: 'hub-malware', status: 'safe', filePath: 'model.gguf' },
        { source: 'hub-malware', status: 'malicious', filePath: 'bad.exe' }
      ],
      'malicious'
    )
    expect(evaluateSecurityPolicy(unrelated, ['model.gguf'], 'download')).toMatchObject({
      decision: 'confirm',
      reasons: expect.arrayContaining(['other-file-malicious'])
    })

    const unknown = report([{ source: 'hub', status: 'unknown' }], 'unknown')
    expect(evaluateSecurityPolicy(unknown, ['model.gguf'], 'download').decision).toBe('confirm')

    const pickle = report(
      [{ source: 'hub-malware', status: 'safe', filePath: 'weights.bin' }],
      'safe'
    )
    expect(evaluateSecurityPolicy(pickle, ['weights.bin'], 'download')).toMatchObject({
      decision: 'confirm',
      reasons: expect.arrayContaining(['pickle-format'])
    })
  })

  it('uses a deterministic SHA-256 fingerprint independent of evidence ordering', () => {
    const evidence: SecurityEvidence[] = [
      { source: 'b', status: 'safe', filePath: 'b.gguf' },
      { source: 'a', status: 'unknown', filePath: 'a.gguf', message: 'pending metadata' }
    ]
    const first = securityEvidenceFingerprint({
      repoId: 'org/model',
      resolvedCommit: COMMIT,
      evidence
    })
    const second = securityEvidenceFingerprint({
      repoId: 'org/model',
      resolvedCommit: COMMIT.toUpperCase(),
      evidence: [...evidence].reverse()
    })
    expect(first).toBe(second)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)

    const canonical = JSON.stringify({
      repoId: 'org/model',
      resolvedCommit: COMMIT,
      evidence: [
        { source: 'a', status: 'unknown', filePath: 'a.gguf', message: 'pending metadata' },
        { source: 'b', status: 'safe', filePath: 'b.gguf' }
      ]
    })
    expect(first).toBe(`sha256:${createHash('sha256').update(canonical).digest('hex')}`)
  })
})

const profile: MachineProfile = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'fixture',
  cpuCount: 16,
  totalMemoryBytes: 32 * 1024 ** 3,
  freeMemoryBytes: 28 * 1024 ** 3,
  cacheFreeBytes: 100 * 1024 ** 3,
  accelerators: [],
  probedAt: '2026-08-24T00:00:00.000Z'
}

describe('model fit assessment', () => {
  const complete = {
    fileSize: 4 * 1024 ** 3,
    contextLength: 4096,
    layerCount: 32,
    embeddingLength: 4096,
    kvHeadCount: 8
  }

  it('accounts separately for cache download and an Ollama import copy', () => {
    const llama = assessModelFit(profile, { runtime: 'llama.cpp', ...complete })
    const ollama = assessModelFit(profile, { runtime: 'ollama', ...complete })
    expect(llama.requiredDiskBytes).toBe(complete.fileSize)
    expect(ollama.requiredDiskBytes).toBe(complete.fileSize * 2)
    expect(
      assessModelFit(profile, {
        runtime: 'ollama',
        ...complete,
        cached: true,
        importedAlready: true
      }).requiredDiskBytes
    ).toBe(0)
  })

  it('returns unknown rather than pretending incomplete KV metadata will fit', () => {
    expect(
      assessModelFit(profile, {
        runtime: 'llama.cpp',
        fileSize: complete.fileSize,
        contextLength: 4096
      })
    ).toMatchObject({
      level: 'unknown',
      reasons: expect.arrayContaining(['fit.metadataIncomplete'])
    })
  })

  it('accounts for discrete VRAM without double-counting unified memory', () => {
    const constrained: MachineProfile = {
      ...profile,
      totalMemoryBytes: 8 * 1024 ** 3,
      freeMemoryBytes: 8 * 1024 ** 3,
      accelerators: [
        {
          vendor: 'nvidia',
          name: 'fixture gpu',
          freeMemoryBytes: 12 * 1024 ** 3,
          totalMemoryBytes: 12 * 1024 ** 3
        }
      ]
    }
    const discrete = assessModelFit(constrained, {
      runtime: 'llama.cpp',
      ...complete,
      fileSize: 8 * 1024 ** 3
    })
    expect(discrete.level).toBe('comfortable')
    expect(discrete.estimatedGpuBytes).toBe(8 * 1024 ** 3)

    const unified = assessModelFit(
      {
        ...constrained,
        accelerators: [{ ...constrained.accelerators[0]!, unifiedMemory: true }]
      },
      { runtime: 'llama.cpp', ...complete, fileSize: 8 * 1024 ** 3 }
    )
    expect(unified.estimatedGpuBytes).toBe(0)
    expect(unified.level).toBe('unlikely')
  })
})

describe('ohmyhf lockfile schema', () => {
  const valid = {
    format: 'ohmyhf-lock/v1' as const,
    version: 1 as const,
    createdAt: '2026-08-24T00:00:00.000Z',
    hubEndpoint: 'https://huggingface.co',
    resources: [
      {
        kind: 'model' as const,
        repoId: 'org/model',
        requestedRevision: 'v1.0',
        resolvedCommit: COMMIT,
        files: [{ path: 'weights/model..gguf', size: 12, lfsSha256: 'c'.repeat(64) }],
        runtime: {
          runtime: 'llama.cpp' as const,
          filePath: 'weights/model..gguf',
          contextLength: 4096,
          maxTokens: 512,
          temperature: 0.7,
          gpuLayers: 'auto' as const
        }
      }
    ]
  }

  it('accepts exact v1 resources and rejects traversal, weak ids, and unknown versions', () => {
    expect(ohmyhfLockV1Schema.safeParse(valid).success).toBe(true)
    expect(
      ohmyhfLockV1Schema.safeParse({
        ...valid,
        resources: [
          { ...valid.resources[0], files: [{ path: '../escape', size: 1, gitBlobOid: COMMIT }] }
        ]
      }).success
    ).toBe(false)
    expect(
      ohmyhfLockV1Schema.safeParse({
        ...valid,
        resources: [{ ...valid.resources[0], resolvedCommit: 'short' }]
      }).success
    ).toBe(false)
    expect(ohmyhfLockV1Schema.safeParse({ ...valid, version: 2 }).success).toBe(false)
  })

  it('rejects duplicate resources/files and runtime files outside a subset', () => {
    expect(
      ohmyhfLockV1Schema.safeParse({
        ...valid,
        resources: [valid.resources[0], valid.resources[0]]
      }).success
    ).toBe(false)
    expect(
      ohmyhfLockV1Schema.safeParse({
        ...valid,
        resources: [
          {
            ...valid.resources[0],
            runtime: { ...valid.resources[0]!.runtime, filePath: 'other.gguf' }
          }
        ]
      }).success
    ).toBe(false)
  })
})
