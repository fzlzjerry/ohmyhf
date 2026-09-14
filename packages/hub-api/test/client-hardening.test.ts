import { describe, expect, it, vi } from 'vitest'
import { HubApiError, HubClient } from '../src'

const MODEL_QUERY = { kind: 'model', sort: 'trending' } as const
const DATASET_QUERY = { kind: 'dataset', sort: 'trending' } as const

// Every test opts out of the default 120ms start gap so the suite stays fast.
const FAST = { minRequestGapMs: 0, maxConcurrent: 4 }

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  })
}

function rateLimited(): Response {
  return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })
}

function requestHeaders(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  const init = fetchImpl.mock.calls[call]![1] as RequestInit
  return init.headers as Record<string, string>
}

describe('HubClient request coalescing', () => {
  it('shares one fetch between identical concurrent GETs', async () => {
    let release!: (res: Response) => void
    const gate = new Promise<Response>((resolve) => {
      release = resolve
    })
    const fetchImpl = vi.fn().mockReturnValue(gate)
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    const a = client.searchRepos(MODEL_QUERY)
    const b = client.searchRepos(MODEL_QUERY)
    release(jsonResponse([]))
    const [pageA, pageB] = await Promise.all([a, b])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(pageA.items).toEqual([])
    expect(pageB.items).toEqual([])
  })

  it('fetches again once the coalesced request settles (ttl 0)', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    await client.searchRepos(MODEL_QUERY)
    await client.searchRepos(MODEL_QUERY)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each(['json', 'text', 'cookie'] as const)(
    'isolates %s reads across account switches and late completions',
    async (format) => {
      let credential = 'account-A'
      const releases: Array<(response: Response) => void> = []
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(() => new Promise<Response>((resolve) => releases.push(resolve)))
      const client = new HubClient({
        fetchImpl,
        ...FAST,
        getAccessToken: () => credential,
        getSessionCookie: () => credential
      })
      const read = async (): Promise<string | undefined> => {
        if (format === 'text') return client.getReadme('model', 'private/repo')
        if (format === 'json') return (await client.getRepoDetail('model', 'private/repo')).id
        const feed = await client.getRecentActivity()
        return feed.cursor
          ? (new URL(feed.cursor).searchParams.get('cursor') ?? undefined)
          : undefined
      }
      const response = (owner: string): Response =>
        format === 'text'
          ? new Response(owner)
          : jsonResponse(
              format === 'json'
                ? { id: owner }
                : { recentActivity: [{ type: 'unsupported' }], cursor: owner }
            )
      const old = read()
      await Promise.resolve()
      credential = 'account-B'
      // Text exercises explicit sign-out invalidation; the other paths detect
      // changed credentials even when the caller forgets to invalidate.
      if (format === 'text') client.invalidateCache()
      const current = read()
      await Promise.resolve()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      releases[0]!(response('account-A'))
      expect(await old).toBe('account-A')
      const joined = read()
      releases[1]!(response('account-B'))
      expect(await current).toBe('account-B')
      expect(await joined).toBe('account-B')
      expect(await read()).toBe('account-B')
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    }
  )

  it('does not overwrite a newer cache value after ordinary invalidation', async () => {
    let release!: (response: Response) => void
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          })
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'new' }))
    const client = new HubClient({ fetchImpl, ...FAST })
    const old = client.getRepoDetail('model', 'a/b')
    await Promise.resolve()
    client.invalidateCache()
    expect((await client.getRepoDetail('model', 'a/b')).id).toBe('new')
    release(jsonResponse({ id: 'old' }))
    await old
    expect((await client.getRepoDetail('model', 'a/b')).id).toBe('new')
  })

  it('does not join an older in-flight browsing response for fresh reads', async () => {
    let release!: (response: Response) => void
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          })
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'fresh' }))
    const client = new HubClient({ fetchImpl, ...FAST })
    const browsing = client.getRepoDetail('model', 'a/b')
    await Promise.resolve()
    expect((await client.getRepoDetail('model', 'a/b', undefined, { fresh: true })).id).toBe(
      'fresh'
    )
    release(jsonResponse({ id: 'old' }))
    await browsing
  })
})

describe('HubClient rate-limit handling', () => {
  it('retries a 429 honoring Retry-After and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(jsonResponse([]))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    const page = await client.searchRepos(MODEL_QUERY)
    expect(page.items).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries 503 responses too', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('unavailable', { status: 503, headers: { 'Retry-After': '0' } })
      )
      .mockResolvedValueOnce(jsonResponse([]))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    await expect(client.searchRepos(MODEL_QUERY)).resolves.toMatchObject({ items: [] })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('throws a rate-limited HubApiError after exhausting retries', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(rateLimited()))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, maxRetries: 2, ...FAST })
    const err = (await client.searchRepos(MODEL_QUERY).catch((e: unknown) => e)) as HubApiError
    expect(err).toBeInstanceOf(HubApiError)
    expect(err.status).toBe(429)
    expect(err.message).toContain('rate limited')
    // Initial attempt + maxRetries.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not retry non-transient failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    await expect(client.searchRepos(MODEL_QUERY)).rejects.toMatchObject({ status: 500 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('HubClient stale-on-error', () => {
  it('serves the expired cache entry when the refresh fails on the network', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'a/b' }]))
      .mockRejectedValueOnce(new TypeError('network down'))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 20, ...FAST })
    const fresh = await client.searchRepos(MODEL_QUERY)
    expect(fresh.items).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const stale = await client.searchRepos(MODEL_QUERY)
    expect(stale.items).toHaveLength(1)
    expect(stale.items[0]!.id).toBe('a/b')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('serves the expired cache entry after 429 retries are exhausted', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'a/b' }]))
      .mockImplementation(() => Promise.resolve(rateLimited()))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 20, maxRetries: 1, ...FAST })
    await client.searchRepos(MODEL_QUERY)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const stale = await client.searchRepos(MODEL_QUERY)
    expect(stale.items[0]!.id).toBe('a/b')
  })

  it('does not serve stale entries for permanent errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'a/b' }]))
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 20, ...FAST })
    await client.searchRepos(MODEL_QUERY)
    await new Promise((resolve) => setTimeout(resolve, 40))
    await expect(client.searchRepos(MODEL_QUERY)).rejects.toMatchObject({ status: 404 })
  })
})

describe('HubClient limiter', () => {
  it('caps in-flight requests at maxConcurrent', async () => {
    const releases: Array<(res: Response) => void> = []
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => new Promise<Response>((resolve) => releases.push(resolve)))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, maxConcurrent: 1, minRequestGapMs: 0 })
    const a = client.searchRepos(MODEL_QUERY)
    const b = client.searchRepos(DATASET_QUERY)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    releases[0]!(jsonResponse([]))
    await a
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    releases[1]!(jsonResponse([]))
    await b
  })

  it('spaces request starts by minRequestGapMs', async () => {
    const starts: number[] = []
    const fetchImpl = vi.fn().mockImplementation(() => {
      starts.push(Date.now())
      return Promise.resolve(jsonResponse([]))
    })
    const client = new HubClient({
      fetchImpl,
      cacheTtlMs: 0,
      maxConcurrent: 4,
      minRequestGapMs: 50
    })
    await Promise.all([client.searchRepos(MODEL_QUERY), client.searchRepos(DATASET_QUERY)])
    expect(starts).toHaveLength(2)
    expect(Math.abs(starts[1]! - starts[0]!)).toBeGreaterThanOrEqual(40)
  })
})

describe('HubClient.getFileText', () => {
  it('returns ranged text with the total size from Content-Range', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('helloworld', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-9/100' }
      })
    )
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    const result = await client.getFileText('model', 'a/b', 'README.md', 'main', 10)
    expect(result).toEqual({ content: 'helloworld', truncated: true, size: 100 })
    const headers = requestHeaders(fetchImpl)
    expect(headers.Range).toBe('bytes=0-9')
    expect(headers['Accept-Encoding']).toBe('identity')
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://huggingface.co/a/b/resolve/main/README.md')
  })

  it('marks small files as not truncated', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('tiny', {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-3/4' }
      })
    )
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    const result = await client.getFileText('model', 'a/b', 'config.json')
    expect(result).toEqual({ content: 'tiny', truncated: false, size: 4 })
  })

  it('rejects binary content containing NUL bytes', async () => {
    const body = new Uint8Array([104, 105, 0, 1, 2])
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    await expect(client.getFileText('model', 'a/b', 'model.bin')).rejects.toThrow('binary file')
  })
})

describe('HubClient.getSafetensorsHeader', () => {
  function encodeHeader(header: unknown): { lenBytes: Uint8Array; jsonBytes: Uint8Array } {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(header))
    const lenBytes = new Uint8Array(8)
    new DataView(lenBytes.buffer).setBigUint64(0, BigInt(jsonBytes.length), true)
    return { lenBytes, jsonBytes }
  }

  it('parses a hand-built header and computes totalParams', async () => {
    const { lenBytes, jsonBytes } = encodeHeader({
      __metadata__: { format: 'pt' },
      'model.b': { dtype: 'F32', shape: [2, 3], data_offsets: [0, 24] },
      'model.a': { dtype: 'F16', shape: [4], data_offsets: [24, 32] },
      scalar: { dtype: 'F32', shape: [], data_offsets: [32, 36] }
    })
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string>).Range
      const body = range === 'bytes=0-7' ? lenBytes : jsonBytes
      return Promise.resolve(new Response(body, { status: 206 }))
    })
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    const header = await client.getSafetensorsHeader('model', 'a/b', 'model.safetensors')
    expect(header.metadata).toEqual({ format: 'pt' })
    expect(header.tensors.map((t) => t.name)).toEqual(['model.a', 'model.b', 'scalar'])
    expect(header.tensors[0]).toEqual({ name: 'model.a', dtype: 'F16', shape: [4] })
    // 4 + 2*3 + scalar(1)
    expect(header.totalParams).toBe(11)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(requestHeaders(fetchImpl, 1).Range).toBe(`bytes=8-${8 + jsonBytes.length - 1}`)
  })

  it('rejects implausible header lengths without fetching the body', async () => {
    const lenBytes = new Uint8Array(8)
    new DataView(lenBytes.buffer).setBigUint64(0, BigInt(64 * 1024 * 1024), true)
    const fetchImpl = vi.fn().mockResolvedValue(new Response(lenBytes, { status: 206 }))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    await expect(client.getSafetensorsHeader('model', 'a/b', 'x.safetensors')).rejects.toThrow(
      'implausible header length'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('cancels ignored Range responses as soon as each header prefix is read', async () => {
    const { lenBytes, jsonBytes } = encodeHeader({
      weight: { dtype: 'F32', shape: [2], data_offsets: [0, 8] }
    })
    const prefix = new Uint8Array(8 + jsonBytes.length)
    prefix.set(lenBytes)
    prefix.set(jsonBytes, 8)
    let pulled = 0
    let cancelled = 0
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      let offset = 0
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.enqueue(new Uint8Array([prefix[offset] ?? 1]))
              offset += 1
              pulled += 1
              if (offset === 4096) controller.close()
            },
            cancel() {
              cancelled += 1
            }
          },
          { highWaterMark: 0 }
        ),
        { status: 200 }
      )
    })
    const client = new HubClient({ fetchImpl, ...FAST })
    const header = await client.getSafetensorsHeader('model', 'a/b', 'weights.safetensors')
    expect(header.totalParams).toBe(2)
    expect(pulled).toBe(8 + prefix.length)
    expect(cancelled).toBe(2)
  })

  it.each([200, 206])('bounds byte-window reads from a dishonest %s response', async (status) => {
    let pulled = 0
    let cancelled = false
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                const offset = status === 206 ? 4 : 0
                controller.enqueue(new Uint8Array([offset + pulled++]))
                if (pulled === 4096) controller.close()
              },
              cancel() {
                cancelled = true
              }
            },
            { highWaterMark: 0 }
          ),
          { status }
        )
    )
    const client = new HubClient({ fetchImpl, ...FAST })
    expect(await client.fetchFileRange('model', 'a/b', 'data.parquet', 4, 7)).toEqual(
      new Uint8Array([4, 5, 6, 7])
    )
    expect(pulled).toBe(status === 200 ? 8 : 4)
    expect(cancelled).toBe(true)
  })
})

describe('HubClient datasets-server endpoints', () => {
  it('maps dataset splits and hits the datasets-server host', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        splits: [
          { dataset: 'a/b', config: 'default', split: 'train' },
          { dataset: 'a/b', config: 'default', split: 'test' }
        ]
      })
    )
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    const splits = await client.getDatasetSplits('a/b')
    expect(splits).toEqual([
      { config: 'default', split: 'train' },
      { config: 'default', split: 'test' }
    ])
    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.origin).toBe('https://datasets-server.huggingface.co')
    expect(url.pathname).toBe('/splits')
    expect(url.searchParams.get('dataset')).toBe('a/b')
  })

  it('throws HubApiError with the status on datasets-server failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }))
    const client = new HubClient({ fetchImpl, cacheTtlMs: 0, ...FAST })
    await expect(client.getDatasetSplits('a/b')).rejects.toMatchObject({
      name: 'HubApiError',
      status: 404
    })
  })

  it('maps, stringifies and truncates dataset rows', async () => {
    const long = 'x'.repeat(300)
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        features: [{ name: 'text' }, { name: 'label' }, { name: 'meta' }],
        rows: [
          { row: { text: long, label: 3, meta: null } },
          { row: { text: 'hi', label: 0, meta: { a: 1 } } }
        ],
        num_rows_total: 1234
      })
    )
    const client = new HubClient({
      fetchImpl,
      cacheTtlMs: 0,
      ...FAST,
      getAccessToken: () => 'hf_tok'
    })
    const result = await client.getDatasetRows('a/b', 'default', 'train', 0, 2)
    expect(result.columns).toEqual(['text', 'label', 'meta'])
    expect(result.total).toBe(1234)
    expect(result.rows[0]![0]).toHaveLength(201)
    expect(result.rows[0]![0]!.endsWith('…')).toBe(true)
    expect(result.rows[0]![1]).toBe('3')
    expect(result.rows[0]![2]).toBe('')
    expect(result.rows[1]!).toEqual(['hi', '0', '{"a":1}'])
    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.searchParams.get('offset')).toBe('0')
    expect(url.searchParams.get('length')).toBe('2')
    // datasets-server.huggingface.co qualifies for the Authorization header.
    expect(requestHeaders(fetchImpl).Authorization).toBe('Bearer hf_tok')
  })
})
