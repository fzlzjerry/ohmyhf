import type { RepoKind } from '@oh-my-huggingface/shared'
import type { HubClient } from '@oh-my-huggingface/hub-api'

type RevisionHub = Pick<HubClient, 'getRepoRefs' | 'resolveRevision'>

/**
 * Resolve the user-visible reference immediately before a side effect. A
 * renderer-supplied commit is treated as an integrity claim and compared with
 * that fresh resolution; it never replaces the symbolic-ref lookup.
 */
export async function resolveActionRevision(
  hub: RevisionHub,
  kind: RepoKind,
  repoId: string,
  requestedRevision: string | undefined,
  claimedCommit: string | undefined,
  mismatchError: string
): Promise<{ requestedRevision: string; resolvedCommit: string }> {
  let requested = requestedRevision
  if (!requested) {
    if (claimedCommit) {
      // Exact-only legacy callers retain the immutable commit as their display
      // identity instead of being mislabeled as a guessed default branch.
      requested = claimedCommit
    } else {
      const refs = await hub.getRepoRefs(kind, repoId)
      requested = refs.defaultBranch
      if (!requested) throw new Error('revision.defaultUnavailable')
    }
  }

  const selection = await hub.resolveRevision(kind, repoId, requested)
  if (claimedCommit && selection.resolvedCommit !== claimedCommit.toLowerCase()) {
    throw new Error(mismatchError)
  }
  return { requestedRevision: requested, resolvedCommit: selection.resolvedCommit }
}
