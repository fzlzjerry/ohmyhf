import { hubRepoUrl, type RepoKind, type RepoOpenTarget } from '@oh-my-huggingface/shared'
import { openExternal } from '@/lib/ipc'

const KIND_PATH: Record<RepoKind, string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces'
}

export function repoAppPath(kind: RepoKind, repoId: string, revision?: string): string {
  const base = `/${KIND_PATH[kind]}/${repoId}`
  return revision ? `${base}?revision=${encodeURIComponent(revision)}` : base
}

export function repoHubUrl(
  kind: RepoKind,
  repoId: string,
  hubEndpoint: string | null = null
): string {
  return hubRepoUrl(kind, repoId, hubEndpoint)
}

/** Open a repo in-app or in the system browser per settings. */
export function openRepo(
  kind: RepoKind,
  repoId: string,
  target: RepoOpenTarget,
  navigate: (path: string) => void,
  hubEndpoint: string | null = null,
  revision?: string
): void {
  if (target === 'browser') {
    const base = repoHubUrl(kind, repoId, hubEndpoint)
    openExternal(revision ? `${base}/tree/${encodeURIComponent(revision)}` : base)
    return
  }
  void navigate(repoAppPath(kind, repoId, revision))
}
