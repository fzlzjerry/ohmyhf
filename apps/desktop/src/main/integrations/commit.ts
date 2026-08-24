/** Small-file commits (README / config) through the Hub JS SDK. */
import { DEFAULT_ENDPOINT } from '@oh-my-huggingface/hub-api'
import type { RepoCommitResult, RepoKind } from '@oh-my-huggingface/shared'
import { createProxiedFetch, getHubNetworkOptions } from '../hub'

const REPO_TYPE: Record<RepoKind, 'model' | 'dataset' | 'space'> = {
  model: 'model',
  dataset: 'dataset',
  space: 'space'
}

const API_PATH: Record<RepoKind, 'models' | 'datasets' | 'spaces'> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces'
}

export interface CommitFilesInput {
  kind: RepoKind
  repoId: string
  files: Array<{ path: string; content: string }>
  title: string
  description?: string
  branch?: string
  startingPoint: string
  createPr?: boolean
}

function trimError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).trim().slice(0, 200)
}

function repoWebPrefix(kind: RepoKind): string {
  return kind === 'dataset' ? 'datasets/' : kind === 'space' ? 'spaces/' : ''
}

/** Hub default branch for compare URLs and the "committed to" toast. */
async function resolveDefaultBranch(
  kind: RepoKind,
  repoId: string,
  hubUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<string | undefined> {
  try {
    const headers = { Authorization: `Bearer ${accessToken}` }
    const apiBase = `${hubUrl}/api/${API_PATH[kind]}/${repoId}`
    const infoRes = await fetchImpl(apiBase, { headers })
    if (!infoRes.ok) return undefined
    const info = (await infoRes.json()) as { sha?: string }
    const refsRes = await fetchImpl(`${apiBase}/refs`, { headers })
    if (!refsRes.ok) return undefined
    const refs = (await refsRes.json()) as {
      branches?: Array<{ name?: string; targetCommit?: string }>
    }
    const sha = info.sha?.toLowerCase()
    const branches = refs.branches ?? []
    const matched = sha
      ? branches.find((branch) => branch.targetCommit?.toLowerCase() === sha && branch.name)
      : undefined
    return matched?.name
  } catch {
    return undefined
  }
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

  const branch = input.createPr === true ? `omhf/edit-${Date.now().toString(36)}` : input.branch
  if (!branch) {
    return {
      ok: false,
      error: 'Direct commits require a branch',
      messageKey: 'edit.commitFailed'
    }
  }

  try {
    if (input.createPr === true && branch) {
      try {
        await createBranch({
          repo,
          branch,
          revision: input.startingPoint,
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
    const committed = (await commit({
      repo,
      operations,
      title: input.title,
      description: input.description,
      branch,
      accessToken,
      hubUrl,
      fetch: fetchImpl,
      ...(input.createPr === true ? { isPullRequest: true } : {})
    } as Parameters<typeof commit>[0])) as { pullRequestUrl?: string }

    const defaultBranch =
      input.createPr === true && !committed.pullRequestUrl
        ? await resolveDefaultBranch(input.kind, input.repoId, hubUrl, accessToken, fetchImpl)
        : undefined
    const compareUrl =
      input.createPr === true && branch
        ? (committed.pullRequestUrl ??
          (defaultBranch
            ? `${hubUrl}/${repoWebPrefix(input.kind)}${input.repoId}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branch)}`
            : undefined))
        : undefined
    return { ok: true, branch, compareUrl }
  } catch (err) {
    if (err instanceof HubApiError && err.statusCode === 403) {
      return { ok: false, error: '', messageKey: 'edit.needWrite' }
    }
    return { ok: false, error: trimError(err), messageKey: 'edit.commitFailed' }
  }
}
