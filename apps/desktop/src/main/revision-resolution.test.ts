import { describe, expect, it, vi } from 'vitest'
import { resolveActionRevision } from './revision-resolution'

const COMMIT = 'a'.repeat(40)
const MOVED_COMMIT = 'b'.repeat(40)

function hub(defaultBranch: string | undefined) {
  return {
    getRepoRefs: vi.fn().mockResolvedValue({
      branches: [],
      tags: [],
      pullRequests: [],
      defaultBranch
    }),
    resolveRevision: vi.fn().mockImplementation((_kind, _repoId, requested: string) => ({
      requested,
      resolvedCommit: COMMIT,
      type: 'branch',
      isDefault: requested === defaultBranch,
      readOnly: false
    }))
  }
}

describe('side-effect revision resolution', () => {
  it('discovers the actual default branch instead of assuming main', async () => {
    const client = hub('trunk')
    await expect(
      resolveActionRevision(client as never, 'model', 'org/repo', undefined, undefined, 'mismatch')
    ).resolves.toEqual({ requestedRevision: 'trunk', resolvedCommit: COMMIT })
    expect(client.resolveRevision).toHaveBeenCalledWith('model', 'org/repo', 'trunk')
  })

  it('re-resolves a symbolic ref and rejects a stale claimed commit', async () => {
    const client = hub('trunk')
    await expect(
      resolveActionRevision(
        client as never,
        'model',
        'org/repo',
        'release/1.x',
        MOVED_COMMIT,
        'download.commitMismatch'
      )
    ).rejects.toThrow('download.commitMismatch')
    expect(client.resolveRevision).toHaveBeenCalledWith('model', 'org/repo', 'release/1.x')
  })

  it('fails closed when neither a reference nor a discoverable default exists', async () => {
    const client = hub(undefined)
    await expect(
      resolveActionRevision(
        client as never,
        'dataset',
        'org/data',
        undefined,
        undefined,
        'mismatch'
      )
    ).rejects.toThrow('revision.defaultUnavailable')
    expect(client.resolveRevision).not.toHaveBeenCalled()
  })
})
