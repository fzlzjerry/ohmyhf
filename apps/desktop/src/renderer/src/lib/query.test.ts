import { keepPreviousData, QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { isHubRemoteQuery, isRepoQuery, repoQueryKey, resetHubRemoteQueries } from './query'

describe('isHubRemoteQuery', () => {
  it('identifies Hub-backed query families', () => {
    expect(isHubRemoteQuery(['repo', 'model', 'org/name'])).toBe(true)
    expect(isHubRemoteQuery(['hub-notifications', 0])).toBe(true)
    expect(isHubRemoteQuery(['fileText', 'model', 'org/name', 'README.md'])).toBe(true)
  })

  it('preserves local and application query families', () => {
    expect(isHubRemoteQuery(['downloads'])).toBe(false)
    expect(isHubRemoteQuery(['cache'])).toBe(false)
    expect(isHubRemoteQuery(['favorites'])).toBe(false)
    expect(isHubRemoteQuery(['history'])).toBe(false)
    expect(isHubRemoteQuery(['app-update'])).toBe(false)
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('repository cache scope', () => {
  it('drops every exact revision of one repository without touching other endpoints or local data', () => {
    const client = new QueryClient()
    const endpoint = 'https://huggingface.co'
    const commit = 'a'.repeat(40)
    const affected = [
      repoQueryKey('repo', endpoint, 'model', 'org/repo'),
      repoQueryKey('repo', endpoint, 'model', 'org/repo', 'main', commit),
      repoQueryKey('readme', endpoint, 'model', 'org/repo', 'main', commit),
      repoQueryKey('repo-revision', endpoint, 'model', 'org/repo', 'main'),
      ['security-report', endpoint, 'model', 'org/repo', 'main', commit],
      ['fileText', endpoint, 'model', 'org/repo', 'main', commit, 'README.md']
    ]
    const retained = [
      repoQueryKey('readme', 'https://mirror.example', 'model', 'org/repo', 'main', commit),
      repoQueryKey('readme', endpoint, 'dataset', 'org/repo', 'main', commit),
      repoQueryKey('readme', endpoint, 'model', 'org/other', 'main', commit),
      ['cache-snapshot', 'model', 'org/repo', commit],
      ['downloads']
    ]
    for (const key of [...affected, ...retained]) client.setQueryData(key, 'retained data')
    client.removeQueries({
      predicate: (query) => isRepoQuery(query.queryKey, endpoint, 'model', 'org/repo')
    })
    for (const key of affected) expect(client.getQueryData(key)).toBeUndefined()
    for (const key of retained) expect(client.getQueryData(key)).toBe('retained data')
    client.clear()
  })
})

describe('remote account reset', () => {
  it('clears old account content and disabled placeholders before refetch, ignoring uncancelable late IPC results', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } }
    })
    const oldRead = deferred<string>()
    const newRead = deferred<string>()
    const key = repoQueryKey(
      'readme',
      'https://huggingface.co',
      'model',
      'private/repo',
      'main',
      'a'.repeat(40)
    )
    const disabledKey = ['hub-notifications', 0, 'https://huggingface.co']
    client.setQueryData(key, 'old-account README')
    client.setQueryData(disabledKey, 'old-account notifications')
    client.setQueryData(['downloads'], ['local download'])
    client.setQueryData(['cache'], { size: 42 })
    let requests = 0
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => (++requests === 1 ? oldRead.promise : newRead.promise),
      placeholderData: keepPreviousData
    })
    const disabled = new QueryObserver(client, {
      queryKey: disabledKey,
      queryFn: () => Promise.resolve('unused'),
      enabled: false,
      placeholderData: keepPreviousData
    })
    const seen: unknown[] = []
    const unsubscribe = observer.subscribe((result) => seen.push(result.data))
    const unsubscribeDisabled = disabled.subscribe(() => {})
    try {
      seen.length = 0
      const reset = resetHubRemoteQueries(client)
      expect(observer.getCurrentResult().data).toBeUndefined()
      expect(disabled.getCurrentResult().data).toBeUndefined()
      expect(client.getQueryData(key)).toBeUndefined()
      oldRead.resolve('late old-account private response')
      await Promise.resolve()
      await Promise.resolve()
      expect(observer.getCurrentResult().data).toBeUndefined()
      expect(seen).not.toContain('old-account README')
      expect(seen).not.toContain('late old-account private response')
      newRead.resolve('new-account README')
      await reset
      expect(observer.getCurrentResult().data).toBe('new-account README')
      expect(client.getQueryData(['downloads'])).toEqual(['local download'])
      expect(client.getQueryData(['cache'])).toEqual({ size: 42 })
    } finally {
      unsubscribe()
      unsubscribeDisabled()
      client.clear()
    }
  })

  it('discards inactive repository, security, preview, social and account families while preserving local state', async () => {
    const client = new QueryClient()
    const remoteRoots = [
      'repo',
      'readme',
      'tree',
      'fileText',
      'repo-refs',
      'repo-commits',
      'repo-revision',
      'security-report',
      'model-eval-results',
      'compare-model-picker',
      'dataset-leaderboard',
      'dataset-leaderboard-availability',
      'local-runtime-file-metadata',
      'local-runtime-gguf-header',
      'paper-comments',
      'paper-document',
      'paper-related',
      'hub-profile',
      'my-repos',
      'hub-notifications',
      'access-requests',
      'space-secrets',
      'space-variables',
      'hub-billing-usage'
    ]
    const localRoots = [
      'downloads',
      'cache',
      'cache-snapshot',
      'cache-pins',
      'favorites',
      'history',
      'local-runtime-state',
      'integration-tasks'
    ]
    for (const root of remoteRoots) client.setQueryData([root], `private:${root}`)
    for (const root of localRoots) client.setQueryData([root], `local:${root}`)
    await resetHubRemoteQueries(client)
    for (const root of remoteRoots) expect(client.getQueryData([root])).toBeUndefined()
    for (const root of localRoots) expect(client.getQueryData([root])).toBe(`local:${root}`)
    client.clear()
  })
})
