import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repoCachePaths } from '@oh-my-huggingface/hub-api'
import { readCachedText, readCacheSnapshot } from './cache'

const COMMIT = 'b'.repeat(40)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function seed(): Promise<string> {
  const cacheDir = await mkdtemp(join(tmpdir(), 'omhf-cache-'))
  roots.push(cacheDir)
  const paths = repoCachePaths(cacheDir, 'model', 'org/repo')
  const file = join(paths.snapshotsDir, COMMIT, 'README.md')
  await mkdir(dirname(file), { recursive: true })
  await mkdir(paths.refsDir, { recursive: true })
  await writeFile(join(paths.refsDir, 'main'), COMMIT)
  await writeFile(file, '# hello cache\n')
  return cacheDir
}

describe('local cache snapshot reads', () => {
  it('lists the latest snapshot and reads README text', async () => {
    const cacheDir = await seed()
    const snapshot = await readCacheSnapshot(cacheDir, 'model', 'org/repo')
    expect(snapshot?.commit).toBe(COMMIT)
    expect(snapshot?.files.some((file) => file.path === 'README.md')).toBe(true)
    const text = await readCachedText(cacheDir, 'model', 'org/repo', 'README.md', 1024)
    expect(text?.content).toContain('hello cache')
    expect(text?.truncated).toBe(false)
  })

  it('reads only the requested prefix of a large cached file', async () => {
    const cacheDir = await seed()
    const paths = repoCachePaths(cacheDir, 'model', 'org/repo')
    const file = join(paths.snapshotsDir, COMMIT, 'big.txt')
    await writeFile(file, 'x'.repeat(2000))
    const text = await readCachedText(cacheDir, 'model', 'org/repo', 'big.txt', 10)
    expect(text?.content).toBe('x'.repeat(10))
    expect(text?.truncated).toBe(true)
    expect(text?.size).toBe(2000)
  })

  it('returns null for a repo that is not cached', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'omhf-cache-empty-'))
    roots.push(cacheDir)
    expect(await readCacheSnapshot(cacheDir, 'model', 'org/missing')).toBeNull()
    expect(await readCachedText(cacheDir, 'model', 'org/missing', 'README.md', 1024)).toBeNull()
  })
})
