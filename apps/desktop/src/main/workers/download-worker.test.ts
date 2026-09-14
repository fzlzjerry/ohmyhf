import type * as Fs from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Throttle,
  assertExpectedCommit,
  assertSafeCacheKey,
  assertSafeRepoFilePath,
  gitBlobSha1OfFile,
  prepareSafeCacheDirectories
} from './download-worker'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>()
  return { ...fs, existsSync: vi.fn(fs.existsSync) }
})

const roots: string[] = []

afterEach(() => {
  vi.mocked(existsSync).mockReset()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('assertExpectedCommit', () => {
  const COMMIT_A = '0123456789abcdef0123456789abcdef01234567'

  it('accepts the exact commit attested by the manager', () => {
    expect(assertExpectedCommit(COMMIT_A.toUpperCase(), COMMIT_A)).toBe(COMMIT_A)
  })

  it('rejects branch drift before the response can select a snapshot path', () => {
    expect(() =>
      assertExpectedCommit('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', COMMIT_A)
    ).toThrow('commit-mismatch')
  })

  it('rejects missing and malformed commit headers', () => {
    expect(() => assertExpectedCommit('', COMMIT_A)).toThrow('commit-mismatch')
    expect(() => assertExpectedCommit('../snapshots/escape', COMMIT_A)).toThrow('commit-mismatch')
  })
})

describe('cache path inputs', () => {
  it('accepts standard git and LFS object ids', () => {
    expect(assertSafeCacheKey('A'.repeat(40))).toBe('a'.repeat(40))
    expect(assertSafeCacheKey('b'.repeat(64))).toBe('b'.repeat(64))
  })

  it('rejects server-controlled cache path traversal', () => {
    expect(() => assertSafeCacheKey('../../outside')).toThrow('invalid-etag')
    expect(() => assertSafeRepoFilePath('../outside')).toThrow('unsafe-file-path')
    expect(() => assertSafeRepoFilePath('nested\\outside')).toThrow('unsafe-file-path')
  })

  it('creates only direct, validated cache directories', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-worker-cache-'))
    roots.push(cacheDir)
    const repoDir = join(cacheDir, 'models--org--repo')

    const result = prepareSafeCacheDirectories({
      cacheDir,
      repoDir,
      expectedCommit: 'a'.repeat(40),
      path: 'nested/model.bin'
    })

    const realRepo = realpathSync(repoDir)
    expect(result.blobsDir).toBe(join(realRepo, 'blobs'))
    expect(result.snapshotParent).toBe(join(realRepo, 'snapshots', 'a'.repeat(40), 'nested'))
  })

  it('can write a shard when another worker creates the repository before mkdir', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-worker-mkdir-race-'))
    roots.push(cacheDir)
    const repoDir = join(cacheDir, 'models--org--repo')
    vi.mocked(existsSync)
      .mockReturnValueOnce(true)
      .mockImplementationOnce((path) => {
        mkdirSync(path)
        return false
      })

    const result = prepareSafeCacheDirectories({
      cacheDir,
      repoDir,
      expectedCommit: 'a'.repeat(40),
      path: 'nested/model-00002-of-00033.gguf'
    })
    writeFileSync(join(result.snapshotParent, 'model-00002-of-00033.gguf'), 'shard payload')
    expect(
      readFileSync(
        join(repoDir, 'snapshots', 'a'.repeat(40), 'nested', 'model-00002-of-00033.gguf'),
        'utf8'
      )
    ).toBe('shard payload')
  })

  it.runIf(process.platform !== 'win32')(
    'rejects a symlink created during the same mkdir race',
    () => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'omh-worker-mkdir-link-race-'))
      roots.push(cacheDir)
      const outside = join(cacheDir, 'outside')
      mkdirSync(outside)
      vi.mocked(existsSync)
        .mockReturnValueOnce(true)
        .mockImplementationOnce((path) => {
          symlinkSync(outside, path, 'dir')
          return false
        })

      expect(() =>
        prepareSafeCacheDirectories({
          cacheDir,
          repoDir: join(cacheDir, 'models--org--repo'),
          expectedCommit: 'a'.repeat(40),
          path: 'model.gguf'
        })
      ).toThrow('unsafe-cache-layout:repository')
      expect(readdirSync(outside)).toEqual([])
    }
  )

  it.runIf(process.platform !== 'win32')(
    'rejects a repository symlink before any worker write',
    () => {
      const cacheDir = mkdtempSync(join(tmpdir(), 'omh-worker-cache-'))
      roots.push(cacheDir)
      const outside = join(cacheDir, 'outside')
      mkdirSync(outside)
      const repoDir = join(cacheDir, 'models--org--repo')
      symlinkSync(outside, repoDir, 'dir')

      expect(() =>
        prepareSafeCacheDirectories({
          cacheDir,
          repoDir,
          expectedCommit: 'a'.repeat(40),
          path: 'model.bin'
        })
      ).toThrow('unsafe-cache-layout:repository')
    }
  )
})

describe('Throttle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes bytes straight through when the limit is null', async () => {
    const throttle = new Throttle(null)
    await expect(throttle.take(10_000_000)).resolves.toBeUndefined()
  })

  it('sleeps when the rolling rate exceeds the limit', async () => {
    vi.useFakeTimers()
    const throttle = new Throttle(1000) // 1000 B/s → 2000 B should take ~2 s
    let resolved = false
    void throttle.take(2000).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(1900)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(resolved).toBe(true)
  })

  it('applies live rate updates in both directions', async () => {
    vi.useFakeTimers()
    const throttle = new Throttle(null)

    // Enabling a limit mid-flight starts throttling.
    throttle.setLimit(1000)
    let slow = false
    void throttle.take(1000).then(() => {
      slow = true
    })
    await vi.advanceTimersByTimeAsync(900)
    expect(slow).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(slow).toBe(true)

    // Raising the limit resets the window: the same volume now passes quickly.
    throttle.setLimit(1_000_000)
    let fast = false
    void throttle.take(1000).then(() => {
      fast = true
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(fast).toBe(true)
  })
})

describe('gitBlobSha1OfFile', () => {
  it('computes the git blob oid (blob <size>\\0 + content)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omh-worker-'))
    const file = join(dir, 'hello.txt')
    writeFileSync(file, 'hello\n')
    // `printf 'hello\n' | git hash-object --stdin`
    await expect(gitBlobSha1OfFile(file)).resolves.toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })
})
