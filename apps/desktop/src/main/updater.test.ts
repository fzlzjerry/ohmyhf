import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '@oh-my-huggingface/shared'
import { resolveUpdateClient, UpdateManager, type UpdateClient } from './updater'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class FakeUpdateClient extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  disableWebInstaller = false
  fullChangelog = true
  nextVersion: string | null = null
  checkError: Error | null = null
  downloadError: Error | null = null
  installError: Error | null = null
  checkGate: Promise<void> | null = null
  checkAfterEventGate: Promise<void> | null = null
  downloadGate: Promise<void> | null = null
  checkResultIsNull = false
  checkCalls = 0
  downloadCalls = 0
  installCalls: Array<[boolean | undefined, boolean | undefined]> = []

  async checkForUpdates(): Promise<{
    isUpdateAvailable: boolean
    updateInfo: { version: string }
  } | null> {
    this.checkCalls += 1
    this.emit('checking-for-update')
    if (this.checkGate) await this.checkGate
    if (this.checkError) {
      this.emit('error', this.checkError)
      throw this.checkError
    }
    if (this.checkResultIsNull) return null

    const info = { version: this.nextVersion ?? '1.0.0' }
    if (this.nextVersion) this.emit('update-available', info)
    else this.emit('update-not-available', info)
    if (this.checkAfterEventGate) await this.checkAfterEventGate
    return { isUpdateAvailable: this.nextVersion !== null, updateInfo: info }
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloadCalls += 1
    if (this.downloadGate) await this.downloadGate
    if (this.downloadError) {
      this.emit('error', this.downloadError)
      throw this.downloadError
    }
    this.emit('download-progress', {
      percent: 142,
      transferred: 1_500,
      total: 1_000,
      bytesPerSecond: 500
    })
    this.emit('update-downloaded', { version: this.nextVersion ?? '1.0.1' })
    return ['/private/sensitive/update.zip']
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installCalls.push([isSilent, isForceRunAfter])
    if (this.installError) this.emit('error', this.installError)
  }
}

function setup(
  options: {
    packaged?: boolean
    autoInstallSupported?: boolean
    autoInstallOnAppQuit?: boolean
    prepareInstall?: () => void | Promise<void>
    client?: FakeUpdateClient
  } = {}
): {
  client: FakeUpdateClient
  manager: UpdateManager
  states: AppUpdateState[]
  scheduled: Array<() => void>
  loadUpdater: ReturnType<typeof vi.fn>
} {
  const client = options.client ?? new FakeUpdateClient()
  const states: AppUpdateState[] = []
  const scheduled: Array<() => void> = []
  const loadUpdater = vi.fn(async () => client as unknown as UpdateClient)
  const manager = new UpdateManager({
    currentVersion: '1.0.0',
    isPackaged: options.packaged ?? true,
    autoInstallSupported: options.autoInstallSupported,
    autoInstallOnAppQuit: options.autoInstallOnAppQuit,
    prepareInstall: options.prepareInstall,
    loadUpdater,
    onStateChange: (state) => states.push(state),
    scheduleInstall: (task) => scheduled.push(task),
    logger: { warn: vi.fn() }
  })
  return { client, manager, states, scheduled, loadUpdater }
}

describe('UpdateManager', () => {
  it('resolves electron-updater from named and CommonJS default exports', () => {
    const client = new FakeUpdateClient() as unknown as UpdateClient

    expect(resolveUpdateClient({ autoUpdater: client })).toBe(client)
    expect(resolveUpdateClient({ default: { autoUpdater: client } })).toBe(client)
    expect(() => resolveUpdateClient({})).toThrow('did not expose autoUpdater')
  })

  it('disables updates in development builds without loading electron-updater', async () => {
    const { manager, loadUpdater } = setup({ packaged: false })

    expect(manager.getState()).toEqual({ status: 'unsupported', currentVersion: '1.0.0' })
    await expect(manager.checkForUpdates()).resolves.toEqual(manager.getState())
    expect(loadUpdater).not.toHaveBeenCalled()
  })

  it('checks the stable GitHub channel without downloading automatically', async () => {
    const { client, manager } = setup()
    client.nextVersion = '1.1.0'

    await expect(manager.checkForUpdates()).resolves.toEqual({
      status: 'available',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0'
    })
    expect(client.downloadCalls).toBe(0)
    expect(client.autoDownload).toBe(false)
    expect(client.autoInstallOnAppQuit).toBe(false)
    expect(client.allowPrerelease).toBe(false)
    expect(client.allowDowngrade).toBe(false)
    expect(client.disableWebInstaller).toBe(true)
    expect(client.fullChangelog).toBe(false)
  })

  it('reports up-to-date when the provider has no newer release', async () => {
    const { manager } = setup()

    await expect(manager.checkForUpdates()).resolves.toEqual({
      status: 'up-to-date',
      currentVersion: '1.0.0'
    })
  })

  it('offers a manual release without downloading when automatic install is unsupported', async () => {
    const { client, manager } = setup({ autoInstallSupported: false })
    client.nextVersion = '1.1.0'

    await expect(manager.checkForUpdates()).resolves.toEqual({
      status: 'manual',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0'
    })
    await expect(manager.downloadUpdate()).rejects.toThrow('No update is available to download')
    expect(client.downloadCalls).toBe(0)
  })

  it('deduplicates concurrent checks and downloads', async () => {
    const { client, manager } = setup()
    const checkGate = deferred()
    client.checkGate = checkGate.promise
    client.nextVersion = '1.1.0'

    const firstCheck = manager.checkForUpdates()
    const secondCheck = manager.checkForUpdates()
    expect(secondCheck).toBe(firstCheck)
    await vi.waitFor(() => expect(client.checkCalls).toBe(1))
    checkGate.resolve()
    await firstCheck

    const downloadGate = deferred()
    client.downloadGate = downloadGate.promise
    const firstDownload = manager.downloadUpdate()
    const secondDownload = manager.downloadUpdate()
    expect(secondDownload).toBe(firstDownload)
    await vi.waitFor(() => expect(client.downloadCalls).toBe(1))
    downloadGate.resolve()
    await firstDownload
  })

  it('clamps progress, hides downloaded paths, and installs only after download', async () => {
    const { client, manager, states, scheduled } = setup()
    client.nextVersion = '1.1.0'

    await expect(manager.installUpdate()).rejects.toThrow('No downloaded update')
    await manager.checkForUpdates()
    await manager.downloadUpdate()

    expect(states).toContainEqual({
      status: 'downloading',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      percent: 100,
      transferred: 1_000,
      total: 1_000,
      bytesPerSecond: 500
    })
    expect(manager.getState()).toEqual({
      status: 'ready',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0'
    })
    expect(JSON.stringify(states)).not.toContain('/private/sensitive')

    await Promise.all([manager.installUpdate(), manager.installUpdate()])
    expect(scheduled).toHaveLength(1)
    expect(client.installCalls).toHaveLength(0)
    scheduled[0]!()
    expect(client.installCalls).toEqual([[false, true]])
  })

  it('stages the update with Squirrel when autoInstallOnAppQuit is enabled', async () => {
    const { client, manager } = setup({ autoInstallOnAppQuit: true })
    client.nextVersion = '1.1.0'

    await manager.checkForUpdates()
    expect(client.autoInstallOnAppQuit).toBe(true)
  })

  it('prepares the process for quit before calling quitAndInstall', async () => {
    const order: string[] = []
    const { client, manager, scheduled } = setup({
      prepareInstall: () => {
        order.push('prepare')
      }
    })
    client.nextVersion = '1.1.0'
    await manager.checkForUpdates()
    await manager.downloadUpdate()

    await manager.installUpdate()
    expect(order).toEqual(['prepare'])
    expect(client.installCalls).toHaveLength(0)
    scheduled[0]!()
    expect(client.installCalls).toEqual([[false, true]])
  })

  it('waits for async prepareInstall before scheduling quitAndInstall', async () => {
    const gate = deferred()
    const { client, manager, scheduled } = setup({
      prepareInstall: async () => {
        await gate.promise
      }
    })
    client.nextVersion = '1.1.0'
    await manager.checkForUpdates()
    await manager.downloadUpdate()

    const install = manager.installUpdate()
    await Promise.resolve()
    expect(scheduled).toHaveLength(0)
    gate.resolve()
    await install
    expect(scheduled).toHaveLength(1)
  })

  it('fails the install and allows retry if prepareInstall throws', async () => {
    let shouldFail = true
    const { client, manager, scheduled } = setup({
      prepareInstall: () => {
        if (shouldFail) throw new Error('cleanup failed')
      }
    })
    client.nextVersion = '1.1.0'
    await manager.checkForUpdates()
    await manager.downloadUpdate()

    await manager.installUpdate()
    expect(manager.getState()).toMatchObject({
      status: 'error',
      operation: 'install',
      error: 'unknown'
    })
    expect(scheduled).toHaveLength(0)

    shouldFail = false
    await manager.installUpdate()
    expect(scheduled).toHaveLength(1)
  })

  it('classifies an asynchronous install error and allows retrying the downloaded update', async () => {
    const { client, manager, scheduled } = setup()
    client.nextVersion = '1.1.0'
    client.installError = new Error('EACCES: permission denied')
    await manager.checkForUpdates()
    await manager.downloadUpdate()

    await manager.installUpdate()
    scheduled[0]!()
    expect(manager.getState()).toEqual({
      status: 'error',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      operation: 'install',
      error: 'permission'
    })

    client.installError = null
    await manager.installUpdate()
    expect(scheduled).toHaveLength(2)
  })

  it('keeps download failures classified as download after an early available event', async () => {
    const { client, manager } = setup()
    const checkAfterEventGate = deferred()
    const downloadGate = deferred()
    client.nextVersion = '1.1.0'
    client.checkAfterEventGate = checkAfterEventGate.promise
    client.downloadGate = downloadGate.promise
    client.downloadError = new Error('network timeout')

    const check = manager.checkForUpdates()
    await vi.waitFor(() => expect(manager.getState().status).toBe('available'))
    const download = manager.downloadUpdate()
    await vi.waitFor(() => expect(client.downloadCalls).toBe(1))
    checkAfterEventGate.resolve()
    await check
    downloadGate.resolve()

    await expect(download).resolves.toEqual({
      status: 'error',
      currentVersion: '1.0.0',
      operation: 'download',
      error: 'network'
    })
  })

  it('maps raw provider failures to safe renderer error codes and can retry', async () => {
    const { client, manager, states } = setup()
    client.checkError = new Error('sha512 checksum mismatch at /private/update.zip')

    await expect(manager.checkForUpdates()).resolves.toEqual({
      status: 'error',
      currentVersion: '1.0.0',
      operation: 'check',
      error: 'verification'
    })
    expect(states.filter((state) => state.status === 'error')).toHaveLength(1)
    expect(JSON.stringify(states)).not.toContain('/private/update.zip')

    client.checkError = null
    await expect(manager.checkForUpdates()).resolves.toEqual({
      status: 'up-to-date',
      currentVersion: '1.0.0'
    })
  })

  it('treats a disabled packaged updater as missing release configuration', async () => {
    const { client, manager } = setup()
    client.checkResultIsNull = true

    await expect(manager.checkForUpdates()).resolves.toEqual({
      status: 'error',
      currentVersion: '1.0.0',
      operation: 'check',
      error: 'configuration'
    })
  })

  describe('install watchdog', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('fails the install if quitAndInstall never actually quits the app', async () => {
      const { client, manager, scheduled } = setup()
      client.nextVersion = '1.1.0'
      await manager.checkForUpdates()
      await manager.downloadUpdate()

      await manager.installUpdate()
      scheduled[0]!()
      expect(client.installCalls).toEqual([[false, true]])
      expect(manager.getState().status).toBe('ready')

      await vi.advanceTimersByTimeAsync(45_000)

      expect(manager.getState()).toEqual({
        status: 'error',
        currentVersion: '1.0.0',
        availableVersion: '1.1.0',
        operation: 'install',
        error: 'unknown'
      })

      // installScheduled was reset, so a retry schedules another install attempt.
      await manager.installUpdate()
      expect(scheduled).toHaveLength(2)
    })

    it('does not fail the install once quitAndInstall reports an error first', async () => {
      const { client, manager, scheduled } = setup()
      client.nextVersion = '1.1.0'
      client.installError = new Error('EACCES: permission denied')
      await manager.checkForUpdates()
      await manager.downloadUpdate()

      await manager.installUpdate()
      scheduled[0]!()
      expect(manager.getState()).toMatchObject({ status: 'error', error: 'permission' })

      await vi.advanceTimersByTimeAsync(45_000)

      expect(manager.getState()).toMatchObject({ status: 'error', error: 'permission' })
    })
  })
})
