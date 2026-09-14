// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { keepPreviousData, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthState } from '@oh-my-huggingface/shared'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
  t: (key: string) => key
}))

vi.mock('@/lib/ipc', () => ({
  invoke: mocks.invoke,
  openExternal: vi.fn(),
  onIpcEvent: (channel: string, listener: (payload: unknown) => void) => {
    mocks.listeners.set(channel, listener)
    return () => {
      mocks.listeners.delete(channel)
    }
  }
}))
vi.mock('@/lib/theme', () => ({ setTheme: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }))
vi.mock('@/components/layout/TopBar', () => ({ TopBar: () => null }))
vi.mock('@/components/layout/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('@/components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/settings/SettingsDialog', () => ({ SettingsDialog: () => null }))
vi.mock('@/components/ShortcutsHelpDialog', () => ({ ShortcutsHelpDialog: () => null }))
vi.mock('@/components/CommunityPrompt', () => ({ CommunityPrompt: () => null }))

import { DEFAULT_SETTINGS } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { repoQueryKey } from '@/lib/query'
import { useAppStore } from '@/stores/app'
import { useToasts } from '@/components/ui/toaster'
import { LikeButton } from '@/components/community/LikeButton'
import { AppShell } from './AppShell'

const readmeKey = repoQueryKey(
  'readme',
  'https://huggingface.co',
  'model',
  'private/repo',
  'main',
  'a'.repeat(40)
)
const accountA: AuthState = { status: 'signedIn', user: { name: 'account-a', orgs: [] } }
const accountB: AuthState = { status: 'signedIn', user: { name: 'account-b', orgs: [] } }
let client: QueryClient

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function AccountSurface(): React.JSX.Element {
  const auth = useAppStore((state) => state.auth)
  const readme = useQuery({
    queryKey: readmeKey,
    queryFn: () =>
      invoke('hub:readme', { kind: 'model', repoId: 'private/repo', revision: 'a'.repeat(40) }),
    placeholderData: keepPreviousData
  })
  const notifications = useQuery({
    queryKey: ['hub-notifications', 0, 'https://huggingface.co'],
    queryFn: () => mocks.invoke('hub:notifications', { page: 0 }) as Promise<string>,
    enabled: auth.status === 'signedIn',
    placeholderData: keepPreviousData
  })
  const downloads = useQuery<string[]>({
    queryKey: ['downloads'],
    queryFn: () => mocks.invoke('downloads:list') as Promise<string[]>,
    staleTime: Infinity
  })
  return (
    <>
      <p>{auth.status === 'signedIn' ? auth.user.name : 'signed out'}</p>
      <p>{readme.data ?? 'README loading'}</p>
      <p>{notifications.data ?? 'Notifications loading'}</p>
      <p>{downloads.data?.join(', ')}</p>
    </>
  )
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  useAppStore.setState({ settings: DEFAULT_SETTINGS, auth: accountA })
  useToasts.setState({ toasts: [] })
  mocks.listeners.clear()
  mocks.invoke.mockReset()
})

afterEach(() => {
  cleanup()
  client.clear()
  mocks.listeners.clear()
})

describe('AppShell authentication events', () => {
  it('replaces previous-account remote data with loading states, rejects late reads, and retains local downloads through account switch and sign-out', async () => {
    const oldReadme = deferred<string>()
    const oldNotifications = deferred<string>()
    const newReadme = deferred<string>()
    const newNotifications = deferred<string>()
    const anonymousReadme = deferred<string>()
    const anonymousNotifications = deferred<string>()
    let readmes = 0
    let notifications = 0
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'updater:getState') return Promise.resolve({ status: 'idle' })
      if (channel === 'integrationTasks:list') return Promise.resolve([])
      if (channel === 'hub:readme')
        return [oldReadme, newReadme, anonymousReadme][Math.min(readmes++, 2)]!.promise
      if (channel === 'hub:notifications')
        return [oldNotifications, newNotifications, anonymousNotifications][
          Math.min(notifications++, 2)
        ]!.promise
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    client.setQueryData(readmeKey, 'Account A private README')
    client.setQueryData(
      ['hub-notifications', 0, 'https://huggingface.co'],
      'Account A private notifications'
    )
    client.setQueryData(['downloads'], ['local download'])
    client.setQueryData(['cache'], { size: 42 })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/models']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/models" element={<AccountSurface />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
    expect(screen.getByText('Account A private README')).not.toBeNull()
    expect(screen.getByText('Account A private notifications')).not.toBeNull()
    await waitFor(() => expect(mocks.listeners.has('evt:auth')).toBe(true))
    act(() => {
      mocks.listeners.get('evt:auth')!(accountB)
    })
    expect(screen.getByText('account-b')).not.toBeNull()
    expect(screen.queryByText('Account A private README')).toBeNull()
    expect(screen.queryByText('Account A private notifications')).toBeNull()
    expect(screen.getByText('README loading')).not.toBeNull()
    expect(screen.getByText('Notifications loading')).not.toBeNull()
    await act(async () => {
      oldReadme.resolve('Late account A README')
      oldNotifications.resolve('Late account A notifications')
    })
    expect(screen.queryByText('Late account A README')).toBeNull()
    expect(screen.queryByText('Late account A notifications')).toBeNull()
    await act(async () => {
      newReadme.resolve('Account B README')
      newNotifications.resolve('Account B notifications')
    })
    await screen.findByText('Account B README')
    await screen.findByText('Account B notifications')
    act(() => {
      mocks.listeners.get('evt:auth')!({ status: 'signedOut' })
    })
    expect(screen.getByText('signed out')).not.toBeNull()
    expect(screen.queryByText('Account B README')).toBeNull()
    expect(screen.queryByText('Account B notifications')).toBeNull()
    expect(screen.getByText('local download')).not.toBeNull()
    expect(client.getQueryData(['cache'])).toEqual({ size: 42 })
  })

  it('forgets account A optimistic likes and ignores its delayed successful mutation after account B loads', async () => {
    const oldLike = deferred<void>()
    useAppStore.setState({ auth: { ...accountA, hubSession: true } })
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'updater:getState') return Promise.resolve({ status: 'idle' })
      if (
        channel === 'integrationTasks:list' ||
        channel === 'hub:userLikes' ||
        channel === 'favorites:add'
      )
        return Promise.resolve([])
      if (channel === 'hub:likeSet') return oldLike.promise
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    client.setQueryData(['user-likes', 'account-a', 'https://huggingface.co'], [])
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/models']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route
                path="/models"
                element={<LikeButton kind="model" repoId="org/alpha" likes={0} />}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'detail:like.like' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('hub:likeSet', {
        kind: 'model',
        repoId: 'org/alpha',
        liked: true
      })
    )
    expect(
      screen.getByRole('button', { name: 'detail:like.unlike' }).getAttribute('aria-pressed')
    ).toBe('true')
    act(() => {
      mocks.listeners.get('evt:auth')!(accountB)
    })
    await waitFor(() =>
      expect(client.getQueryData(['user-likes', 'account-b', 'https://huggingface.co'])).toEqual([])
    )
    expect(
      screen.getByRole('button', { name: 'detail:like.like' }).getAttribute('aria-pressed')
    ).toBe('false')
    await act(async () => {
      oldLike.resolve(undefined)
    })
    expect(client.getQueryData(['user-likes', 'account-b', 'https://huggingface.co'])).toEqual([])
    expect(
      screen.getByRole('button', { name: 'detail:like.like' }).getAttribute('aria-pressed')
    ).toBe('false')
  })
})
