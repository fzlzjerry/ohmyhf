import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubClient } from '@oh-my-huggingface/hub-api'
import { FollowsPoller } from './follows'
import type { Library } from './library'
import type { NotificationService } from './notifications'
import type { SettingsStore } from './settings'

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false
    }
    on(): void {}
    show(): void {}
  }
}))

interface FakeSettings {
  pollIntervalMinutes: number
  notificationsEnabled: boolean
}

function makeSettings(initial: FakeSettings): {
  store: SettingsStore
  set: (patch: Partial<FakeSettings>) => void
} {
  let current = { ...initial }
  const listeners = new Set<(settings: FakeSettings) => void>()
  const store = {
    get: () => current,
    onChange: (listener: (settings: FakeSettings) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as SettingsStore
  return {
    store,
    set: (patch) => {
      current = { ...current, ...patch }
      for (const listener of listeners) listener(current)
    }
  }
}

describe('FollowsPoller scheduling', () => {
  const listFollows = vi.fn(() => [])
  const library = {
    listFollows,
    listInbox: () => []
  } as unknown as Library
  const notifications = { show: () => {} } as unknown as NotificationService
  let poller: FollowsPoller

  function makePoller(store: SettingsStore): FollowsPoller {
    return new FollowsPoller(library, {} as HubClient, store, () => {}, notifications)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    listFollows.mockClear()
  })

  afterEach(() => {
    poller.stop()
    vi.useRealTimers()
  })

  it('polls immediately on start', () => {
    const { store } = makeSettings({ pollIntervalMinutes: 30, notificationsEnabled: true })
    poller = makePoller(store)
    poller.start()
    expect(listFollows).toHaveBeenCalledTimes(1)
  })

  it('does not reset the interval on unrelated settings changes', () => {
    const { store, set } = makeSettings({ pollIntervalMinutes: 30, notificationsEnabled: true })
    poller = makePoller(store)
    poller.start()
    vi.advanceTimersByTime(29 * 60 * 1000)
    expect(listFollows).toHaveBeenCalledTimes(1)
    // An unrelated tweak 1 minute before the poll must not push it out.
    set({ notificationsEnabled: false })
    vi.advanceTimersByTime(60 * 1000)
    expect(listFollows).toHaveBeenCalledTimes(2)
  })

  it('rebuilds the timer when the poll interval changes', () => {
    const { store, set } = makeSettings({ pollIntervalMinutes: 30, notificationsEnabled: true })
    poller = makePoller(store)
    poller.start()
    set({ pollIntervalMinutes: 5 })
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(listFollows).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(listFollows).toHaveBeenCalledTimes(4)
  })

  it('resumes polling after stop', () => {
    const { store, set } = makeSettings({ pollIntervalMinutes: 30, notificationsEnabled: true })
    poller = makePoller(store)
    poller.start()
    poller.stop()
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(listFollows).toHaveBeenCalledTimes(1)

    poller.start()
    expect(listFollows).toHaveBeenCalledTimes(2)
    set({ notificationsEnabled: false })
    vi.advanceTimersByTime(29 * 60 * 1000)
    expect(listFollows).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60 * 1000)
    expect(listFollows).toHaveBeenCalledTimes(3)
  })
})
