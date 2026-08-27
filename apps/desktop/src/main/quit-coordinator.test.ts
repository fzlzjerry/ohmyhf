import { describe, expect, it } from 'vitest'
import { QuitCoordinator } from './quit-coordinator'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('QuitCoordinator', () => {
  it('runs cleanup once and then allows quit', async () => {
    let calls = 0
    const quit = new QuitCoordinator(() => {
      calls += 1
    })

    expect(quit.isQuitting()).toBe(false)
    expect(quit.canQuit()).toBe(false)

    const first = quit.beginCleanup()
    const second = quit.beginCleanup()
    expect(first).toBe(second)
    expect(quit.isQuitting()).toBe(true)

    await first
    expect(calls).toBe(1)
    expect(quit.canQuit()).toBe(true)
  })

  it('marks quitting immediately even while cleanup is still running', async () => {
    const gate = deferred()
    const quit = new QuitCoordinator(() => gate.promise)

    const pending = quit.beginCleanup()
    expect(quit.isQuitting()).toBe(true)
    expect(quit.canQuit()).toBe(false)

    gate.resolve()
    await pending
    expect(quit.canQuit()).toBe(true)
  })

  it('still allows quit if cleanup throws so the process cannot get stuck', async () => {
    const quit = new QuitCoordinator(() => {
      throw new Error('boom')
    })

    await expect(quit.beginCleanup()).rejects.toThrow('boom')
    expect(quit.isQuitting()).toBe(true)
    expect(quit.canQuit()).toBe(true)
  })

  it('lets markQuitting flip the flag before cleanup starts', () => {
    const quit = new QuitCoordinator(() => undefined)
    quit.markQuitting()
    expect(quit.isQuitting()).toBe(true)
    expect(quit.canQuit()).toBe(false)
  })
})
