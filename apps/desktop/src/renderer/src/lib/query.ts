import { QueryClient } from '@tanstack/react-query'
import type { RepoKind } from '@oh-my-huggingface/shared'

export const APP_UPDATE_QUERY_KEY = ['app-update'] as const

type RepoQueryFamily = 'repo' | 'readme' | 'repo-refs' | 'repo-commits' | 'repo-revision'

/** Endpoint/repository prefix followed by the requested ref and, for content, exact commit. */
export function repoQueryKey(
  family: RepoQueryFamily,
  endpoint: string,
  kind: RepoKind,
  repoId: string,
  ...revision: readonly (string | undefined)[]
) {
  return [family, endpoint, kind, repoId, ...revision] as const
}

/** Matches revision-aware repository data, never local cache/download state. */
export function isRepoQuery(
  queryKey: readonly unknown[],
  endpoint: string,
  kind: RepoKind,
  repoId: string
): boolean {
  return (
    isHubRemoteQuery(queryKey) &&
    queryKey[1] === endpoint &&
    queryKey[2] === kind &&
    queryKey[3] === repoId
  )
}

/** Query families whose payload comes from the currently configured Hub endpoint. */
const HUB_REMOTE_QUERY_ROOTS = new Set([
  'access-requests',
  'arrowPreview',
  'collection',
  'collections',
  'compare-model-picker',
  'dataset-leaderboard',
  'dataset-leaderboard-availability',
  'datasetRows',
  'datasetSampleRows',
  'datasetSplits',
  'discussion',
  'discussionDiff',
  'discussions',
  'fileText',
  'ggufHeader',
  'globalSearch',
  'home',
  'hub-billing-usage',
  'hub-following',
  'hub-notifications',
  'hub-profile',
  'hub-watched',
  'inference-available',
  'my-repos',
  'model-eval-results',
  'local-runtime-file-metadata',
  'local-runtime-gguf-header',
  'onnxPreview',
  'org-members',
  'paper',
  'paper-comments',
  'paper-document',
  'paper-related',
  'papers',
  'parquetMeta',
  'parquetRows',
  'post',
  'post-can-create',
  'post-comments',
  'readme',
  'repo',
  'repo-access',
  'repo-commits',
  'repo-refs',
  'repo-revision',
  'safetensors',
  'search',
  'security-report',
  'searchPage',
  'space-logs',
  'space-secrets',
  'space-variables',
  'tree',
  'user-likes',
  'user-overview',
  'user-repos',
  'user-search'
])

export function isHubRemoteQuery(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0]
  return typeof root === 'string' && HUB_REMOTE_QUERY_ROOTS.has(root)
}

/** Clear remote payloads synchronously and cancel old reads before refetching active observers. */
export function resetHubRemoteQueries(client: QueryClient): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }): boolean =>
    isHubRemoteQuery(query.queryKey)
  // Reset before removing: even disabled observers must forget their previous
  // placeholder data, and reset cancels IPC results that can no longer abort.
  const refreshing = client.resetQueries({ predicate })
  client.removeQueries({
    predicate: (query) => predicate(query) && query.getObserversCount() === 0
  })
  return refreshing
}

/**
 * Stale-while-revalidate everywhere: cached pages render instantly while a
 * background refetch runs. The main process adds its own response cache on top.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false
    }
  }
})
