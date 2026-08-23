import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationTask, UploadStartRequest } from '@oh-my-huggingface/shared'
import type { WebContents } from 'electron'
import type { NotificationService } from './notifications'
import {
  IntegrationTaskManager,
  scanUploadFolder,
  type IntegrationTaskDeps
} from './integration-tasks'
import { validateUploadManifest } from './integrations/upload'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omhf-integration-task-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function owner(id: number): WebContents {
  return { id, once: vi.fn() } as unknown as WebContents
}

function uploadRequest(selectionId: string): UploadStartRequest {
  return {
    selectionId,
    kind: 'model',
    name: 'safe-repo',
    private: true,
    acknowledgedWarningCodes: ['sensitive-path', 'large-upload']
  }
}

function makeManager(overrides: Partial<IntegrationTaskDeps> = {}): {
  manager: IntegrationTaskManager
  broadcasts: IntegrationTask[][]
  notify: ReturnType<typeof vi.fn>
} {
  const broadcasts: IntegrationTask[][] = []
  const notify = vi.fn()
  const manager = new IntegrationTaskManager({
    accessToken: () => 'hf_test',
    username: () => 'tester',
    cacheDir: () => '/unused-in-tests',
    broadcast: (tasks) => broadcasts.push(tasks),
    notifications: { show: notify } as unknown as NotificationService,
    ...overrides
  })
  return { manager, broadcasts, notify }
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('scanUploadFolder', () => {
  it('applies ignore files, excludes unsafe entries, and reports only relative sensitive paths', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'ignored-dir'))
    await mkdir(join(root, 'node_modules'))
    await mkdir(join(root, '.GIT'))
    await mkdir(join(root, 'nested', '.ssh'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'ignored.txt\nignored-dir/\n')
    await writeFile(join(root, '.hfignore'), '*.bin\n')
    await writeFile(join(root, 'kept.py'), 'print("safe")\n')
    await writeFile(join(root, 'ignored.txt'), 'ignored')
    await writeFile(join(root, 'ignored-dir', 'also.txt'), 'ignored')
    await writeFile(join(root, 'weights.bin'), 'ignored')
    await writeFile(join(root, 'node_modules', 'package.js'), 'ignored')
    await writeFile(join(root, '.GIT', 'config'), 'ignored')
    await writeFile(join(root, '.env.local'), 'TOKEN=secret')
    await writeFile(join(root, '.envrc'), 'TOKEN=secret')
    await writeFile(join(root, 'nested', '.ssh', 'id_ed25519'), 'secret')

    const outside = join(await tempRoot(), 'outside.txt')
    await writeFile(outside, 'outside')
    await symlink(outside, join(root, 'linked-secret'))

    const result = await scanUploadFolder(root)
    const paths = result.manifest.files.map((file) => file.relativePath)

    expect(paths).toContain('kept.py')
    expect(paths).not.toContain('ignored.txt')
    expect(paths).not.toContain('ignored-dir/also.txt')
    expect(paths).not.toContain('weights.bin')
    expect(paths).not.toContain('node_modules/package.js')
    expect(paths).not.toContain('.GIT/config')
    expect(paths).not.toContain('linked-secret')
    expect(result.excludedCount).toBeGreaterThanOrEqual(5)

    const warning = result.warnings.find((item) => item.code === 'sensitive-path')
    expect(warning?.paths).toEqual(
      expect.arrayContaining(['.env.local', '.envrc', 'nested/.ssh/id_ed25519'])
    )
    expect(warning?.paths?.every((path) => !path.startsWith(root))).toBe(true)
  })

  it('detects a selected file that was replaced before upload starts', async () => {
    const root = await tempRoot()
    const file = join(root, 'model.py')
    await writeFile(file, 'print(1)\n')
    const { manifest } = await scanUploadFolder(root)

    await rm(file)
    await writeFile(file, 'print(2)\n')
    const future = new Date(Date.now() + 10_000)
    await utimes(file, future, future)

    await expect(validateUploadManifest(manifest)).rejects.toThrow('selection-stale')
  })

  it('rejects an unreadable ignore entry instead of silently ignoring its rules', async () => {
    const root = await tempRoot()
    await mkdir(join(root, '.gitignore'))
    await writeFile(join(root, 'secret.txt'), 'secret')

    await expect(scanUploadFolder(root)).rejects.toThrow('upload.ignoreUnreadable')
  })

  it.runIf(process.platform !== 'win32')(
    'rejects names with Hub-ambiguous separators or control characters',
    async () => {
      const root = await tempRoot()
      await writeFile(join(root, 'unsafe\\name.py'), 'print(1)')
      await expect(scanUploadFolder(root)).rejects.toThrow('upload.invalidPath')
    }
  )

  it.runIf(process.platform !== 'win32')(
    'rejects special files instead of silently uploading',
    async () => {
      const root = await tempRoot()
      const socketPath = join(root, 'service.sock')
      const server = createServer()
      const listening = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false))
        server.listen(socketPath, () => resolve(true))
      })
      // Some managed macOS sandboxes prohibit AF_UNIX listeners. Linux CI still
      // exercises the special-file rejection with the same temp-only fixture.
      if (!listening) return
      try {
        await expect(scanUploadFolder(root)).rejects.toThrow('upload.specialFile')
      } finally {
        server.close()
        await once(server, 'close')
      }
    }
  )
})

describe('IntegrationTaskManager upload grants', () => {
  it('registers only one owner cleanup listener across repeated selections', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'README.md'), '# model\n')
    const sharedOwner = owner(10)
    const { manager } = makeManager({ selectUploadDirectory: async () => root })

    await manager.selectUploadFolder(sharedOwner)
    await manager.selectUploadFolder(sharedOwner)

    expect(sharedOwner.once).toHaveBeenCalledTimes(1)
  })

  it('does not retain a selection when its owner is destroyed during scanning', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'README.md'), '# model\n')
    let destroyed = false
    const scanningOwner = {
      id: 10,
      once: vi.fn(),
      isDestroyed: () => destroyed
    } as unknown as WebContents
    const { manager } = makeManager({
      selectUploadDirectory: async () => {
        destroyed = true
        return root
      }
    })

    await expect(manager.selectUploadFolder(scanningOwner)).resolves.toBeNull()
  })

  it('binds a selection to its owner without letting another owner revoke it', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'README.md'), '# model\n')
    const runUpload = vi.fn(async () => ({
      ok: true as const,
      repoId: 'tester/safe-repo',
      repoUrl: 'https://hub.example/tester/safe-repo',
      messageKey: 'upload.done',
      params: { repo: 'tester/safe-repo' }
    }))
    const { manager } = makeManager({
      selectUploadDirectory: async () => root,
      runUpload
    })
    const selection = await manager.selectUploadFolder(owner(10))
    expect(selection).not.toBeNull()

    expect(() => manager.startUpload(uploadRequest(selection!.selectionId), 11)).toThrow(
      'upload.selectionExpired'
    )
    const started = manager.startUpload(uploadRequest(selection!.selectionId), 10)
    expect(started.id).toBeTruthy()
    await flushTasks()
    expect(runUpload).toHaveBeenCalledOnce()

    expect(() => manager.startUpload(uploadRequest(selection!.selectionId), 10)).toThrow(
      'upload.selectionExpired'
    )
  })

  it('expires an unused one-time selection after fifteen minutes', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'README.md'), '# model\n')
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const { manager } = makeManager({
      now: () => now,
      selectUploadDirectory: async () => root,
      runUpload: vi.fn()
    })
    const selection = await manager.selectUploadFolder(owner(10))
    now += 15 * 60 * 1000 + 1

    expect(() => manager.startUpload(uploadRequest(selection!.selectionId), 10)).toThrow(
      'upload.selectionExpired'
    )
  })

  it('keeps the grant retryable until all sensitive-path warnings are acknowledged', async () => {
    const root = await tempRoot()
    await writeFile(join(root, '.env.production'), 'TOKEN=secret')
    const runUpload = vi.fn(async () => ({
      ok: true as const,
      repoId: 'tester/safe-repo',
      repoUrl: 'https://hub.example/tester/safe-repo',
      messageKey: 'upload.done',
      params: { repo: 'tester/safe-repo' }
    }))
    const { manager } = makeManager({ selectUploadDirectory: async () => root, runUpload })
    const selection = await manager.selectUploadFolder(owner(10))
    const request = uploadRequest(selection!.selectionId)
    request.acknowledgedWarningCodes = []

    expect(() => manager.startUpload(request, 10)).toThrow(
      'upload.warningNotAcknowledged:sensitive-path'
    )
    request.acknowledgedWarningCodes = ['sensitive-path']
    manager.startUpload(request, 10)
    await flushTasks()
    expect(runUpload).toHaveBeenCalledOnce()
  })
})

describe('IntegrationTaskManager export errors', () => {
  it('records a failed export so auto-export can surface already-running', () => {
    const { manager, broadcasts } = makeManager()
    manager.recordExportError(
      { tool: 'ollama', kind: 'model', repoId: 'org/repo', filePath: 'model.gguf' },
      new Error('export.alreadyRunning')
    )

    const task = manager.list().find((item) => item.kind === 'export')
    expect(task).toMatchObject({
      kind: 'export',
      status: 'error',
      phase: 'error',
      messageKey: 'export.alreadyRunning',
      filePath: 'model.gguf'
    })
    expect(broadcasts.at(-1)?.some((item) => item.id === task?.id)).toBe(true)
  })
})

describe('IntegrationTaskManager cancellation', () => {
  it('makes cancellation idempotent and prevents late progress or success from reviving the task', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'README.md'), '# model\n')
    let release!: () => void
    const runUpload: NonNullable<IntegrationTaskDeps['runUpload']> = async (_request, deps) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      deps.onProgress({ phase: 'uploading', progress: 0.8 })
      return {
        ok: true,
        repoId: 'tester/safe-repo',
        repoUrl: 'https://hub.example/tester/safe-repo',
        messageKey: 'upload.done',
        params: { repo: 'tester/safe-repo' }
      }
    }
    const { manager, notify } = makeManager({
      selectUploadDirectory: async () => root,
      runUpload
    })
    const selection = await manager.selectUploadFolder(owner(10))
    const { id } = manager.startUpload(uploadRequest(selection!.selectionId), 10)

    expect(manager.cancel(id, 'upload')).toEqual({ canceled: true })
    expect(manager.cancel(id, 'upload')).toEqual({ canceled: true })
    expect(manager.list().find((task) => task.id === id)?.status).toBe('canceled')

    release()
    await flushTasks()
    expect(manager.list().find((task) => task.id === id)).toMatchObject({
      status: 'canceled',
      phase: 'canceled'
    })
    expect(notify).not.toHaveBeenCalled()
  })
})
