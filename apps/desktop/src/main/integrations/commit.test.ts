import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HubSdk from '@huggingface/hub'
import { commitRepoFiles } from './commit'

const STARTING_POINT = 'c'.repeat(40)

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  createBranch: vi.fn(),
  fetchImpl: vi.fn(),
  network: { endpoint: null as string | null, proxyUrl: null as string | null },
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
  getHubNetworkOptions: () => mocks.network,
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
    mocks.network = { endpoint: null, proxyUrl: null }
  })

  it('refuses to commit without a token', async () => {
    const result = await commitRepoFiles(
      {
        kind: 'model',
        repoId: 'me/card',
        files: [{ path: 'README.md', content: '# hi' }],
        title: 'Update README',
        startingPoint: STARTING_POINT
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
        startingPoint: STARTING_POINT
      },
      'hf_token'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.branch).toMatch(/^omhf\/edit-/)
      expect(result.compareUrl).toBe('https://huggingface.co/me/card/discussions/3')
    }
    expect(mocks.createBranch).toHaveBeenCalledWith(
      expect.objectContaining({ revision: STARTING_POINT })
    )
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
        startingPoint: STARTING_POINT
      },
      'hf_token'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.compareUrl).toContain(`compare/master...${encodeURIComponent(result.branch)}`)
    }
  })

  it('commits directly to the explicitly selected branch', async () => {
    mocks.commit.mockResolvedValue({ commit: { oid: 'a'.repeat(40) } })
    const result = await commitRepoFiles(
      {
        kind: 'model',
        repoId: 'me/card',
        files: [{ path: 'README.md', content: '# hi' }],
        title: 'Update README',
        branch: 'master',
        startingPoint: STARTING_POINT
      },
      'hf_token'
    )
    expect(result).toEqual({ ok: true, branch: 'master', compareUrl: undefined })
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ branch: 'master' }))
    expect(mocks.commit.mock.calls[0]?.[0]).not.toHaveProperty('isPullRequest')
    expect(mocks.fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps a started save on its original endpoint when network settings change', async () => {
    const sdk = await vi.importActual<typeof HubSdk>('@huggingface/hub')
    const sent: Array<{ url: string; authorization: string | null }> = []
    mocks.commit.mockImplementation(sdk.commit)
    mocks.network = { endpoint: 'https://original.example.test', proxyUrl: null }
    mocks.fetchImpl.mockImplementation(async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), authorization: new Headers(init.headers).get('authorization') })
      if (String(url).includes('/preupload/')) {
        return Response.json({ files: [{ path: 'README.md', uploadMode: 'regular' }] })
      }
      if (String(url).includes('/commit/')) {
        return Response.json({ commitOid: 'a'.repeat(40), commitUrl: `${url}/result` })
      }
      throw new Error(`Unexpected commit transport: ${url}`)
    })

    const saving = commitRepoFiles(
      {
        kind: 'model',
        repoId: 'me/card',
        files: [{ path: 'README.md', content: '# updated' }],
        title: 'Update README',
        branch: 'main',
        startingPoint: STARTING_POINT
      },
      'hf_original'
    )
    mocks.network.endpoint = 'https://replacement.example.test'

    expect(await saving).toMatchObject({ ok: true, branch: 'main' })
    expect(sent).toEqual([
      {
        url: 'https://original.example.test/api/models/me/card/preupload/main',
        authorization: 'Bearer hf_original'
      },
      {
        url: 'https://original.example.test/api/models/me/card/commit/main',
        authorization: 'Bearer hf_original'
      }
    ])
  })

  it('fails before writing when a direct commit omits its branch', async () => {
    const result = await commitRepoFiles(
      {
        kind: 'model',
        repoId: 'me/card',
        files: [{ path: 'README.md', content: '# hi' }],
        title: 'Update README',
        startingPoint: STARTING_POINT
      },
      'hf_token'
    )
    expect(result).toMatchObject({ ok: false, messageKey: 'edit.commitFailed' })
    expect(mocks.commit).not.toHaveBeenCalled()
  })
})
