export interface StartupFailureDeps {
  hasWindow: () => boolean
  showErrorBox: (title: string, content: string) => void
  exit: (code: number) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

/**
 * Startup threw before the main window existed, e.g. the SQLite native module
 * could not load on a system with an older glibc. Without this the process
 * lingers with no window and no explanation, so say why and exit.
 */
export function reportStartupFailure(error: unknown, deps: StartupFailureDeps): void {
  console.error('[startup] failed', error)
  // Past window creation the app is still partially usable; keep it running.
  if (deps.hasWindow()) return
  const reason = error instanceof Error ? error.message : String(error)
  deps.showErrorBox(deps.t('app.name'), deps.t('dialogs.startupFailureMessage', { reason }))
  deps.exit(1)
}
