import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { repoCachePaths } from '@oh-my-huggingface/hub-api'
import { runExport } from './export'

const COMMIT = 'a'.repeat(40)
const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omhf-export-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function seedSnapshot(
  cacheDir: string,
  filePath: string,
  content: string | Buffer
): Promise<string> {
  const paths = repoCachePaths(cacheDir, 'model', 'org/repo')
  const source = join(paths.snapshotsDir, COMMIT, ...filePath.split('/'))
  await mkdir(dirname(source), { recursive: true })
  await mkdir(paths.refsDir, { recursive: true })
  await writeFile(join(paths.refsDir, 'main'), COMMIT)
  await writeFile(source, content)
  return source
}

describe('runExport file delivery', () => {
  it('uses an atomic hard link when source and destination share a filesystem', async () => {
    const workspace = await tempRoot()
    const cacheDir = join(workspace, 'cache')
    const homeDir = join(workspace, 'home')
    const source = await seedSnapshot(cacheDir, 'model.gguf', 'model bytes')
    const progress: Array<{ phase: string; progress?: number }> = []

    const result = await runExport('lmstudio', 'model', 'org/repo', 'model.gguf', {
      cacheDir,
      resolvedCommit: COMMIT,
      homeDir,
      signal: new AbortController().signal,
      onProgress: (event) => progress.push(event)
    })

    expect(result.ok).toBe(true)
    expect(result.outputPath).toBe(
      join(homeDir, '.lmstudio', 'models', 'org', 'repo', 'model.gguf')
    )
    expect((await stat(source)).ino).toBe((await stat(result.outputPath!)).ino)
    expect(progress).toContainEqual({ phase: 'copying', progress: 1 })
  })

  it('falls back to an atomic streamed copy and reports byte progress', async () => {
    const workspace = await tempRoot()
    const cacheDir = join(workspace, 'cache')
    const homeDir = join(workspace, 'home')
    await seedSnapshot(cacheDir, 'nested/model..gguf', Buffer.alloc(256 * 1024, 7))
    const progress: number[] = []
    const linkFile = vi.fn(async () => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    })

    const result = await runExport('lmstudio', 'model', 'org/repo', 'nested/model..gguf', {
      cacheDir,
      resolvedCommit: COMMIT,
      homeDir,
      signal: new AbortController().signal,
      linkFile,
      onProgress: (event) => {
        if (event.phase === 'copying' && event.progress !== undefined) {
          progress.push(event.progress)
        }
      }
    })

    expect(result.ok).toBe(true)
    expect(linkFile).toHaveBeenCalledOnce()
    expect((await readFile(result.outputPath!)).equals(Buffer.alloc(256 * 1024, 7))).toBe(true)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(1)
    expect(
      (await readdir(dirname(result.outputPath!))).some((name) => name.endsWith('.partial'))
    ).toBe(false)
  })

  it('removes a canceled partial and preserves a previous completed destination', async () => {
    const workspace = await tempRoot()
    const cacheDir = join(workspace, 'cache')
    const homeDir = join(workspace, 'home')
    await seedSnapshot(cacheDir, 'model.gguf', Buffer.alloc(4 * 1024 * 1024, 3))
    const destination = join(homeDir, '.lmstudio', 'models', 'org', 'repo', 'model.gguf')
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, 'previous completed output')
    const controller = new AbortController()

    const operation = runExport('lmstudio', 'model', 'org/repo', 'model.gguf', {
      cacheDir,
      resolvedCommit: COMMIT,
      homeDir,
      signal: controller.signal,
      linkFile: async () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
      },
      onProgress: (event) => {
        if (event.phase === 'copying' && event.progress && event.progress < 1) controller.abort()
      }
    })

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readFile(destination, 'utf8')).toBe('previous completed output')
    expect((await readdir(dirname(destination))).some((name) => name.endsWith('.partial'))).toBe(
      false
    )
  })

  it('rejects traversal and absolute paths without touching the destination', async () => {
    const workspace = await tempRoot()
    const deps = {
      cacheDir: join(workspace, 'cache'),
      resolvedCommit: COMMIT,
      homeDir: join(workspace, 'home'),
      signal: new AbortController().signal,
      onProgress: vi.fn()
    }

    await expect(
      runExport('lmstudio', 'model', 'org/repo', '../secret', deps)
    ).resolves.toMatchObject({
      ok: false,
      messageKey: 'export.invalidPath'
    })
    await expect(
      runExport('lmstudio', 'model', 'org/repo', 'C:\\secret.gguf', deps)
    ).resolves.toMatchObject({ ok: false, messageKey: 'export.invalidPath' })
    expect(deps.onProgress).not.toHaveBeenCalled()
  })

  it('terminates an in-flight Ollama import through AbortSignal', async () => {
    const workspace = await tempRoot()
    const cacheDir = join(workspace, 'cache')
    const homeDir = join(workspace, 'home')
    await seedSnapshot(cacheDir, 'model.gguf', 'model bytes')
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })

    const operation = runExport('ollama', 'model', 'org/repo', 'model.gguf', {
      cacheDir,
      resolvedCommit: COMMIT,
      homeDir,
      tempDir: workspace,
      signal: controller.signal,
      onProgress: vi.fn(),
      ollamaBinary: join(workspace, 'fake-ollama'),
      runOllama: (_binary, _args, options) =>
        new Promise((_resolve, reject) => {
          markStarted()
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        })
    })
    await started
    controller.abort()

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  })
})
