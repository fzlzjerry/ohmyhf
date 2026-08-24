// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setSettings: vi.fn(),
  state: {
    settings: { telemetryEnabled: false },
    settingsOpen: false,
    paletteOpen: false,
    shortcutsOpen: false,
    setSettings: vi.fn()
  }
}))

vi.mock('@/lib/ipc', () => ({ invoke: mocks.invoke }))
vi.mock('@/stores/app', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import { PROJECT_REPOSITORY_URL, TELEMETRY_DOCUMENTATION_URL } from '@oh-my-huggingface/shared'
import { CommunityPrompt } from './CommunityPrompt'
import { useToasts } from '@/components/ui/toaster'

const CLAIM_ID = '12345678-1234-4234-8234-123456789abc'
const CONSENT_CLAIM_ID = '87654321-4321-4321-8321-cba987654321'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function blockingDialog(): HTMLDivElement {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('data-state', 'open')
  dialog.setAttribute('data-community-test-overlay', '')
  document.body.append(dialog)
  return dialog
}

function transientOverlay(role: 'menu' | 'listbox'): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.setAttribute('role', role)
  overlay.setAttribute('data-state', 'open')
  overlay.setAttribute('data-community-test-overlay', '')
  document.body.append(overlay)
  return overlay
}

describe('CommunityPrompt', () => {
  let focused = true
  let visibility: DocumentVisibilityState = 'visible'
  let originalVisibility: PropertyDescriptor | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    focused = true
    visibility = 'visible'
    originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility
    })
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    mocks.invoke.mockReset()
    mocks.setSettings.mockReset()
    mocks.state.setSettings = mocks.setSettings
    mocks.state.settingsOpen = false
    mocks.state.settings.telemetryEnabled = false
    mocks.state.paletteOpen = false
    mocks.state.shortcutsOpen = false
    useToasts.setState({ toasts: [] })
  })

  afterEach(() => {
    cleanup()
    document.querySelectorAll('[data-community-test-overlay]').forEach((node) => node.remove())
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (originalVisibility) {
      Object.defineProperty(document, 'visibilityState', originalVisibility)
    }
  })

  async function flushEffects(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function passDelay(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
      await Promise.resolve()
    })
  }

  it('starts the first quiet prompt check after ten foreground seconds', async () => {
    mocks.invoke.mockResolvedValue({ show: false })
    render(<CommunityPrompt />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999)
    })
    expect(mocks.invoke).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
    })
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'telemetry:claimConsentPrompt',
      'starReminder:claim'
    ])
  })

  it('keeps an empty live region mounted and waits for a visible, focused window', async () => {
    focused = false
    mocks.invoke.mockResolvedValue({ show: false })
    render(<CommunityPrompt />)

    expect(screen.getByRole('status').textContent).toBe('')
    await passDelay()
    expect(mocks.invoke).not.toHaveBeenCalled()

    focused = true
    await act(async () => window.dispatchEvent(new Event('focus')))
    await passDelay()

    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'telemetry:claimConsentPrompt',
      'starReminder:claim'
    ])
  })

  it('retries quiet claims and shows Star after meaningful activity begins in the same session', async () => {
    let meaningful = false
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') return { show: false }
      if (channel === 'starReminder:claim') {
        return meaningful ? { show: true, claimId: CLAIM_ID } : { show: false }
      }
      if (channel === 'starReminder:acknowledgeShown') {
        return { accepted: true, promptNumber: 1, newlyAccepted: true }
      }
      if (channel === 'starReminder:respond') {
        return { accepted: true, outcome: 'snoozed', promptNumber: 1 }
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)

    await passDelay()
    expect(screen.queryByRole('region')).toBeNull()
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => channel === 'starReminder:claim')
    ).toHaveLength(1)

    meaningful = true
    await passDelay()
    const region = screen.getByRole('region', { name: 'settings:community.star.title' })
    expect(region.getAttribute('data-community-prompt')).toBe('star')
    expect(
      screen
        .getByRole('button', { name: 'settings:community.star.later' })
        .getAttribute('data-community-action')
    ).toBe('star-later')
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => channel === 'starReminder:claim')
    ).toHaveLength(2)

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'settings:community.star.later' }))
    )
    await passDelay()
    await passDelay()
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => channel === 'starReminder:claim')
    ).toHaveLength(2)
  })

  it('retries after a transient claim IPC failure', async () => {
    let telemetryAttempts = 0
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') {
        telemetryAttempts += 1
        if (telemetryAttempts === 1) throw new Error('temporary IPC failure')
        return { show: false }
      }
      if (channel === 'starReminder:claim') return { show: true, claimId: CLAIM_ID }
      if (channel === 'starReminder:acknowledgeShown') {
        return { accepted: true, promptNumber: 1, newlyAccepted: true }
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)

    await passDelay()
    expect(screen.queryByRole('region')).toBeNull()
    await passDelay()

    expect(telemetryAttempts).toBe(2)
    expect(
      screen
        .getByRole('region', { name: 'settings:community.star.title' })
        .getAttribute('data-community-prompt')
    ).toBe('star')
  })

  it('does not claim while any page-local modal is open', async () => {
    const dialog = blockingDialog()
    mocks.invoke.mockResolvedValue({ show: false })
    render(<CommunityPrompt />)

    await passDelay()
    expect(mocks.invoke).not.toHaveBeenCalled()

    dialog.remove()
    await flushEffects()
    await passDelay()
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'telemetry:claimConsentPrompt',
      'starReminder:claim'
    ])
  })

  it.each(['menu', 'listbox'] as const)('does not claim underneath an open %s', async (role) => {
    const overlay = transientOverlay(role)
    mocks.invoke.mockResolvedValue({ show: false })
    render(<CommunityPrompt />)

    await passDelay()
    expect(mocks.invoke).not.toHaveBeenCalled()

    overlay.remove()
    await flushEffects()
    await passDelay()
    expect(mocks.invoke).toHaveBeenCalledWith('telemetry:claimConsentPrompt', undefined)
  })

  it('does not claim underneath an app-marked mention listbox without Radix state', async () => {
    const mention = transientOverlay('listbox')
    mention.removeAttribute('data-state')
    mention.setAttribute('data-community-blocking-overlay', '')
    mocks.invoke.mockResolvedValue({ show: false })
    render(<CommunityPrompt />)

    await passDelay()
    expect(mocks.invoke).not.toHaveBeenCalled()

    mention.remove()
    await flushEffects()
    await passDelay()
    expect(mocks.invoke).toHaveBeenCalledWith('telemetry:claimConsentPrompt', undefined)
  })

  it('acknowledges a rendered Star card before enabling actions and labels prompt two as final', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') return { show: false }
      if (channel === 'starReminder:claim') return { show: true, claimId: CLAIM_ID }
      if (channel === 'starReminder:acknowledgeShown') {
        return { accepted: true, promptNumber: 2, newlyAccepted: true }
      }
      if (channel === 'starReminder:respond') {
        return { accepted: true, outcome: 'exhausted', promptNumber: 2 }
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)

    await passDelay()

    expect(
      screen
        .getByRole('region', { name: 'settings:community.star.title' })
        .getAttribute('data-community-prompt')
    ).toBe('star')
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toBe('settings:community.star.title')
    expect(mocks.invoke).toHaveBeenCalledWith('starReminder:acknowledgeShown', {
      claimId: CLAIM_ID
    })

    const finalButton = screen.getByRole('button', {
      name: 'settings:community.star.laterFinal'
    })
    expect((finalButton as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'settings:community.star.disable' })).toBeNull()

    await act(async () => fireEvent.click(finalButton))
    expect(mocks.invoke).toHaveBeenCalledWith('starReminder:respond', {
      claimId: CLAIM_ID,
      action: 'later'
    })
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('offers a persistent direct retry when the system browser fails to open', async () => {
    let retryAttempts = 0
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') return { show: false }
      if (channel === 'starReminder:claim') return { show: true, claimId: CLAIM_ID }
      if (channel === 'starReminder:acknowledgeShown') {
        return { accepted: true, promptNumber: 1, newlyAccepted: true }
      }
      if (channel === 'starReminder:respond') {
        return {
          accepted: true,
          outcome: 'opened',
          promptNumber: 1,
          externalOpened: false
        }
      }
      if (channel === 'system:openExternal') {
        retryAttempts += 1
        if (retryAttempts === 1) throw new Error('Browser is still unavailable')
        return undefined
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)
    await passDelay()

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'settings:community.star.open' }))
    )

    expect(screen.queryByRole('region')).toBeNull()
    const [toast] = useToasts.getState().toasts
    expect(toast?.duration).toBeNull()
    expect(toast?.action?.label).toBe('settings:community.star.open')

    await act(async () => {
      toast?.action?.onClick()
      await Promise.resolve()
    })
    expect(mocks.invoke).toHaveBeenCalledWith('system:openExternal', {
      url: PROJECT_REPOSITORY_URL
    })
    const retryToast = useToasts.getState().toasts.at(-1)
    expect(retryToast?.duration).toBeNull()
    expect(retryToast?.action?.label).toBe('settings:community.star.open')

    await act(async () => retryToast?.action?.onClick())
    expect(retryAttempts).toBe(2)
  })

  it('keeps consent actions and Escape disabled until the visible-card acknowledgement returns', async () => {
    const acknowledgement = deferred<{ accepted: true; newlyAccepted: true }>()
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') {
        return Promise.resolve({ show: true, claimId: CONSENT_CLAIM_ID })
      }
      if (channel === 'telemetry:acknowledgeConsentPrompt') return acknowledgement.promise
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)

    await passDelay()
    const accept = screen.getByRole('button', { name: 'settings:community.telemetry.accept' })
    expect((accept as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(
      screen
        .getByRole('region', { name: 'settings:community.telemetry.title' })
        .getAttribute('data-community-prompt')
    ).toBe('telemetry')

    await act(async () => acknowledgement.resolve({ accepted: true, newlyAccepted: true }))
    expect((accept as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole('status').textContent).toBe('settings:community.telemetry.title')
  })

  it('removes a consent card resolved by the Settings telemetry switch', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') {
        return { show: true, claimId: CONSENT_CLAIM_ID }
      }
      if (channel === 'telemetry:acknowledgeConsentPrompt') {
        return { accepted: true, newlyAccepted: true }
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    const view = render(<CommunityPrompt />)

    await passDelay()
    expect(
      screen.getByRole('region', { name: 'settings:community.telemetry.title' })
    ).not.toBeNull()

    mocks.state.settings.telemetryEnabled = true
    view.rerender(<CommunityPrompt />)
    await flushEffects()

    expect(screen.queryByRole('region')).toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'telemetry:resolveConsentPrompt',
      expect.anything()
    )
  })

  it('preserves an in-flight Star acknowledgement across foreground suppression', async () => {
    const acknowledgement = deferred<{
      accepted: true
      promptNumber: 1
      newlyAccepted: true
    }>()
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') return Promise.resolve({ show: false })
      if (channel === 'starReminder:claim') {
        return Promise.resolve({ show: true, claimId: CLAIM_ID })
      }
      if (channel === 'starReminder:acknowledgeShown') return acknowledgement.promise
      if (channel === 'starReminder:respond') {
        return Promise.resolve({ accepted: true, outcome: 'snoozed', promptNumber: 1 })
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)

    await passDelay()
    const later = screen.getByRole('button', { name: 'settings:community.star.later' })
    expect((later as HTMLButtonElement).disabled).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mocks.invoke).not.toHaveBeenCalledWith('starReminder:respond', expect.anything())

    focused = false
    await act(async () => window.dispatchEvent(new Event('blur')))
    expect(screen.queryByRole('region')).toBeNull()

    await act(async () =>
      acknowledgement.resolve({ accepted: true, promptNumber: 1, newlyAccepted: true })
    )
    expect(screen.queryByRole('region')).toBeNull()

    focused = true
    await act(async () => window.dispatchEvent(new Event('focus')))
    const restored = screen.getByRole('button', { name: 'settings:community.star.later' })
    expect((restored as HTMLButtonElement).disabled).toBe(false)
    expect(
      mocks.invoke.mock.calls.filter(([channel]) => channel === 'starReminder:acknowledgeShown')
    ).toHaveLength(1)
  })

  it('does not acknowledge Star when a blur races the claim response', async () => {
    const claim = deferred<{ show: true; claimId: string }>()
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') return Promise.resolve({ show: false })
      if (channel === 'starReminder:claim') return claim.promise
      if (channel === 'starReminder:acknowledgeShown') {
        return Promise.resolve({ accepted: true, promptNumber: 1, newlyAccepted: true })
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)
    await passDelay()

    focused = false
    await act(async () => claim.resolve({ show: true, claimId: CLAIM_ID }))
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'starReminder:acknowledgeShown',
      expect.anything()
    )

    await act(async () => window.dispatchEvent(new Event('blur')))
    focused = true
    await act(async () => window.dispatchEvent(new Event('focus')))
    await flushEffects()
    expect(mocks.invoke).toHaveBeenCalledWith('starReminder:acknowledgeShown', {
      claimId: CLAIM_ID
    })
  })

  it('does not acknowledge telemetry when a dialog races the claim response', async () => {
    const claim = deferred<{ show: true; claimId: string }>()
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') return claim.promise
      if (channel === 'telemetry:acknowledgeConsentPrompt') {
        return Promise.resolve({ accepted: true, newlyAccepted: true })
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)
    await passDelay()

    const dialog = blockingDialog()
    await act(async () => claim.resolve({ show: true, claimId: CONSENT_CLAIM_ID }))
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'telemetry:acknowledgeConsentPrompt',
      expect.anything()
    )

    dialog.remove()
    await flushEffects()
    expect(mocks.invoke).toHaveBeenCalledWith('telemetry:acknowledgeConsentPrompt', {
      claimId: CONSENT_CLAIM_ID
    })
  })

  it('does not let Escape act on a reminder underneath an open dialog', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') return { show: false }
      if (channel === 'starReminder:claim') return { show: true, claimId: CLAIM_ID }
      if (channel === 'starReminder:acknowledgeShown') {
        return { accepted: true, promptNumber: 1, newlyAccepted: true }
      }
      if (channel === 'starReminder:respond') {
        return { accepted: true, outcome: 'snoozed', promptNumber: 1 }
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)
    await passDelay()

    const dialog = blockingDialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mocks.invoke).not.toHaveBeenCalledWith('starReminder:respond', expect.anything())

    await flushEffects()
    expect(screen.queryByRole('region', { name: 'settings:community.star.title' })).toBeNull()
    dialog.remove()
  })

  it('keeps telemetry visible until an explicit decline is accepted', async () => {
    let resolveAttempts = 0
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') {
        return { show: true, claimId: CONSENT_CLAIM_ID }
      }
      if (channel === 'telemetry:acknowledgeConsentPrompt') {
        return { accepted: true, newlyAccepted: true }
      }
      if (channel === 'telemetry:resolveConsentPrompt') {
        resolveAttempts += 1
        return resolveAttempts === 1
          ? { accepted: false, newlyResolved: false }
          : {
              accepted: true,
              newlyResolved: true,
              decision: 'decline'
            }
      }
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)
    await passDelay()

    const decline = screen.getByRole('button', { name: 'settings:community.telemetry.decline' })
    expect(decline.getAttribute('data-community-action')).toBe('telemetry-decline')
    await act(async () => fireEvent.click(decline))
    expect(
      screen.getByRole('region', { name: 'settings:community.telemetry.title' })
    ).not.toBeNull()

    await act(async () => fireEvent.click(decline))
    expect(resolveAttempts).toBe(2)
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('finishes telemetry acceptance through the persisted settings write', async () => {
    const settings = { telemetryEnabled: true }
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') {
        return { show: true, claimId: CONSENT_CLAIM_ID }
      }
      if (channel === 'telemetry:acknowledgeConsentPrompt') {
        return { accepted: true, newlyAccepted: true }
      }
      if (channel === 'settings:set') return settings
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)
    await passDelay()

    const accept = screen.getByRole('button', { name: 'settings:community.telemetry.accept' })
    expect(accept.getAttribute('data-community-action')).toBe('telemetry-accept')
    await act(async () => fireEvent.click(accept))

    expect(mocks.invoke).toHaveBeenCalledWith('settings:set', {
      patch: { telemetryEnabled: true }
    })
    expect(mocks.setSettings).toHaveBeenCalledWith(settings)
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'telemetry:resolveConsentPrompt',
      expect.anything()
    )
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('discloses telemetry details and lets Escape explicitly decline without enabling it', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'telemetry:claimConsentPrompt') {
        return { show: true, claimId: CONSENT_CLAIM_ID }
      }
      if (channel === 'telemetry:acknowledgeConsentPrompt') {
        return { accepted: true, newlyAccepted: true }
      }
      if (channel === 'telemetry:resolveConsentPrompt') {
        return { accepted: true, newlyResolved: true, decision: 'decline' }
      }
      if (channel === 'system:openExternal') return undefined
      throw new Error(`Unexpected channel: ${channel}`)
    })
    render(<CommunityPrompt />)

    await passDelay()
    expect(
      screen.getByRole('region', { name: 'settings:community.telemetry.title' })
    ).not.toBeNull()

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'settings:community.telemetry.details' }))
    )
    expect(mocks.invoke).toHaveBeenCalledWith('system:openExternal', {
      url: TELEMETRY_DOCUMENTATION_URL
    })

    await act(async () => fireEvent.keyDown(window, { key: 'Escape' }))
    expect(screen.queryByRole('region')).toBeNull()
    expect(mocks.invoke).toHaveBeenCalledWith('telemetry:resolveConsentPrompt', {
      claimId: CONSENT_CLAIM_ID,
      decision: 'decline'
    })
    expect(mocks.invoke).not.toHaveBeenCalledWith('settings:set', expect.anything())

    await passDelay()
    await passDelay()
    expect(mocks.invoke).not.toHaveBeenCalledWith('starReminder:claim', undefined)
  })
})
