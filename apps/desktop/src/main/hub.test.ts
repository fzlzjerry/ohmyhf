import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolution: 'DIRECT',
  setProxy: vi.fn(async () => undefined),
  resolveProxy: vi.fn(async () => 'DIRECT'),
  fetchCalls: [] as Array<{ input: unknown; init: Record<string, unknown> | undefined }>
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  session: {
    fromPartition: () => ({
      setProxy: mocks.setProxy,
      resolveProxy: mocks.resolveProxy
    })
  }
}))

vi.mock('undici', () => ({
  ProxyAgent: class {
    readonly uri: string

    constructor(uri: string) {
      this.uri = uri
    }
  },
  fetch: async (input: unknown, init: Record<string, unknown> | undefined) => {
    mocks.fetchCalls.push({ input, init })
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  }
}))

import {
  createFailClosedDynamicProxiedFetch,
  createProxiedFetch,
  proxyUrlFromResolution,
  resolveSystemProxyRoute,
  resolveSystemProxyUrl
} from './hub'

describe('Hub system proxy transport', () => {
  beforeEach(() => {
    mocks.resolution = 'DIRECT'
    mocks.setProxy.mockClear()
    mocks.resolveProxy.mockReset()
    mocks.resolveProxy.mockImplementation(async () => mocks.resolution)
    mocks.fetchCalls.length = 0
  })

  it('parses Chromium HTTP(S) proxy resolution strings', () => {
    expect(proxyUrlFromResolution('PROXY 127.0.0.1:6152')).toBe('http://127.0.0.1:6152')
    expect(proxyUrlFromResolution('HTTPS proxy.example:8443; DIRECT')).toBe(
      'https://proxy.example:8443'
    )
    expect(proxyUrlFromResolution('SOCKS5 127.0.0.1:1080; DIRECT')).toBeNull()
    expect(proxyUrlFromResolution('DIRECT')).toBeNull()
  })

  it('routes an unconfigured client through the resolved system proxy', async () => {
    mocks.resolution = 'PROXY 127.0.0.1:6152'
    const fetchImpl = createProxiedFetch(null)

    await fetchImpl('https://huggingface.co/api/models?limit=1')

    expect(mocks.setProxy).toHaveBeenCalledWith({ mode: 'system' })
    expect(mocks.resolveProxy).toHaveBeenCalledWith('https://huggingface.co/api/models?limit=1')
    expect((mocks.fetchCalls[0]?.init?.dispatcher as { uri?: string } | undefined)?.uri).toBe(
      'http://127.0.0.1:6152'
    )
  })

  it('keeps an explicit app proxy ahead of the system resolver', async () => {
    const resolver = vi.fn(async () => 'PROXY 127.0.0.1:9999')
    const fetchImpl = createProxiedFetch('http://127.0.0.1:7890', resolver)

    await fetchImpl('https://huggingface.co/api/models?limit=1')

    expect(resolver).not.toHaveBeenCalled()
    expect((mocks.fetchCalls[0]?.init?.dispatcher as { uri?: string } | undefined)?.uri).toBe(
      'http://127.0.0.1:7890'
    )
  })

  it('re-reads the app proxy for each request from long-lived services', async () => {
    let proxyUrl: string | null = 'http://127.0.0.1:7890'
    const resolver = vi.fn(async () => 'PROXY 127.0.0.1:9999')
    const fetchImpl = createFailClosedDynamicProxiedFetch(() => proxyUrl, resolver)

    await fetchImpl('https://eu.i.posthog.com/i/v0/e/')
    proxyUrl = 'http://127.0.0.1:7891'
    await fetchImpl('https://eu.i.posthog.com/i/v0/e/')

    expect(resolver).not.toHaveBeenCalled()
    expect(
      mocks.fetchCalls.map(({ init }) => (init?.dispatcher as { uri?: string } | undefined)?.uri)
    ).toEqual(['http://127.0.0.1:7890', 'http://127.0.0.1:7891'])
  })

  it('falls back to direct undici fetch when the OS reports DIRECT or resolution fails', async () => {
    expect(await resolveSystemProxyUrl('https://huggingface.co', async () => 'DIRECT')).toBeNull()
    expect(
      await resolveSystemProxyUrl('https://huggingface.co', async () => {
        throw new Error('proxy service unavailable')
      })
    ).toBeNull()

    const fetchImpl = createProxiedFetch(null, async () => 'DIRECT')
    await fetchImpl('https://huggingface.co/api/models?limit=1')
    expect(mocks.fetchCalls[0]?.init).not.toHaveProperty('dispatcher')
  })

  it('fails closed for privacy-sensitive requests when the system route is unusable', async () => {
    expect(await resolveSystemProxyRoute('https://eu.i.posthog.com', async () => 'DIRECT')).toEqual(
      {
        kind: 'direct'
      }
    )
    expect(
      await resolveSystemProxyRoute('https://eu.i.posthog.com', async () => 'SOCKS5 127.0.0.1:1080')
    ).toEqual({ kind: 'unavailable' })
    expect(
      await resolveSystemProxyRoute('https://eu.i.posthog.com', async () => {
        throw new Error('resolver failed')
      })
    ).toEqual({ kind: 'unavailable' })

    const socksOnly = createFailClosedDynamicProxiedFetch(
      () => null,
      async () => 'SOCKS5 127.0.0.1:1080'
    )
    await expect(socksOnly('https://eu.i.posthog.com/i/v0/e/')).rejects.toThrow(
      /proxy route is unavailable/i
    )
    expect(mocks.fetchCalls).toHaveLength(0)

    const resolverFailure = createFailClosedDynamicProxiedFetch(
      () => null,
      async () => Promise.reject(new Error('resolver failed'))
    )
    await expect(resolverFailure('https://eu.i.posthog.com/i/v0/e/')).rejects.toThrow(
      /proxy route is unavailable/i
    )
    expect(mocks.fetchCalls).toHaveLength(0)
  })

  it('allows privacy-sensitive direct requests only after an explicit DIRECT fallback', async () => {
    const fetchImpl = createFailClosedDynamicProxiedFetch(
      () => null,
      async () => 'SOCKS5 127.0.0.1:1080; DIRECT'
    )

    await fetchImpl('https://eu.i.posthog.com/i/v0/e/')

    expect(mocks.fetchCalls).toHaveLength(1)
    expect(mocks.fetchCalls[0]?.init?.dispatcher).toBeUndefined()
  })
})
