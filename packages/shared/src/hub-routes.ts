/**
 * Map a Hub website URL, mirror URL, or `ohmyhf://` deep link to an in-app
 * route. Used by the protocol handler, second-instance argv, and the command
 * palette so a pasted huggingface.co link opens the matching page.
 */
import { isValidRepoId } from './schemas'
import { DEFAULT_HUB_ENDPOINT, normalizeHubEndpoint } from './urls'

export const APP_PROTOCOL = 'ohmyhf'

/** First path segments that are Hub chrome, not a user or model id. */
const RESERVED_SEGMENTS = new Set([
  'admin',
  'api',
  'blog',
  'changelog',
  'collections',
  'connect',
  'datasets',
  'datasets-server',
  'docs',
  'enterprise',
  'huggingface',
  'join',
  'learn',
  'login',
  'logout',
  'models',
  'new',
  'notifications',
  'oauth',
  'organizations',
  'papers',
  'posts',
  'pricing',
  'search',
  'settings',
  'spaces',
  'spaces-server',
  'support',
  'tasks',
  'watch'
])

/** Trailing Hub page segments that are not part of a repo id. */
const REPO_TRAILING = new Set([
  'blob',
  'commit',
  'commits',
  'discussions',
  'resolve',
  'settings',
  'tree'
])

const HUB_HOSTS = new Set(['huggingface.co', 'hf.co', 'www.huggingface.co', 'hf-mirror.com'])

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

function decodeSegments(path: string): string[] {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
}

function repoRoute(
  kind: 'model' | 'dataset' | 'space',
  owner: string,
  name: string
): string | null {
  const repoId = `${owner}/${name}`
  if (!isValidRepoId(repoId)) return null
  const prefix = kind === 'model' ? 'models' : kind === 'dataset' ? 'datasets' : 'spaces'
  return `/${prefix}/${repoId}`
}

function fromPathSegments(segments: string[]): string | null {
  if (segments.length === 0) return '/'

  const head = segments[0]
  if (head === 'models' && segments[1] && segments[2]) {
    return repoRoute('model', segments[1], segments[2])
  }
  if (head === 'datasets' && segments[1] && segments[2]) {
    return repoRoute('dataset', segments[1], segments[2])
  }
  if (head === 'spaces' && segments[1] && segments[2]) {
    return repoRoute('space', segments[1], segments[2])
  }
  if (head === 'papers' && segments[1]) {
    return `/papers/${segments[1]}`
  }
  if (head === 'collections' && segments[1] && segments[2]) {
    return `/collections/${segments[1]}/${segments[2]}`
  }
  if (head === 'posts' && segments[1] && segments[2]) {
    return `/posts/${segments[1]}/${segments[2]}`
  }
  if (head && RESERVED_SEGMENTS.has(head)) return null

  if (segments.length === 1 && /^[\w.-]+$/.test(segments[0]!) && !/^\.+$/.test(segments[0]!)) {
    return `/users/${segments[0]}`
  }

  if (segments[0] && segments[1] && !REPO_TRAILING.has(segments[1])) {
    const trailing = segments[2]
    if (!trailing || REPO_TRAILING.has(trailing)) {
      return repoRoute('model', segments[0], segments[1])
    }
  }
  return null
}

function hostsMatch(hostname: string, endpoint: string | null | undefined): boolean {
  const host = hostname.toLowerCase()
  if (HUB_HOSTS.has(host)) return true
  if (!endpoint) return false
  try {
    return new URL(normalizeHubEndpoint(endpoint)).hostname.toLowerCase() === host
  } catch {
    return false
  }
}

function fromHttpUrl(value: string, hubEndpoint?: string | null): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!hostsMatch(url.hostname, hubEndpoint)) return null
  let pathname = url.pathname
  if (hubEndpoint) {
    try {
      const base = new URL(normalizeHubEndpoint(hubEndpoint))
      if (base.pathname && base.pathname !== '/' && pathname.startsWith(base.pathname)) {
        pathname = pathname.slice(base.pathname.length) || '/'
      }
    } catch {
      /* use pathname as-is */
    }
  }
  return fromPathSegments(decodeSegments(pathname))
}

function fromAppProtocol(value: string, hubEndpoint?: string | null): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_PROTOCOL}:`) return null
  const nested = url.searchParams.get('url')
  if (nested) return parseHubResource(nested, hubEndpoint)
  const host = url.hostname
  const path = url.pathname
  const combined = [host, path].filter((part) => part && part !== '/').join('/')
  const segments = decodeSegments(combined)
  if (segments[0] === 'open' && url.searchParams.get('url')) {
    return parseHubResource(url.searchParams.get('url')!, hubEndpoint)
  }
  const asAppPath = `/${segments.join('/')}`
  if (
    asAppPath.startsWith('/models/') ||
    asAppPath.startsWith('/datasets/') ||
    asAppPath.startsWith('/spaces/') ||
    asAppPath.startsWith('/papers/') ||
    asAppPath.startsWith('/collections/') ||
    asAppPath.startsWith('/posts/') ||
    asAppPath.startsWith('/users/') ||
    asAppPath.startsWith('/favorites') ||
    asAppPath.startsWith('/history') ||
    asAppPath.startsWith('/downloads') ||
    asAppPath.startsWith('/cache') ||
    asAppPath.startsWith('/inbox') ||
    asAppPath.startsWith('/compare') ||
    asAppPath.startsWith('/upload') ||
    asAppPath.startsWith('/search') ||
    asAppPath.startsWith('/my-repos') ||
    asAppPath === '/'
  ) {
    return stripTrailingSlash(asAppPath)
  }
  return fromPathSegments(segments)
}

/**
 * Parse a Hub URL, `ohmyhf://` link, or bare `owner/name` into an in-app route.
 * Returns null when the input is not a Hub resource we can open.
 */
export function parseHubResource(input: string, hubEndpoint?: string | null): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith(`${APP_PROTOCOL}:`)) return fromAppProtocol(trimmed, hubEndpoint)
  if (/^https?:\/\//i.test(trimmed)) return fromHttpUrl(trimmed, hubEndpoint)
  // Bare "huggingface.co/owner/name" pasted without a scheme.
  if (/^(?:www\.)?(?:huggingface\.co|hf\.co|hf-mirror\.com)\//i.test(trimmed)) {
    return fromHttpUrl(`https://${trimmed}`, hubEndpoint)
  }
  const segments = decodeSegments(trimmed.replace(/^\/+/, ''))
  if (segments.length === 2 && isValidRepoId(`${segments[0]}/${segments[1]}`)) {
    return `/models/${segments[0]}/${segments[1]}`
  }
  return fromPathSegments(segments)
}

function isExplicitLaunchUrl(arg: string): boolean {
  return (
    arg.startsWith(`${APP_PROTOCOL}:`) ||
    /^https?:\/\//i.test(arg) ||
    /^(?:www\.)?(?:huggingface\.co|hf\.co|hf-mirror\.com)\//i.test(arg)
  )
}

/**
 * Pull the first `ohmyhf:` / Hub URL out of a process.argv-style list.
 * Single-segment tokens (argv0, `electron`) are ignored — they collide with
 * user slugs if we run them through `parseHubResource`.
 */
export function routeFromLaunchArgs(
  argv: readonly string[],
  hubEndpoint?: string | null
): string | null {
  const candidates = argv.filter((arg) => Boolean(arg) && !arg.startsWith('-'))
  for (const arg of candidates) {
    if (!isExplicitLaunchUrl(arg)) continue
    const route = parseHubResource(arg, hubEndpoint)
    if (route) return route
  }
  for (const arg of candidates) {
    if (isExplicitLaunchUrl(arg) || !arg.includes('/')) continue
    const route = parseHubResource(arg, hubEndpoint)
    if (route) return route
  }
  return null
}

export function hubDeepLink(route: string): string {
  const path = route.startsWith('/') ? route : `/${route}`
  return `${APP_PROTOCOL}://${path.replace(/^\/+/, '')}`
}

export const DEFAULT_HUB_HOST = new URL(DEFAULT_HUB_ENDPOINT).hostname
