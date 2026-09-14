// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Link,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoCommitResult, RepoRefs, RepoRevisionSelection } from '@oh-my-huggingface/shared'
import type * as DownloadCapacity from '@/hooks/use-download-capacity'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  authorize: vi.fn(),
  t: (key: string) => key
}))

vi.mock('@/lib/ipc', () => ({ invoke: mocks.invoke, openExternal: vi.fn() }))
vi.mock('@/lib/theme', () => ({ setTheme: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }))
vi.mock('@/hooks/use-security-gate', () => ({
  useSecurityGate: () => ({ authorize: mocks.authorize, dialog: null })
}))
vi.mock('@/hooks/use-download-capacity', async (importOriginal) => ({
  ...(await importOriginal<typeof DownloadCapacity>()),
  useDownloadCapacity: () => ({ data: undefined })
}))
vi.mock('./DownloadIntentPanel', () => ({ DownloadIntentPanel: () => null }))
vi.mock('@/components/community/LikeButton', () => ({ LikeButton: () => null }))
vi.mock('./MarkdownView', () => ({
  MarkdownView: ({ markdown }: { markdown: string }) => <article>{markdown}</article>,
  repoFileUrl: vi.fn()
}))
vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="README editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}))

import { DEFAULT_SETTINGS } from '@oh-my-huggingface/shared'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useToasts } from '@/components/ui/toaster'
import { repoQueryKey } from '@/lib/query'
import { useAppStore } from '@/stores/app'
import { RepoDetail } from './RepoDetail'

const ENDPOINT = 'https://huggingface.co'
const BEFORE = 'a'.repeat(40)
const AFTER = 'b'.repeat(40)
const BETA = 'c'.repeat(40)
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

let alphaHead = BEFORE
let save: Deferred<RepoCommitResult> | undefined
let betaRefs: Deferred<RepoRefs> | undefined
let refreshedSelection: Deferred<RepoRevisionSelection> | undefined
let client: QueryClient

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function refsFor(repoId: string): RepoRefs {
  const branch = repoId === 'org/beta' ? 'develop' : 'main'
  const commit = repoId === 'org/beta' ? BETA : alphaHead
  return {
    defaultBranch: branch,
    branches: [
      {
        name: branch,
        ref: `refs/heads/${branch}`,
        targetCommit: commit,
        type: 'branch',
        isDefault: true
      }
    ],
    tags: [{ name: 'v1.0', ref: 'refs/tags/v1.0', targetCommit: BEFORE, type: 'tag' }],
    pullRequests: [{ name: '7', ref: 'refs/pr/7', targetCommit: BEFORE, type: 'pull-request' }]
  }
}

function selection(repoId: string, requested: string): RepoRevisionSelection {
  const branch = repoId === 'org/beta' ? 'develop' : 'main'
  if (requested === branch)
    return {
      requested,
      resolvedCommit: repoId === 'org/beta' ? BETA : alphaHead,
      type: 'branch',
      readOnly: false,
      isDefault: true
    }
  if (requested === 'v1.0' || requested === 'refs/pr/7')
    return {
      requested,
      resolvedCommit: BEFORE,
      type: requested === 'v1.0' ? 'tag' : 'pull-request',
      readOnly: true,
      isDefault: false
    }
  throw new Error('revision.notFound')
}

function RepositoryRoute(): React.JSX.Element {
  const { owner, name } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output aria-label="location">
        {location.pathname}
        {location.search}
      </output>
      <nav>
        <Link to="/models/org/alpha">Alpha</Link>
        <Link to="/models/org/beta">Beta</Link>
        <Link to={`/models/org/alpha?revision=${BEFORE}`}>Exact commit</Link>
        <Link to="/models/org/alpha?revision=v1.0">Tag</Link>
        <Link to="/models/org/alpha?revision=refs%2Fpr%2F7">Pull request</Link>
        <button onClick={() => void navigate(-1)}>Back</button>
      </nav>
      <RepoDetail kind="model" repoId={`${owner}/${name}`} />
    </>
  )
}

function openRepository(entry = '/models/org/alpha'): void {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <TooltipProvider>
          <Routes>
            <Route path="/models/:owner/:name" element={<RepositoryRoute />} />
          </Routes>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

async function startSave(createPr = false): Promise<void> {
  await screen.findByText('README alpha before')
  fireEvent.click(screen.getByRole('button', { name: 'detail:edit.action' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'README editor' }), {
    target: { value: 'README alpha after' }
  })
  if (createPr) fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'detail:edit.commit' }))
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      'hub:commitFiles',
      expect.objectContaining({ startingPoint: BEFORE, createPr })
    )
  )
}

beforeEach(() => {
  alphaHead = BEFORE
  save = undefined
  betaRefs = undefined
  refreshedSelection = undefined
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false }
    }
  })
  useAppStore.setState({
    settings: DEFAULT_SETTINGS,
    appInfo: null,
    auth: { status: 'signedIn', user: { name: 'me', orgs: [] } }
  })
  useToasts.setState({ toasts: [] })
  mocks.authorize.mockReset().mockResolvedValue('approved-grant')
  mocks.invoke
    .mockReset()
    .mockImplementation(async (channel: string, args?: Record<string, unknown>) => {
      const repoId = args?.repoId as string
      const revision = args?.revision as string
      switch (channel) {
        case 'hub:repoRefs':
          return repoId === 'org/beta' && betaRefs ? betaRefs.promise : refsFor(repoId)
        case 'hub:repoCommits':
          return { items: [{ id: BEFORE, authors: [], title: 'Original commit' }] }
        case 'hub:resolveRevision':
          if (
            repoId === 'org/alpha' &&
            revision === 'main' &&
            alphaHead === AFTER &&
            refreshedSelection
          )
            return refreshedSelection.promise
          return selection(repoId, revision)
        case 'hub:repoDetail':
          return {
            id: repoId,
            kind: 'model',
            name: repoId.split('/')[1],
            author: 'org',
            likes: 0,
            downloads: 0,
            private: false,
            gated: false,
            tags: [],
            siblings: [],
            sha: revision
          }
        case 'hub:readme':
          return repoId === 'org/beta'
            ? 'README beta'
            : revision === AFTER
              ? 'README alpha after'
              : 'README alpha before'
        case 'hub:inferenceAvailable':
          return false
        case 'hub:commitFiles':
          if (save) return save.promise
          if (!args?.createPr) alphaHead = AFTER
          return {
            ok: true,
            branch: args?.createPr ? 'omhf/edit-pr-base' : 'main',
            compareUrl: args?.createPr
              ? 'https://huggingface.co/org/alpha/discussions/8'
              : undefined
          }
        case 'security:preflight':
          return {
            decision: 'allow',
            reasons: [],
            report: { fingerprint: 'safe', checkedAt: '2026-09-14T00:00:00Z' }
          }
        case 'cache:snapshot':
          return null
        case 'favorites:list':
        case 'cache:listPins':
        case 'history:add':
        case 'downloads:start':
          return []
        default:
          throw new Error(`Unexpected IPC: ${channel}`)
      }
    })
})

afterEach(() => {
  cleanup()
  client.clear()
  useToasts.setState({ toasts: [] })
})

describe('repository navigation and saved revisions', () => {
  it('never writes settled Alpha/main refs into Beta/develop and keeps native back history', async () => {
    betaRefs = deferred<RepoRefs>()
    openRepository()
    await screen.findByText('README alpha before')
    fireEvent.click(screen.getByRole('link', { name: 'Beta' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('hub:repoRefs', {
        kind: 'model',
        repoId: 'org/beta'
      })
    )
    expect(screen.getByLabelText('location').textContent).toBe('/models/org/beta')
    expect(screen.queryByText('common:repro.repo.referenceUnavailable')).toBeNull()
    await act(async () => {
      betaRefs!.resolve(refsFor('org/beta'))
    })
    await screen.findByText('README beta')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('develop')
    await waitFor(() =>
      expect(screen.getByLabelText('location').textContent).toBe(
        '/models/org/beta?revision=develop'
      )
    )
    expect(mocks.invoke).not.toHaveBeenCalledWith('hub:resolveRevision', {
      kind: 'model',
      repoId: 'org/beta',
      revision: 'main'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByText('README alpha before')
    await waitFor(() =>
      expect(screen.getByLabelText('location').textContent).toBe('/models/org/alpha?revision=main')
    )
  })

  it('resolves a saved branch before showing its new README and freezing download/security at the new commit', async () => {
    refreshedSelection = deferred<RepoRevisionSelection>()
    openRepository()
    await startSave()
    await waitFor(() => expect(screen.queryByText('README alpha before')).toBeNull())
    expect(screen.queryByText('README alpha after')).toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalledWith('hub:readme', {
      kind: 'model',
      repoId: 'org/alpha',
      revision: AFTER
    })
    await act(async () => {
      refreshedSelection!.resolve(selection('org/alpha', 'main'))
    })
    await screen.findByText('README alpha after')
    expect(screen.getByTitle(AFTER).textContent).toContain(AFTER.slice(0, 8))
    expect(screen.getByLabelText('location').textContent).toBe('/models/org/alpha?revision=main')
    expect(
      client.getQueryData(repoQueryKey('readme', ENDPOINT, 'model', 'org/alpha', 'main', BEFORE))
    ).toEqual({ markdown: 'README alpha before', source: 'hub' })
    fireEvent.click(screen.getByRole('button', { name: 'detail:actions.download' }))
    await waitFor(() =>
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.objectContaining({ repoId: 'org/alpha', revision: 'main', resolvedCommit: AFTER })
      )
    )
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('downloads:start', {
        request: expect.objectContaining({
          revision: 'main',
          resolvedCommit: AFTER,
          securityGrantId: 'approved-grant'
        })
      })
    )
  })

  it.each([
    ['Exact commit', BEFORE],
    ['Tag', 'v1.0'],
    ['Pull request', 'refs/pr/7']
  ])(
    'does not move an explicitly selected %s when the previous branch save finishes',
    async (link, requested) => {
      save = deferred<RepoCommitResult>()
      openRepository()
      await startSave()
      fireEvent.click(screen.getByRole('link', { name: link }))
      await waitFor(() =>
        expect(screen.queryByRole('textbox', { name: 'README editor' })).toBeNull()
      )
      alphaHead = AFTER
      await act(async () => {
        save!.resolve({ ok: true, branch: 'main' })
      })
      await waitFor(() =>
        expect(
          useToasts.getState().toasts.some((toast) => toast.message === 'detail:edit.committed')
        ).toBe(true)
      )
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(requested)
      expect(screen.getByTitle(BEFORE)).not.toBeNull()
      expect(screen.getByText('README alpha before')).not.toBeNull()
      expect(screen.queryByText('README alpha after')).toBeNull()
      expect(screen.queryByRole('button', { name: 'detail:edit.action' })).toBeNull()
    }
  )

  it('keeps the original branch selected after PR creation rather than displaying its separate editing branch', async () => {
    openRepository()
    await startSave(true)
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'README editor' })).toBeNull())
    expect(screen.getByText('README alpha before')).not.toBeNull()
    expect(screen.getByTitle(BEFORE)).not.toBeNull()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('main')
    expect(screen.getByLabelText('location').textContent).toBe('/models/org/alpha?revision=main')
    expect(screen.queryByText('README alpha after')).toBeNull()
  })

  it('does not close a new repository editor or navigate away when an older save finishes', async () => {
    save = deferred<RepoCommitResult>()
    openRepository()
    await startSave()
    fireEvent.click(screen.getByRole('link', { name: 'Beta' }))
    await screen.findByText('README beta')
    fireEvent.click(screen.getByRole('button', { name: 'detail:edit.action' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'README editor' }), {
      target: { value: 'Unsaved beta draft' }
    })
    alphaHead = AFTER
    await act(async () => {
      save!.resolve({ ok: true, branch: 'main' })
    })
    expect(screen.getByLabelText('location').textContent).toBe('/models/org/beta?revision=develop')
    expect(
      (screen.getByRole('textbox', { name: 'README editor' }) as HTMLTextAreaElement).value
    ).toBe('Unsaved beta draft')
  })
})
