/** Small-file commits (README / config) through the Hub JS SDK. */
import { DEFAULT_ENDPOINT } from '@oh-my-huggingface/hub-api'
import type { RepoCommitResult, RepoKind } from '@oh-my-huggingface/shared'
import { createProxiedFetch, getHubNetworkOptions } from '../hub'

const REPO_TYPE: Record<RepoKind, 'model' | 'dataset' | 'space'> = {
  model: 'model',
  dataset: 'dataset',
  space: 'space'
}

export interface CommitFilesInput {
  kind: RepoKind
  repoId: string
  files: Array<{ path: string; content: string }>
  title: string
  description?: string
  branch?: string
  createPr?: boolean
}

function trimError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).trim().slice(0, 200)
}

export async function commitRepoFiles(
  input: CommitFilesInput,
  accessToken: string | undefined
): Promise<RepoCommitResult> {
  if (!accessToken) return { ok: false, error: '', messageKey: 'edit.needWrite' }

  const { commit, createBranch, HubApiError } = await import('@huggingface/hub')
  const { endpoint, proxyUrl } = getHubNetworkOptions()
  const hubUrl = (endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
  const fetchImpl = createProxiedFetch(proxyUrl)
  const repo = { type: REPO_TYPE[input.kind], name: input.repoId }
  const operations = input.files.map((file) => ({
    operation: 'addOrUpdate' as const,
    path: file.path,
    content: new Blob([file.content], { type: 'text/plain;charset=utf-8' })
  }))

  const branch =
    input.createPr === true
      ? input.branch && input.branch !== 'main'
        ? input.branch
        : `omhf/edit-${Date.now().toString(36)}`
      : input.branch

  try {
    if (input.createPr === true && branch) {
      try {
        await createBranch({
          repo,
          branch,
          accessToken,
          hubUrl,
          fetch: fetchImpl
        })
      } catch (err) {
        if (!(err instanceof HubApiError && err.statusCode === 409)) throw err
      }
    }

    // `isPullRequest` is supported by the Hub SDK when present; a missing
    // field just commits to `branch` (or the repo default).
    await commit({
      repo,
      operations,
      title: input.title,
      description: input.description,
      branch,
      accessToken,
      hubUrl,
      fetch: fetchImpl,
      ...(input.createPr === true ? { isPullRequest: true } : {})
    } as Parameters<typeof commit>[0])

    const compareUrl =
      input.createPr === true && branch
        ? `${hubUrl}/${input.kind === 'dataset' ? 'datasets/' : input.kind === 'space' ? 'spaces/' : ''}${input.repoId}/compare/main...${encodeURIComponent(branch)}`
        : undefined
    return { ok: true, branch: branch ?? 'main', compareUrl }
  } catch (err) {
    if (err instanceof HubApiError && err.statusCode === 403) {
      return { ok: false, error: '', messageKey: 'edit.needWrite' }
    }
    return { ok: false, error: trimError(err), messageKey: 'edit.commitFailed' }
  }
}
