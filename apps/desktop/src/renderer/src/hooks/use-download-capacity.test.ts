import { describe, expect, it, vi } from 'vitest'
import type { DownloadCapacity } from '@oh-my-huggingface/shared'

vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
})

const { downloadBlockedByCapacity, estimatedWriteBytes, isDiskCapacityError } =
  await import('./use-download-capacity')

function capacity(overrides: Partial<DownloadCapacity> = {}): DownloadCapacity {
  return {
    cacheDir: '/cache',
    freeBytes: 100,
    reservedBytes: 10,
    safetyReserveBytes: 10,
    availableBytes: 80,
    writeMultiplier: 1,
    checkedAt: '2026-08-25T00:00:00.000Z',
    ...overrides
  }
}

describe('download capacity helpers', () => {
  it('applies the platform write multiplier and blocks only known over-capacity writes', () => {
    const windows = capacity({ writeMultiplier: 2 })
    expect(estimatedWriteBytes(41, windows)).toBe(82)
    expect(downloadBlockedByCapacity(82, windows)).toBe(true)
    expect(downloadBlockedByCapacity(80, windows)).toBe(false)
    expect(downloadBlockedByCapacity(undefined, windows)).toBe(false)
    expect(downloadBlockedByCapacity(100, capacity({ availableBytes: undefined }))).toBe(false)
  })

  it('recognizes both preflight and filesystem no-space errors', () => {
    expect(isDiskCapacityError(new Error('download.diskInsufficient:42:41'))).toBe(true)
    expect(isDiskCapacityError(new Error('ENOSPC: no space left on device'))).toBe(true)
    expect(isDiskCapacityError(new Error('fetch failed'))).toBe(false)
  })
})
