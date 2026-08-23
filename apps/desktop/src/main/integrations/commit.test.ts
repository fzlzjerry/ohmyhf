import { describe, expect, it, vi } from 'vitest'
import { commitRepoFiles } from './commit'

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  createBranch: vi.fn(),
  HubApiError: class HubApiError extends Error {
    statusCode: number
    constructor(statusCode: number, message: string) {
      super(message)
      this.statusCode = statusCode
    }
  }
}))

vi.mock('@huggingface/hub', () => ({
  commit: mocks.commit,
  createBranch: mocks.createBranch,
  HubApiError: mocks.HubApiError
}))

vi.mock('../hub', () => ({
  getHubNetworkOptions: () => ({ endpoint: null, proxyUrl: null }),
  createProxiedFetch: () => fetch
}))

describe('commitRepoFiles', () => {
  it('refuses to commit without a token', async () => {
    const result = await commitRepoFiles(
      {
        kind: 'model',
        repoId: 'me/card',
        files: [{ path: 'README.md', content: '# hi' }],
        title: 'Update README'
      },
      undefined
    )
    expect(result).toEqual({ ok: false, error: '', messageKey: 'edit.needWrite' })
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('creates a branch when opening a pull request', async () => {
    mocks.commit.mockResolvedValue({ commit: { oid: 'a'.repeat(40) } })
    mocks.createBranch.mockResolvedValue(undefined)
    const result = await commitRepoFiles(
      {
        kind: 'model',
        repoId: 'me/card',
        files: [{ path: 'README.md', content: '# hi' }],
        title: 'Update README',
        createPr: true,
        branch: 'omhf/edit-readme'
      },
      'hf_token'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.branch).toBe('omhf/edit-readme')
      expect(result.compareUrl).toContain('compare/main...omhf%2Fedit-readme')
    }
    expect(mocks.createBranch).toHaveBeenCalled()
    expect(mocks.commit).toHaveBeenCalled()
  })
})
