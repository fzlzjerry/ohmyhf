import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
  it('lists an exact snapshot and reads README text', async () => {
    const cacheDir = await seed()
    const snapshot = await readCacheSnapshot(cacheDir, 'model', 'org/repo', COMMIT)
    expect(snapshot?.commit).toBe(COMMIT)
    expect(snapshot?.files.some((file) => file.path === 'README.md')).toBe(true)
    const text = await readCachedText(cacheDir, 'model', 'org/repo', 'README.md', 1024, COMMIT)
    expect(text?.content).toContain('hello cache')
    expect(text?.truncated).toBe(false)
  })

  it('reads only the requested prefix of a large cached file', async () => {
    const cacheDir = await seed()
    const paths = repoCachePaths(cacheDir, 'model', 'org/repo')
    const file = join(paths.snapshotsDir, COMMIT, 'big.txt')
    await writeFile(file, 'x'.repeat(2000))
    const text = await readCachedText(cacheDir, 'model', 'org/repo', 'big.txt', 10, COMMIT)
    expect(text?.content).toBe('x'.repeat(10))
    expect(text?.truncated).toBe(true)
    expect(text?.size).toBe(2000)
  })

  it('reads the addressed revision without inspecting unrelated snapshots', async () => {
    const cacheDir = await seed()
    const paths = repoCachePaths(cacheDir, 'model', 'org/repo')
    await writeFile(join(paths.snapshotsDir, 'unrelated-incomplete-snapshot'), 'not a directory')

    const snapshot = await readCacheSnapshot(cacheDir, 'model', 'org/repo', COMMIT)
    expect(snapshot?.files).toEqual([{ path: 'README.md', size: 14 }])
    const text = await readCachedText(cacheDir, 'model', 'org/repo', 'README.md', 1024, COMMIT)
    expect(text?.content).toBe('# hello cache\n')
    expect(await readCacheSnapshot(cacheDir, 'model', 'org/repo', 'c'.repeat(40))).toBeNull()
  })

  it('rejects a requested snapshot redirected by a directory symlink', async () => {
    const cacheDir = await seed()
    const paths = repoCachePaths(cacheDir, 'model', 'org/repo')
    const redirectedCommit = 'c'.repeat(40)
    await symlink(
      join(paths.snapshotsDir, COMMIT),
      join(paths.snapshotsDir, redirectedCommit),
      'junction'
    )

    await expect(
      readCacheSnapshot(cacheDir, 'model', 'org/repo', redirectedCommit)
    ).rejects.toThrow('symbolic link or junction')
    await expect(
      readCachedText(cacheDir, 'model', 'org/repo', 'README.md', 1024, redirectedCommit)
    ).rejects.toThrow('symbolic link or junction')
  })

  it('returns null for a repo that is not cached', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'omhf-cache-empty-'))
    roots.push(cacheDir)
    expect(await readCacheSnapshot(cacheDir, 'model', 'org/missing', COMMIT)).toBeNull()
    expect(
      await readCachedText(cacheDir, 'model', 'org/missing', 'README.md', 1024, COMMIT)
    ).toBeNull()
  })
})
