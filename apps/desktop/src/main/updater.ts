import type {
  AppUpdateErrorCode,
  AppUpdateOperation,
  AppUpdateState
} from '@oh-my-huggingface/shared'

interface UpdateInfo {
  version: string
}

interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

interface UpdateCheckResult {
  isUpdateAvailable: boolean
  updateInfo: UpdateInfo
}

interface UpdateClientEvents {
  'checking-for-update': () => void
  'update-not-available': (info: UpdateInfo) => void
  'update-available': (info: UpdateInfo) => void
  'download-progress': (progress: UpdateProgress) => void
  'update-downloaded': (info: UpdateInfo) => void
  'update-cancelled': (info: UpdateInfo) => void
  error: (error: Error) => void
}

/** Narrow adapter around electron-updater so the state machine stays unit-testable. */
export interface UpdateClient {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  disableWebInstaller: boolean
  fullChangelog: boolean
  on<E extends keyof UpdateClientEvents>(event: E, listener: UpdateClientEvents[E]): unknown
  checkForUpdates(): Promise<UpdateCheckResult | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/** electron-updater is CommonJS; ESM runtimes may expose it only through `default`. */
export function resolveUpdateClient(module: unknown): UpdateClient {
  const namespace = module as {
    autoUpdater?: UpdateClient
    default?: { autoUpdater?: UpdateClient }
  }
  const client = namespace.autoUpdater ?? namespace.default?.autoUpdater
  if (!client) throw new Error('electron-updater did not expose autoUpdater')
  return client
}

interface UpdateManagerOptions {
  currentVersion: string
  isPackaged: boolean
  autoInstallSupported?: boolean
  /**
   * Passed through to electron-updater. Keep false on Windows/Linux so a
   * normal quit does not spawn the installer. On macOS MacUpdater does not
   * install on quit — the flag only tells Squirrel.Mac to stage the zip
   * after download, which quitAndInstall needs to relaunch instead of just
   * closing windows.
   */
  autoInstallOnAppQuit?: boolean
  loadUpdater: () => Promise<UpdateClient>
  onStateChange: (state: AppUpdateState) => void
  /** Awaited before quitAndInstall so close-to-tray / before-quit can let the process die. */
  prepareInstall?: () => void | Promise<void>
  scheduleInstall?: (task: () => void) => void
  logger?: Pick<Console, 'warn'>
  /** How long to wait for quitAndInstall to actually quit the app before treating it as failed. */
  installTimeoutMs?: number
}

function classifyError(error: unknown): AppUpdateErrorCode {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /sha-?512|checksum|signature|code object is not signed|could not be verified/i.test(message)
  ) {
    return 'verification'
  }
  if (/eacces|eperm|permission|not permitted|access denied/i.test(message)) return 'permission'
  if (
    /app-update\.ya?ml|latest(?:-mac|-linux)?\.ya?ml|no published versions|feed url|updater is disabled|configuration unavailable/i.test(
      message
    )
  ) {
    return 'configuration'
  }
  if (
    /enotfound|econn|etimedout|network|net::|socket|timeout|http(?:s)? request|status code/i.test(
      message
    )
  ) {
    return 'network'
  }
  return 'unknown'
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * Owns the single electron-updater instance and exposes a small, serial state machine.
 * Release discovery and semantic-version comparison remain electron-updater's job;
 * renderer code never sees provider URLs, downloaded paths, or raw errors.
 */
export class UpdateManager {
  private state: AppUpdateState
  private readonly currentVersion: string
  private readonly isPackaged: boolean
  private readonly autoInstallSupported: boolean
  private readonly autoInstallOnAppQuit: boolean
  private readonly loadUpdater: () => Promise<UpdateClient>
  private readonly onStateChange: (state: AppUpdateState) => void
  private readonly prepareInstall: () => Promise<void>
  private readonly scheduleInstall: (task: () => void) => void
  private readonly logger: Pick<Console, 'warn'>
  private readonly installTimeoutMs: number
  private clientPromise: Promise<UpdateClient> | null = null
  private checkPromise: Promise<AppUpdateState> | null = null
  private downloadPromise: Promise<AppUpdateState> | null = null
  private availableVersion: string | null = null
  private activeOperation: AppUpdateOperation | null = null
  private installScheduled = false
  private installWatchdog: NodeJS.Timeout | null = null

  constructor(options: UpdateManagerOptions) {
    this.currentVersion = options.currentVersion
    this.isPackaged = options.isPackaged
    this.autoInstallSupported = options.autoInstallSupported ?? true
    this.autoInstallOnAppQuit = options.autoInstallOnAppQuit ?? false
    this.loadUpdater = options.loadUpdater
    this.onStateChange = options.onStateChange
    this.prepareInstall = async () => {
      await options.prepareInstall?.()
    }
    this.scheduleInstall = options.scheduleInstall ?? ((task) => setImmediate(task))
    this.logger = options.logger ?? console
    this.installTimeoutMs = options.installTimeoutMs ?? 45_000
    this.state = {
      status: this.isPackaged ? 'idle' : 'unsupported',
      currentVersion: this.currentVersion
    }
  }

  getState(): AppUpdateState {
    return this.state
  }

  checkForUpdates(): Promise<AppUpdateState> {
    if (!this.isPackaged || this.state.status === 'downloading' || this.state.status === 'ready') {
      return Promise.resolve(this.state)
    }
    if (this.checkPromise) return this.checkPromise

    this.checkPromise = this.performCheck()
    return this.checkPromise
  }

  downloadUpdate(): Promise<AppUpdateState> {
    if (this.downloadPromise) return this.downloadPromise
    if (this.state.status !== 'available' || !this.availableVersion) {
      return Promise.reject(new Error('No update is available to download'))
    }

    this.downloadPromise = this.performDownload(this.availableVersion)
    return this.downloadPromise
  }

  async installUpdate(): Promise<void> {
    const canRetryInstall =
      this.state.status === 'error' &&
      this.state.operation === 'install' &&
      this.state.availableVersion !== undefined
    if (this.state.status !== 'ready' && !canRetryInstall) {
      throw new Error('No downloaded update is ready to install')
    }
    if (this.installScheduled) return

    this.installScheduled = true
    try {
      const client = await this.getClient()
      await this.prepareInstall()
      this.scheduleInstall(() => {
        try {
          client.quitAndInstall(false, true)
          // quitAndInstall is expected to quit the app almost immediately, at which
          // point no further JS runs. If we're still alive after this fires, the
          // native install/relaunch handshake silently never completed (observed on
          // macOS) and the host should force a relaunch. installScheduled may
          // already be false here if quitAndInstall reported its failure
          // synchronously (via the client's 'error' event).
          if (this.installScheduled) this.armInstallWatchdog()
        } catch (error) {
          this.installScheduled = false
          this.fail('install', error)
        }
      })
    } catch (error) {
      this.installScheduled = false
      this.fail('install', error)
    }
  }

  private armInstallWatchdog(): void {
    this.clearInstallWatchdog()
    const timer = setTimeout(() => {
      this.installWatchdog = null
      if (!this.installScheduled) return
      this.installScheduled = false
      this.fail('install', new Error('Install timed out: the app did not quit and relaunch'))
    }, this.installTimeoutMs)
    timer.unref?.()
    this.installWatchdog = timer
  }

  private clearInstallWatchdog(): void {
    if (this.installWatchdog) {
      clearTimeout(this.installWatchdog)
      this.installWatchdog = null
    }
  }

  private async performCheck(): Promise<AppUpdateState> {
    this.availableVersion = null
    this.activeOperation = 'check'
    this.setState({ status: 'checking', currentVersion: this.currentVersion })
    try {
      const client = await this.getClient()
      const result = await client.checkForUpdates()
      if (result === null) {
        return this.fail('check', new Error('Update configuration unavailable'))
      }
      // Events normally move the state first. This fallback also supports providers
      // that resolve the result without emitting their informational event.
      if (this.state.status === 'checking') {
        if (result?.isUpdateAvailable) this.markAvailable(result.updateInfo)
        else this.setState({ status: 'up-to-date', currentVersion: this.currentVersion })
      }
      return this.state
    } catch (error) {
      return this.fail('check', error)
    } finally {
      if (this.activeOperation === 'check') this.activeOperation = null
      this.checkPromise = null
    }
  }

  private async performDownload(version: string): Promise<AppUpdateState> {
    this.activeOperation = 'download'
    this.setState({
      status: 'downloading',
      currentVersion: this.currentVersion,
      availableVersion: version,
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0
    })
    try {
      const client = await this.getClient()
      await client.downloadUpdate()
      if (this.state.status === 'downloading') {
        this.setState({
          status: 'ready',
          currentVersion: this.currentVersion,
          availableVersion: version
        })
      }
      return this.state
    } catch (error) {
      return this.fail('download', error)
    } finally {
      if (this.activeOperation === 'download') this.activeOperation = null
      this.downloadPromise = null
    }
  }

  private getClient(): Promise<UpdateClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.loadUpdater()
        .then((client) => {
          client.autoDownload = false
          client.autoInstallOnAppQuit = this.autoInstallOnAppQuit
          client.allowPrerelease = false
          client.allowDowngrade = false
          client.disableWebInstaller = true
          client.fullChangelog = false
          this.bindClient(client)
          return client
        })
        .catch((error) => {
          this.clientPromise = null
          throw error
        })
    }
    return this.clientPromise
  }

  private bindClient(client: UpdateClient): void {
    client.on('checking-for-update', () => {
      this.setState({ status: 'checking', currentVersion: this.currentVersion })
    })
    client.on('update-not-available', () => {
      this.availableVersion = null
      this.setState({ status: 'up-to-date', currentVersion: this.currentVersion })
    })
    client.on('update-available', (info) => this.markAvailable(info))
    client.on('download-progress', (progress) => this.markProgress(progress))
    client.on('update-downloaded', (info) => {
      if (!this.autoInstallSupported) {
        this.markAvailable(info)
        return
      }
      const version = info.version || this.availableVersion
      if (!version) return
      this.availableVersion = version
      this.setState({
        status: 'ready',
        currentVersion: this.currentVersion,
        availableVersion: version
      })
    })
    client.on('update-cancelled', (info) => this.markAvailable(info))
    client.on('error', (error) => {
      const operation = this.installScheduled ? 'install' : (this.activeOperation ?? 'check')
      if (operation === 'install') {
        this.installScheduled = false
        this.clearInstallWatchdog()
      }
      this.fail(operation, error)
    })
  }

  private markAvailable(info: UpdateInfo): void {
    this.availableVersion = info.version
    this.setState({
      status: this.autoInstallSupported ? 'available' : 'manual',
      currentVersion: this.currentVersion,
      availableVersion: info.version
    })
  }

  private markProgress(progress: UpdateProgress): void {
    if (!this.availableVersion || this.state.status !== 'downloading') return
    const percent = Math.round(Math.min(100, finiteNonNegative(progress.percent)) * 10) / 10
    if (
      this.state.status === 'downloading' &&
      Math.floor(this.state.percent) === Math.floor(percent) &&
      percent < 100
    ) {
      return
    }
    const total = finiteNonNegative(progress.total)
    const transferred = finiteNonNegative(progress.transferred)
    this.setState({
      status: 'downloading',
      currentVersion: this.currentVersion,
      availableVersion: this.availableVersion,
      percent,
      transferred: total > 0 ? Math.min(transferred, total) : transferred,
      total,
      bytesPerSecond: finiteNonNegative(progress.bytesPerSecond)
    })
  }

  private fail(operation: AppUpdateOperation, error: unknown): AppUpdateState {
    this.logger.warn(`[updater] ${operation} failed`, error)
    const errorCode = classifyError(error)
    if (
      this.state.status === 'error' &&
      this.state.operation === operation &&
      this.state.error === errorCode
    ) {
      return this.state
    }
    return this.setState({
      status: 'error',
      currentVersion: this.currentVersion,
      operation,
      error: errorCode,
      ...(operation === 'install' && this.availableVersion
        ? { availableVersion: this.availableVersion }
        : {})
    })
  }

  private setState(state: AppUpdateState): AppUpdateState {
    this.state = state
    this.onStateChange(state)
    return state
  }
}
