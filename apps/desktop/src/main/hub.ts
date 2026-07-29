import { app, session, type Session } from 'electron'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { HubClient } from '@oh-my-huggingface/hub-api'

export interface HubHolder {
  current: HubClient
}

type ProxyResolver = (url: string) => Promise<string>

const SYSTEM_PROXY_PARTITION = 'ohmyhf-system-proxy'
let systemProxySessionPromise: Promise<Session> | null = null
const proxyAgents = new Map<string, ProxyAgent>()

/**
 * Chromium proxy resolutions use a semicolon-delimited PAC format such as
 * "PROXY 127.0.0.1:7890; DIRECT". Undici needs an absolute proxy URL.
 * SOCKS/QUIC routes are skipped because undici's ProxyAgent supports HTTP(S).
 */
export function proxyUrlFromResolution(resolution: string): string | null {
  for (const directive of resolution.split(';')) {
    const [kind = '', address = ''] = directive.trim().split(/\s+/, 2)
    const normalizedKind = kind.toUpperCase()
    if (normalizedKind === 'DIRECT') return null
    if (!address) continue
    const protocol =
      normalizedKind === 'PROXY' || normalizedKind === 'HTTP'
        ? 'http'
        : normalizedKind === 'HTTPS'
          ? 'https'
          : null
    if (!protocol) continue
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `${protocol}://${address}`
    try {
      const parsed = new URL(candidate)
      if (parsed.hostname) return parsed.toString().replace(/\/$/, '')
    } catch {
      // Ignore malformed PAC entries and continue to the next fallback.
    }
  }
  return null
}

async function systemProxySession(): Promise<Session> {
  if (!systemProxySessionPromise) {
    const ses = session.fromPartition(SYSTEM_PROXY_PARTITION, { cache: false })
    systemProxySessionPromise = ses.setProxy({ mode: 'system' }).then(() => ses)
    systemProxySessionPromise.catch(() => {
      systemProxySessionPromise = null
    })
  }
  return systemProxySessionPromise
}

async function resolveSystemProxy(url: string): Promise<string> {
  return (await systemProxySession()).resolveProxy(url)
}

/** Resolve the current OS HTTP(S) proxy for a URL; null means direct/unsupported. */
export async function resolveSystemProxyUrl(
  url: string,
  resolver: ProxyResolver = resolveSystemProxy
): Promise<string | null> {
  try {
    return proxyUrlFromResolution(await resolver(url))
  } catch {
    // Preserve direct networking if Chromium cannot initialize its proxy service.
    return null
  }
}

function proxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgents.get(proxyUrl)
  if (!agent) {
    agent = new ProxyAgent(proxyUrl)
    proxyAgents.set(proxyUrl, agent)
  }
  return agent
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/**
 * Node fetch does not inherit Chromium/macOS proxy settings. Resolve the system
 * route explicitly when no app override is configured, then keep using undici
 * so Cookie/Set-Cookie headers needed by Hub web-session mutations remain intact.
 */
export function createProxiedFetch(
  proxyUrl: string | null,
  resolver: ProxyResolver = resolveSystemProxy
): typeof fetch {
  const configuredAgent = proxyUrl ? proxyAgent(proxyUrl) : null
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const agent =
      configuredAgent ??
      (proxyUrl === null
        ? await resolveSystemProxyUrl(fetchInputUrl(input), resolver).then((url) =>
            url ? proxyAgent(url) : null
          )
        : null)
    return undiciFetch(
      input as never,
      {
        ...(init as object),
        ...(agent ? { dispatcher: agent } : {})
      } as never
    ) as unknown as Promise<Response>
  }) as typeof fetch
}

export interface HubNetworkOptions {
  endpoint: string | null
  proxyUrl: string | null
}

/** Endpoint + proxy last applied to the app HubClient — startup and settings
 * rebuilds both funnel through `createHubClient`. SDK-based integrations
 * (upload, inference playground) read this so their traffic rides the same
 * network path instead of the SDKs' global unproxied fetch. */
let networkOptions: HubNetworkOptions = { endpoint: null, proxyUrl: null }

export function getHubNetworkOptions(): HubNetworkOptions {
  return networkOptions
}

export function createHubClient(
  getAccessToken: () => string | undefined,
  getSessionCookie: () => string | undefined,
  options?: { endpoint?: string | null; proxyUrl?: string | null }
): HubClient {
  networkOptions = { endpoint: options?.endpoint ?? null, proxyUrl: options?.proxyUrl ?? null }
  return buildHubClient(getAccessToken, getSessionCookie, options)
}

/**
 * Pure client factory: builds for the given endpoint/proxy WITHOUT recording
 * them as the applied network options — for throwaway clients such as the
 * Settings → Network "Test connection" probe against draft values.
 */
export function buildHubClient(
  getAccessToken: () => string | undefined,
  getSessionCookie: () => string | undefined,
  options?: { endpoint?: string | null; proxyUrl?: string | null }
): HubClient {
  return new HubClient({
    endpoint: options?.endpoint ?? undefined,
    fetchImpl: createProxiedFetch(options?.proxyUrl ?? null),
    userAgent: `oh-my-huggingface/${app.getVersion()} (unofficial desktop client; +https://github.com/oh-my-hf/ohmyhf)`,
    cacheTtlMs: 120_000,
    // Desktop browsing bursts (grids, file trees) get smoothed out instead of tripping
    // the Hub's per-IP rate limits: few sockets, spaced starts, a couple of retries.
    maxConcurrent: 4,
    minRequestGapMs: 120,
    maxRetries: 2,
    getAccessToken,
    getSessionCookie
  })
}

/**
 * Stable HubClient-shaped proxy so DownloadManager / FollowsPoller / IPC keep working
 * after endpoint or proxy rebuilds replace `holder.current`.
 */
export function createHubProxy(holder: HubHolder): HubClient {
  return new Proxy({} as HubClient, {
    get(_target, prop, _receiver) {
      const value = Reflect.get(holder.current, prop, holder.current) as unknown
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(holder.current)
      }
      return value
    }
  })
}

export function rebuildHubClient(
  holder: HubHolder,
  getAccessToken: () => string | undefined,
  getSessionCookie: () => string | undefined,
  options: { endpoint: string | null; proxyUrl: string | null }
): void {
  holder.current = createHubClient(getAccessToken, getSessionCookie, options)
}
