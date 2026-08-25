import { describe, expect, it, vi } from 'vitest'
import { HubApiError, HubClient } from '../src'

function jsonResponse(body: unknown, init: { status?: number; link?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.link ? { Link: init.link } : {})
    }
  })
}

describe('HubClient.buildSearchUrl', () => {
  const client = new HubClient({ cacheTtlMs: 0 })

  it('normalizes a path-prefixed custom endpoint', () => {
    const custom = new HubClient({ endpoint: 'https://hub.example.test/hf///?ignored=1#x' })
    expect(custom.baseUrl).toBe('https://hub.example.test/hf')
    expect(new URL(custom.buildSearchUrl({ kind: 'model', sort: 'trending' })).pathname).toBe(
      '/hf/api/models'
    )
  })

  it('builds a model search URL with filters and sort', () => {
    const url = new URL(
      client.buildSearchUrl({
        kind: 'model',
        search: 'llama',
        pipelineTag: 'text-generation',
        library: 'transformers',
        license: 'mit',
        tags: ['gguf'],
        sort: 'downloads',
        limit: 50
      })
    )
    expect(url.pathname).toBe('/api/models')
    expect(url.searchParams.get('search')).toBe('llama')
    expect(url.searchParams.get('pipeline_tag')).toBe('text-generation')
    expect(url.searchParams.get('library')).toBe('transformers')
    expect(url.searchParams.getAll('filter')).toEqual(['gguf', 'license:mit'])
    expect(url.searchParams.get('sort')).toBe('downloads')
    expect(url.searchParams.get('direction')).toBe('-1')
    expect(url.searchParams.get('limit')).toBe('50')
  })

  it('maps trending sort to trendingScore', () => {
    const url = new URL(client.buildSearchUrl({ kind: 'space', sort: 'trending' }))
    expect(url.pathname).toBe('/api/spaces')
    expect(url.searchParams.get('sort')).toBe('trendingScore')
  })

  it('includes inference_provider for models only', () => {
    const modelUrl = new URL(
      client.buildSearchUrl({ kind: 'model', sort: 'trending', inferenceProvider: 'novita' })
    )
    expect(modelUrl.searchParams.get('inference_provider')).toBe('novita')
    const datasetUrl = new URL(
      client.buildSearchUrl({ kind: 'dataset', sort: 'trending', inferenceProvider: 'novita' })
    )
    expect(datasetUrl.searchParams.get('inference_provider')).toBeNull()
    const spaceUrl = new URL(
      client.buildSearchUrl({ kind: 'space', sort: 'trending', inferenceProvider: 'novita' })
    )
    expect(spaceUrl.searchParams.get('inference_provider')).toBeNull()
  })

  it('expands cardData and runtime for spaces only', () => {
    const spaceUrl = new URL(client.buildSearchUrl({ kind: 'space', sort: 'trending' }))
    const spaceExpand = spaceUrl.searchParams.getAll('expand[]')
    expect(spaceExpand).toContain('cardData')
    expect(spaceExpand).toContain('runtime')
    const modelUrl = new URL(client.buildSearchUrl({ kind: 'model', sort: 'trending' }))
    const modelExpand = modelUrl.searchParams.getAll('expand[]')
    expect(modelExpand).not.toContain('cardData')
    expect(modelExpand).not.toContain('runtime')
  })
})

describe('HubClient.searchRepos', () => {
  it('maps raw repos and extracts the next cursor from the Link header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        [
          {
            id: 'meta-llama/Llama-3-8B',
            likes: 100,
            downloads: 5000,
            tags: ['license:llama3', 'text-generation'],
            pipeline_tag: 'text-generation',
            private: false,
            safetensors: { total: 8_030_000_000 }
          }
        ],
        { link: '<https://huggingface.co/api/models?cursor=abc>; rel="next"' }
      )
    )
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    const page = await client.searchRepos({ kind: 'model', sort: 'trending' })
    expect(page.items).toHaveLength(1)
    const item = page.items[0]!
    expect(item.author).toBe('meta-llama')
    expect(item.name).toBe('Llama-3-8B')
    expect(item.license).toBe('llama3')
    expect(item.paramCount).toBe(8_030_000_000)
    expect(page.nextCursor).toBe('https://huggingface.co/api/models?cursor=abc')
  })

  it('uses the cursor URL verbatim when paginating', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    await client.searchRepos({ kind: 'model', sort: 'trending', cursor: 'https://x.test/next' })
    expect(fetchImpl).toHaveBeenCalledWith('https://x.test/next', expect.anything())
  })
})

describe('HubClient caching', () => {
  it('serves repeated GETs from cache within the TTL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 60_000 })
    await client.searchRepos({ kind: 'model', sort: 'trending' })
    await client.searchRepos({ kind: 'model', sort: 'trending' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('partitions the cache by auth state', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])))
    let token: string | undefined = undefined
    const client = new HubClient({ fetchImpl, cacheTtlMs: 60_000, getAccessToken: () => token })
    await client.searchRepos({ kind: 'model', sort: 'trending' })
    token = 'hf_secret'
    await client.searchRepos({ kind: 'model', sort: 'trending' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const secondHeaders = fetchImpl.mock.calls[1]![1].headers as Record<string, string>
    expect(secondHeaders.Authorization).toBe('Bearer hf_secret')
  })
})

describe('HubClient errors and readme', () => {
  it('resolves repo detail at the requested revision', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'a/b',
          author: 'a',
          sha: '0123456789abcdef0123456789abcdef01234567',
          tags: []
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, minRequestGapMs: 0 })

    await client.getRepoDetail('model', 'a/b', 'refs/pr/12')

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://huggingface.co/api/models/a/b/revision/refs%2Fpr%2F12',
      expect.any(Object)
    )
  })

  it('throws HubApiError with status on failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    await expect(client.getRepoDetail('model', 'a/b')).rejects.toMatchObject({
      name: 'HubApiError',
      status: 500
    })
  })

  it('includes the Hub error JSON in mutation HubApiError messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'expected string, received null → at description' }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, minRequestGapMs: 0 })
    const err = await client
      .createCollection({ namespace: 'julien', title: 'x', private: false })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HubApiError)
    expect(err).toMatchObject({ status: 400 })
    expect((err as HubApiError).message).toContain('400 Bad Request')
    expect((err as HubApiError).message).toContain(
      'expected string, received null → at description'
    )
  })

  it('returns empty string for repos without a README', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    await expect(client.getReadme('model', 'a/b')).resolves.toBe('')
  })

  it('builds resolve URLs with the kind prefix', () => {
    const client = new HubClient({ cacheTtlMs: 0 })
    expect(client.resolveUrl('dataset', 'org/data', 'main', 'data/train.csv')).toBe(
      'https://huggingface.co/datasets/org/data/resolve/main/data/train.csv'
    )
  })
})

describe('HubClient.getDailyPapers', () => {
  it('maps nested paper payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          paper: {
            id: '2401.00001',
            title: 'Attention Is Still All You Need',
            summary: 'A paper.',
            upvotes: 42,
            authors: [{ name: 'A. Researcher' }]
          },
          publishedAt: '2026-01-01T00:00:00.000Z'
        }
      ])
    )
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    const page = await client.getDailyPapers()
    expect(page.items[0]).toMatchObject({
      id: '2401.00001',
      upvotes: 42,
      authors: ['A. Researcher'],
      publishedAt: '2026-01-01T00:00:00.000Z'
    })
  })

  it('forwards period sort and week or month onto the Hub query', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    await client.getDailyPapers({
      period: 'weekly',
      sort: 'trending',
      week: '2026-W35'
    })
    const weekly = new URL(String(fetchImpl.mock.calls[0]![0]))
    expect(weekly.pathname).toBe('/api/daily_papers')
    expect(weekly.searchParams.get('limit')).toBe('50')
    expect(weekly.searchParams.get('sort')).toBe('trending')
    expect(weekly.searchParams.get('week')).toBe('2026-W35')
    expect(weekly.searchParams.get('month')).toBeNull()

    await client.getDailyPapers({ period: 'monthly', month: '2026-08', sort: 'publishedAt' })
    const monthly = new URL(String(fetchImpl.mock.calls[1]![0]))
    expect(monthly.searchParams.get('month')).toBe('2026-08')
    expect(monthly.searchParams.get('sort')).toBe('publishedAt')
  })

  it('maps Hub extras used by the in-app reader', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          paper: {
            id: '2401.00001',
            title: 'Attention Is Still All You Need',
            summary: 'A paper.',
            upvotes: 42,
            authors: [{ name: 'A. Researcher', user: { name: 'aresearcher' } }],
            githubRepo: 'org/repo',
            projectPage: 'https://example.test/project',
            aiSummary: 'Short take.'
          },
          submittedBy: { name: 'Submitter' },
          submittedOnDailyAt: '2026-01-01T00:00:00.000Z'
        }
      ])
    )
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    const page = await client.getDailyPapers()
    expect(page.items[0]).toMatchObject({
      authorProfiles: [{ name: 'A. Researcher', username: 'aresearcher' }],
      githubRepo: 'org/repo',
      projectPage: 'https://example.test/project',
      submittedBy: 'Submitter',
      submittedOnDailyAt: '2026-01-01T00:00:00.000Z',
      aiSummary: 'Short take.'
    })
  })
})

describe('HubClient.getPaper', () => {
  it('fetches a single paper and maps the unwrapped payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        id: '2401.00001',
        title: 'Attention Is Still All You Need',
        summary: 'A paper.',
        upvotes: 42,
        publishedAt: '2026-01-01T00:00:00.000Z',
        authors: [{ name: 'A. Researcher' }]
      })
    )
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    const paper = await client.getPaper('2401.00001')
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://huggingface.co/api/papers/2401.00001')
    expect(paper).toEqual({
      id: '2401.00001',
      title: 'Attention Is Still All You Need',
      summary: 'A paper.',
      publishedAt: '2026-01-01T00:00:00.000Z',
      upvotes: 42,
      authors: ['A. Researcher'],
      authorProfiles: [{ name: 'A. Researcher' }],
      thumbnail: undefined,
      numComments: undefined,
      githubRepo: undefined,
      projectPage: undefined,
      submittedBy: undefined,
      submittedOnDailyAt: undefined,
      aiSummary: undefined
    })
  })

  it('throws HubApiError with the status for unknown papers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    await expect(client.getPaper('9999.99999')).rejects.toMatchObject({
      name: 'HubApiError',
      status: 404
    })
  })
})

describe('HubClient.getPaperRelated', () => {
  it('searches models, datasets, and spaces with filter=arxiv:{id}', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    await client.getPaperRelated('2401.00001')
    const urls = fetchImpl.mock.calls.map(([url]) => new URL(String(url)))
    expect(urls.map((url) => url.pathname).sort()).toEqual([
      '/api/datasets',
      '/api/models',
      '/api/spaces'
    ])
    for (const url of urls) {
      expect(url.searchParams.getAll('filter')).toContain('arxiv:2401.00001')
    }
  })
})

describe('HubClient.getPaperDocument', () => {
  it('loads Markdown from the Hub paper page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('# Hello', { status: 200 }))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    const document = await client.getPaperDocument('2401.00001', 'markdown')
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://huggingface.co/papers/2401.00001.md')
    expect(document).toEqual({ format: 'markdown', text: '# Hello' })
  })

  it('loads the arXiv PDF through the proxied fetch', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0 })
    const document = await client.getPaperDocument('2401.00001', 'pdf')
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://arxiv.org/pdf/2401.00001.pdf')
    expect(document.format).toBe('pdf')
    if (document.format === 'pdf') {
      expect(document.tooLarge).toBe(false)
      expect([...document.bytes]).toEqual([37, 80, 68, 70])
    }
  })
})

it('HubApiError is an Error', () => {
  expect(new HubApiError('x')).toBeInstanceOf(Error)
})
