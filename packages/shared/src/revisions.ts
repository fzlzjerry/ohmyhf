import type { RepoRef, RepoRefs, RepoRevisionSelection } from './types'

export const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i
export const PULL_REQUEST_REF_RE = /^refs\/pr\/(\d+)$/

export function normalizeResolvedCommit(value: string): string | null {
  const commit = value.trim().toLowerCase()
  return FULL_COMMIT_RE.test(commit) ? commit : null
}

export function classifyRevision(
  requested: string,
  resolvedCommit: string,
  refs?: RepoRefs
): RepoRevisionSelection {
  const requestedTrimmed = requested.trim() || refs?.defaultBranch
  if (!requestedTrimmed) throw new Error('revision.defaultUnavailable')
  const commit = normalizeResolvedCommit(resolvedCommit)
  if (!commit) throw new Error('revision.invalidCommit')

  const byRequested = (items: RepoRef[]): RepoRef | undefined =>
    items.find(
      (item) =>
        item.name === requestedTrimmed ||
        item.ref === requestedTrimmed ||
        item.targetCommit === requestedTrimmed.toLowerCase()
    )

  const branch = refs ? byRequested(refs.branches) : undefined
  if (branch) {
    return {
      requested: branch.name,
      resolvedCommit: commit,
      type: 'branch',
      isDefault: branch.isDefault === true || branch.name === refs?.defaultBranch,
      readOnly: false
    }
  }
  const tag = refs ? byRequested(refs.tags) : undefined
  if (tag) {
    return {
      requested: tag.name,
      resolvedCommit: commit,
      type: 'tag',
      isDefault: false,
      readOnly: true
    }
  }
  const pullRequest = refs ? byRequested(refs.pullRequests) : undefined
  if (pullRequest || PULL_REQUEST_REF_RE.test(requestedTrimmed)) {
    return {
      requested: pullRequest?.ref ?? requestedTrimmed,
      resolvedCommit: commit,
      type: 'pull-request',
      isDefault: false,
      readOnly: true
    }
  }
  if (FULL_COMMIT_RE.test(requestedTrimmed)) {
    return {
      requested: requestedTrimmed.toLowerCase(),
      resolvedCommit: commit,
      type: 'commit',
      isDefault: false,
      readOnly: true
    }
  }

  // An unknown symbolic ref is treated as a branch only after the Hub has
  // resolved it. This preserves compatibility with mirrors that omit refs.
  return {
    requested: requestedTrimmed,
    resolvedCommit: commit,
    type: 'branch',
    isDefault: refs?.defaultBranch !== undefined && requestedTrimmed === refs.defaultBranch,
    readOnly: false
  }
}

export function isSafeRepoRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  )
}
