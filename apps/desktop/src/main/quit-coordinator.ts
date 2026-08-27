/**
 * Serializes app teardown so window-close, tray-quit, and updater install share
 * one "we are leaving" flag and one cleanup pass.
 *
 * electron-updater's macOS quitAndInstall closes windows before `before-quit`.
 * If close-to-tray still intercepts those closes, or if `before-quit`
 * preventDefault's the Squirrel handshake, the UI vanishes and the process
 * stays in the dock.
 */
export class QuitCoordinator {
  private quitting = false
  private cleanupFinished = false
  private cleanupPromise: Promise<void> | null = null
  private readonly runCleanup: () => void | Promise<void>

  constructor(runCleanup: () => void | Promise<void>) {
    this.runCleanup = runCleanup
  }

  isQuitting(): boolean {
    return this.quitting
  }

  /** True once cleanup finished; `before-quit` may proceed without preventDefault. */
  canQuit(): boolean {
    return this.cleanupFinished
  }

  markQuitting(): void {
    this.quitting = true
  }

  /** Undo a failed update-install attempt so the UI and a later Restart can proceed. */
  reset(): void {
    this.quitting = false
    this.cleanupFinished = false
    this.cleanupPromise = null
  }

  beginCleanup(): Promise<void> {
    this.quitting = true
    if (this.cleanupPromise) return this.cleanupPromise
    const attempt = Promise.resolve()
      .then(() => this.runCleanup())
      .finally(() => {
        this.cleanupFinished = true
      })
    this.cleanupPromise = attempt
    // A rejected attempt must not be cached: UpdateManager retries prepareInstall.
    void attempt.catch(() => {
      if (this.cleanupPromise === attempt) this.cleanupPromise = null
    })
    return attempt
  }
}
