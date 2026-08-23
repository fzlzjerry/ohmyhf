import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitRepoFiles } from './commit'

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  createBranch: vi.fn(),
  fetchImpl: vi.fn(),
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
  createProxiedFetch: () => mocks.fetchImpl
}))

function mockDefaultBranch(name: string, sha = 'b'.repeat(40)): void {
  mocks.fetchImpl.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/refs')) {
      return new Response(
        JSON.stringify({
          branches: [{ name, ref: `refs/heads/${name}`, targetCommit: sha }]
        })
      )
    }
    return new Response(JSON.stringify({ sha }))
  })
}

describe('commitRepoFiles', () => {
  afterEach(() => {
    mocks.commit.mockReset()
    mocks.createBranch.mockReset()
    mocks.fetchImpl.mockReset()
  })

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
    mocks.commit.mockResolvedValue({
      commit: { oid: 'a'.repeat(40) },
      pullRequestUrl: 'https://huggingface.co/me/card/discussions/3'
    })
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
      expect(result.compareUrl).toBe('https://huggingface.co/me/card/discussions/3')
    }
    expect(mocks.createBranch).toHaveBeenCalled()
    expect(mocks.commit).toHaveBeenCalled()
    expect(mocks.fetchImpl).not.toHaveBeenCalled()
  })

  it('builds a compare URL from the repo default branch when the SDK omits a PR URL', async () => {
    mocks.commit.mockResolvedValue({ commit: { oid: 'a'.repeat(40) } })
    mocks.createBranch.mockResolvedValue(undefined)
    mockDefaultBranch('master')
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
      expect(result.compareUrl).toContain('compare/master...omhf%2Fedit-readme')
    }
  })

  it('reports the resolved default branch when the client omits one', async () => {
    mocks.commit.mockResolvedValue({ commit: { oid: 'a'.repeat(40) } })
    mockDefaultBranch('master')
    const result = await commitRepoFiles(
      {
        kind: 'model',
        repoId: 'me/card',
        files: [{ path: 'README.md', content: '# hi' }],
        title: 'Update README'
      },
      'hf_token'
    )
    expect(result).toEqual({ ok: true, branch: 'master', compareUrl: undefined })
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ branch: undefined }))
    expect(mocks.commit.mock.calls[0]?.[0]).not.toHaveProperty('isPullRequest')
  })
})
