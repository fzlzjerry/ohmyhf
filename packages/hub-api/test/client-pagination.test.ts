import { describe, expect, it, vi } from 'vitest'
import { HubClient } from '../src'

const FAST = { cacheTtlMs: 0, minRequestGapMs: 0 } as const

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function linkNext(url: string): Record<string, string> {
  return { Link: `<${url}>; rel="next"` }
}

describe('HubClient.getUserLikes pagination', () => {
  it('drains Link pagination so likes past the first page count', async () => {
    const page2 = 'https://huggingface.co/api/users/julien/likes?limit=100&cursor=abc'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ repo: { name: 'meta/llama', type: 'model' } }], linkNext(page2))
      )
      .mockResolvedValueOnce(jsonResponse([{ repo: { name: 'org/data', type: 'dataset' } }]))
    const client = new HubClient({ fetchImpl, ...FAST })
    const likes = await client.getUserLikes('julien')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]![0]).toBe(page2)
    expect(likes.map((r) => r.id)).toEqual(['meta/llama', 'org/data'])
  })

  it('stops at the drain page cap even when the server keeps sending next links', async () => {
    const next = 'https://huggingface.co/api/users/julien/likes?limit=100&cursor=more'
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse([{ repo: { name: 'a/b', type: 'model' } }], linkNext(next)))
      )
    const client = new HubClient({ fetchImpl, ...FAST })
    const likes = await client.getUserLikes('julien')
    expect(fetchImpl).toHaveBeenCalledTimes(50)
    expect(likes).toHaveLength(50)
  })
})

describe('HubClient.listAccessRequests pagination', () => {
  it('drains Link pagination across request pages', async () => {
    const page2 = 'https://huggingface.co/api/models/a/b/user-access-request/pending?cursor=xyz'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ user: { user: 'alice' }, timestamp: 't1' }], linkNext(page2))
      )
      .mockResolvedValueOnce(jsonResponse([{ user: { user: 'bob' }, timestamp: 't2' }]))
    const client = new HubClient({ fetchImpl, ...FAST })
    const requests = await client.listAccessRequests('model', 'a/b', 'pending')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://huggingface.co/api/models/a/b/user-access-request/pending'
    )
    expect(fetchImpl.mock.calls[1]![0]).toBe(page2)
    expect(requests.map((r) => r.user.name)).toEqual(['alice', 'bob'])
  })
})

describe('HubClient.listDiscussions pagination', () => {
  const disc = (num: number): unknown => ({ num, title: `d${num}`, status: 'open' })

  it('returns a next-page cursor advancing the 0-based p param', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ discussions: [disc(1)], count: 2, start: 0 }))
    const client = new HubClient({ fetchImpl, ...FAST })
    const page = await client.listDiscussions('model', 'a/b', {
      type: 'pull_request',
      status: 'open'
    })
    expect(page.items.map((d) => d.num)).toEqual([1])
    expect(page.total).toBe(2)
    const next = new URL(page.nextCursor!)
    expect(next.pathname).toBe('/api/models/a/b/discussions')
    expect(next.searchParams.get('p')).toBe('1')
    expect(next.searchParams.get('type')).toBe('pull_request')
    expect(next.searchParams.get('status')).toBe('open')
  })

  it('fetches the cursor URL and stops when start+items reaches count', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ discussions: [disc(2)], count: 2, start: 1 }))
    const client = new HubClient({ fetchImpl, ...FAST })
    const cursor = 'https://huggingface.co/api/models/a/b/discussions?p=1'
    const page = await client.listDiscussions('model', 'a/b', { cursor })
    expect(fetchImpl.mock.calls[0]![0]).toBe(cursor)
    expect(page.items.map((d) => d.num)).toEqual([2])
    expect(page.total).toBe(2)
    expect(page.nextCursor).toBeUndefined()
  })

  it('omits the cursor when the endpoint sends no count', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ discussions: [disc(1)] }))
    const client = new HubClient({ fetchImpl, ...FAST })
    const page = await client.listDiscussions('space', 'a/b')
    expect(page.total).toBeUndefined()
    expect(page.nextCursor).toBeUndefined()
  })
})

describe('HubClient.getFileText 200 cap', () => {
  it('caps a chunked 200 that ignores Range, cancelling the remainder', async () => {
    let cancelled = false
    let pulls = 0
    // Pull-based source that never closes, like a large body still in flight.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(
          new TextEncoder().encode(pulls === 1 ? 'helloworld' : 'MORE DATA PAST THE CAP')
        )
      },
      cancel() {
        cancelled = true
      }
    })
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }))
    const client = new HubClient({ fetchImpl, ...FAST })
    const result = await client.getFileText('model', 'a/b', 'README.md', 'main', 10)
    expect(result.content).toBe('helloworld')
    expect(result.truncated).toBe(true)
    expect(cancelled).toBe(true)
  })

  it('reports the full size from Content-Length when a 200 exceeds the cap', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('helloworldextra', { status: 200, headers: { 'Content-Length': '15' } })
      )
    const client = new HubClient({ fetchImpl, ...FAST })
    const result = await client.getFileText('model', 'a/b', 'README.md', 'main', 10)
    expect(result).toEqual({ content: 'helloworld', truncated: true, size: 15 })
  })

  it('keeps small 200 bodies intact and not truncated', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('tiny', { status: 200 }))
    const client = new HubClient({ fetchImpl, ...FAST })
    const result = await client.getFileText('model', 'a/b', 'config.json')
    expect(result).toEqual({ content: 'tiny', truncated: false, size: 4 })
  })
})
