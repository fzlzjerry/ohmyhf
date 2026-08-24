import type { RepoKind } from './types'

export const DEFAULT_HUB_ENDPOINT = 'https://huggingface.co'
export const PROJECT_REPOSITORY_URL = 'https://github.com/fzlzjerry/ohmyhf'
export const TELEMETRY_DOCUMENTATION_URL = `${PROJECT_REPOSITORY_URL}/blob/main/docs/telemetry.md`

const REPO_PREFIX: Record<RepoKind, string> = {
  model: '',
  dataset: 'datasets/',
  space: 'spaces/'
}

/**
 * Return the canonical Hub base URL used by both API cache keys and Web links.
 * A configured path prefix is preserved so self-hosted reverse proxies work.
 */
export function normalizeHubEndpoint(endpoint?: string | null): string {
  const raw = endpoint?.trim() || DEFAULT_HUB_ENDPOINT
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Hub endpoint must use HTTP or HTTPS')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function encodeSegments(value: string): string {
  return value
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function appendHubPath(endpoint: string | null | undefined, path: string): string {
  const base = normalizeHubEndpoint(endpoint)
  const clean = path.replace(/^\/+/, '')
  return clean === '' ? base : `${base}/${clean}`
}

export function hubRepoUrl(kind: RepoKind, repoId: string, endpoint?: string | null): string {
  return appendHubPath(endpoint, `${REPO_PREFIX[kind]}${encodeSegments(repoId)}`)
}

export function hubBlobUrl(
  kind: RepoKind,
  repoId: string,
  revision: string,
  path: string,
  endpoint?: string | null
): string {
  return `${hubRepoUrl(kind, repoId, endpoint)}/blob/${encodeURIComponent(revision)}/${encodeSegments(path)}`
}

export function hubResolveUrl(
  kind: RepoKind,
  repoId: string,
  revision: string,
  path: string,
  endpoint?: string | null
): string {
  return `${hubRepoUrl(kind, repoId, endpoint)}/resolve/${encodeURIComponent(revision)}/${encodeSegments(path)}`
}

export function hubUserUrl(username: string, endpoint?: string | null): string {
  return appendHubPath(endpoint, encodeURIComponent(username))
}

export function hubPaperUrl(paperId: string, endpoint?: string | null): string {
  return appendHubPath(endpoint, `papers/${encodeURIComponent(paperId)}`)
}

export function hubCollectionUrl(slug: string, endpoint?: string | null): string {
  return appendHubPath(endpoint, `collections/${encodeSegments(slug)}`)
}

export function hubSettingsUrl(path = '', endpoint?: string | null): string {
  return appendHubPath(endpoint, `settings${path === '' ? '' : `/${encodeSegments(path)}`}`)
}

/** Resolve a Hub-origin relative URL without rewriting genuine external URLs. */
export function hubRelativeUrl(value: string, endpoint?: string | null): string {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('//')) {
    return `${new URL(normalizeHubEndpoint(endpoint)).protocol}${trimmed}`
  }
  const base = normalizeHubEndpoint(endpoint)
  if (trimmed.startsWith('?') || trimmed.startsWith('#')) return `${base}${trimmed}`
  return appendHubPath(endpoint, trimmed)
}

/**
 * External-navigation policy shared by IPC and native window handlers. HTTPS
 * remains generally allowed; plaintext HTTP is limited to the configured Hub
 * origin and its optional reverse-proxy path prefix.
 */
export function isAllowedExternalUrl(value: string, hubEndpoint?: string | null): boolean {
  try {
    const target = new URL(value)
    if (target.username || target.password) return false
    if (target.protocol === 'https:') return true
    if (target.protocol !== 'http:' || !hubEndpoint) return false

    const endpoint = new URL(normalizeHubEndpoint(hubEndpoint))
    if (endpoint.protocol !== 'http:' || endpoint.origin !== target.origin) return false
    const basePath = endpoint.pathname.replace(/\/+$/, '')
    return (
      basePath === '' || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)
    )
  } catch {
    return false
  }
}
