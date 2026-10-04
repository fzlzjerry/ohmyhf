import { afterEach, describe, expect, it, vi } from 'vitest'
import { MainI18n } from './i18n'
import { reportStartupFailure, type StartupFailureDeps } from './startup-failure'

function deps(hasWindow: boolean) {
  const i18n = new MainI18n()
  return {
    hasWindow: () => hasWindow,
    showErrorBox: vi.fn<StartupFailureDeps['showErrorBox']>(),
    exit: vi.fn<StartupFailureDeps['exit']>(),
    t: (key: string, vars?: Record<string, string | number>) => i18n.t(key, vars)
  }
}

describe('reportStartupFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('explains the failure and exits when no window was created', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps(false)
    const error = new Error(
      "/lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found (required by better_sqlite3.node)"
    )

    reportStartupFailure(error, d)

    expect(d.showErrorBox).toHaveBeenCalledTimes(1)
    expect(d.showErrorBox).toHaveBeenCalledWith(
      'Oh My HuggingFace',
      expect.stringContaining("version `GLIBC_2.38' not found")
    )
    expect(d.exit).toHaveBeenCalledWith(1)
  })

  it('reports non-Error rejections as text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps(false)

    reportStartupFailure('database is locked', d)

    expect(d.showErrorBox).toHaveBeenCalledWith(
      'Oh My HuggingFace',
      expect.stringContaining('database is locked')
    )
  })

  it('only logs once the main window exists', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps(true)

    reportStartupFailure(new Error('late failure'), d)

    expect(log).toHaveBeenCalled()
    expect(d.showErrorBox).not.toHaveBeenCalled()
    expect(d.exit).not.toHaveBeenCalled()
  })
})
