import { createContext, useContext } from 'react'
import type { RepoRevisionSelection } from '@oh-my-huggingface/shared'

const RevisionContext = createContext<RepoRevisionSelection | null>(null)

export function RepoRevisionProvider({
  value,
  children
}: {
  value: RepoRevisionSelection
  children: React.ReactNode
}): React.JSX.Element {
  return <RevisionContext.Provider value={value}>{children}</RevisionContext.Provider>
}

export function useRepoRevision(): RepoRevisionSelection | null {
  return useContext(RevisionContext)
}

/** File previews are revision-sensitive and must never guess a branch. */
export function useResolvedRepoCommit(): string {
  const revision = useContext(RevisionContext)
  if (!revision) throw new Error('Repo revision context is required')
  return revision.resolvedCommit
}
