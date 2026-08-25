import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { repoCachePaths } from '@oh-my-huggingface/hub-api'
import { computeSpeedShare } from '@oh-my-huggingface/shared'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))

import {
  DOWNLOAD_SPACE_RESERVE_BYTES,
  DownloadManager,
  buildFrozenResolveUrl,
  classifyDownloadError,
  estimateRequiredDownloadBytes,
  isResolvedCommit,
  isSafeRepoFilePath
} from './downloads'

const COMMIT_A = '0123456789abcdef0123456789abcdef01234567'
const COMMIT_B = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

interface PersistCall extends Record<string, unknown> {
  id: string
}

class FakeDatabase {
  readonly writes: PersistCall[] = []

  constructor(private readonly rows: Record<string, unknown>[] = []) {}

  prepare(sql: string): {
    all: () => Record<string, unknown>[]
    run: (params?: PersistCall | string) => void
  } {
    if (sql.includes('SELECT * FROM downloads')) {
      return { all: () => this.rows, run: () => undefined }
    }
    if (sql.includes('INSERT INTO downloads')) {
      return {
        all: () => [],
        run: (params) => {
          if (params && typeof params !== 'string') this.writes.push({ ...params })
        }
      }
    }
    return { all: () => [], run: () => undefined }
  }

  transaction<T>(fn: () => T): () => T {
    return () => fn()
  }
}

function createSettings(
  overrides: Partial<{
    downloadConcurrency: number
    speedLimitBps: number | null
    hfCacheDir: string | null
    proxyUrl: string | null
  }> = {}
) {
  const value = {
    downloadConcurrency: 0,
    speedLimitBps: null,
    hfCacheDir: '/tmp/omh-download-test-cache',
    proxyUrl: 'http://127.0.0.1:7890',
    ...overrides
  }
  return { get: () => value }
}

function createHub() {
  return {
    baseUrl: 'https://hub.example.test',
    getRepoRefs: vi.fn().mockResolvedValue({
      branches: [
        {
          name: 'main',
          ref: 'refs/heads/main',
          targetCommit: COMMIT_A,
          type: 'branch',
          isDefault: true
        }
      ],
      tags: [],
      pullRequests: [],
      defaultBranch: 'main'
    }),
    getRepoDetail: vi.fn().mockResolvedValue({ sha: COMMIT_A }),
    getFileTree: vi
      .fn()
      .mockResolvedValue([
        { type: 'file', path: 'weights.bin', size: 42, lfs: { oid: 'f'.repeat(64), size: 42 } }
      ])
  }
}

function createManager(
  db: FakeDatabase,
  hub = createHub(),
  settings = createSettings(),
  onPostAction?: ConstructorParameters<typeof DownloadManager>[7],
  storageDeps?: ConstructorParameters<typeof DownloadManager>[8]
): DownloadManager {
  return new DownloadManager(
    db as never,
    settings as never,
    hub as never,
    { show: vi.fn() } as never,
    () => 'hf_test',
    vi.fn(),
    undefined,
    onPostAction,
    storageDeps
  )
}

function persistedCompletedPostActionRow(
  status: 'pending' | 'running' | 'waiting-confirmation' | 'waiting-runtime' | 'error' = 'pending'
): Record<string, unknown> {
  return {
    id: 'post-action-task',
    repo_id: 'org/repo',
    kind: 'model',
    revision: 'v1',
    resolved_commit: COMMIT_A,
    endpoint: 'https://hub.example.test',
    proxy_url: null,
    cache_dir: '/tmp/omh-download-test-cache',
    environment_version: 1,
    status: 'completed',
    total_bytes: 42,
    received_bytes: 42,
    files_json: JSON.stringify([
      {
        path: 'model.gguf',
        size: 42,
        receivedBytes: 42,
        status: 'completed',
        verified: true,
        localSha256: 'c'.repeat(64)
      }
    ]),
    error: null,
    error_code: null,
    post_action_json: JSON.stringify({
      version: 1,
      status,
      request: {
        kind: 'local-run',
        runtime: 'llama.cpp',
        filePath: 'model.gguf',
        contextLength: 4096,
        maxTokens: 512,
        temperature: 0.7,
        securityAcknowledgement: {
          fingerprint: `sha256:${'d'.repeat(64)}`,
          binding: `sha256:${'b'.repeat(64)}`,
          acceptedAt: '2026-08-24T00:00:00.000Z'
        }
      }
    }),
    security_ack_json: JSON.stringify({
      fingerprint: `sha256:${'d'.repeat(64)}`,
      binding: `sha256:${'b'.repeat(64)}`,
      acceptedAt: '2026-08-24T00:00:00.000Z'
    }),
    created_at: '2026-08-24T00:00:00.000Z',
    completed_at: '2026-08-24T00:01:00.000Z'
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('download environment helpers', () => {
  it('accepts only immutable 40-hex commits', () => {
    expect(isResolvedCommit(COMMIT_A)).toBe(true)
    expect(isResolvedCommit(COMMIT_A.toUpperCase())).toBe(true)
    expect(isResolvedCommit('main')).toBe(false)
    expect(isResolvedCommit('../escape')).toBe(false)
  })

  it('builds a commit-pinned URL on the frozen endpoint', () => {
    expect(
      buildFrozenResolveUrl(
        'https://hub.example.test/',
        'dataset',
        'org/repo',
        COMMIT_A,
        'data/a b.json'
      )
    ).toBe(`https://hub.example.test/datasets/org/repo/resolve/${COMMIT_A}/data/a%20b.json`)
  })

  it('rejects file-tree paths that could escape a snapshot', () => {
    expect(isSafeRepoFilePath('src/model.py')).toBe(true)
    expect(isSafeRepoFilePath('../outside')).toBe(false)
    expect(isSafeRepoFilePath('src\\outside')).toBe(false)
  })
})

describe('DownloadManager frozen environment', () => {
  it('discovers the actual default branch when the caller omits a reference', async () => {
    vi.useFakeTimers()
    const hub = createHub()
    hub.getRepoRefs.mockResolvedValueOnce({
      branches: [
        {
          name: 'trunk',
          ref: 'refs/heads/trunk',
          targetCommit: COMMIT_A,
          type: 'branch',
          isDefault: true
        }
      ],
      tags: [],
      pullRequests: [],
      defaultBranch: 'trunk'
    })
    const manager = createManager(new FakeDatabase(), hub)

    const tasks = await manager.start({ repoId: 'org/repo', kind: 'model' })

    expect(hub.getRepoDetail).toHaveBeenCalledWith('model', 'org/repo', 'trunk')
    expect(tasks[0]).toMatchObject({ revision: 'trunk', resolvedCommit: COMMIT_A })
    manager.shutdown()
  })

  it('resolves the revision first, then enumerates the tree at that commit', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    const manager = createManager(db, hub)

    const tasks = await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })

    expect(hub.getRepoDetail).toHaveBeenCalledWith('model', 'org/repo', 'main')
    expect(hub.getFileTree).toHaveBeenCalledWith('model', 'org/repo', COMMIT_A, '', {
      recursive: true
    })
    expect(tasks[0]).toMatchObject({ revision: 'main', resolvedCommit: COMMIT_A, resumable: true })
    expect(tasks[0]).not.toHaveProperty('environment')
    expect(tasks[0]).not.toHaveProperty('endpoint')
    expect(tasks[0]).not.toHaveProperty('proxyUrl')
    expect(tasks[0]).not.toHaveProperty('cacheDir')
    expect(db.writes.at(-1)).toMatchObject({
      resolvedCommit: COMMIT_A,
      endpoint: 'https://hub.example.test',
      proxyUrl: 'http://127.0.0.1:7890',
      cacheDir: '/tmp/omh-download-test-cache',
      environmentVersion: 1
    })
    manager.shutdown()
  })

  it('attaches autoExport to a covered same-environment task', async () => {
    vi.useFakeTimers()
    const manager = createManager(new FakeDatabase())
    await manager.start({ repoId: 'org/repo', kind: 'model', files: ['weights.bin'] })
    await manager.start({
      repoId: 'org/repo',
      kind: 'model',
      files: ['weights.bin'],
      autoExport: { tool: 'ollama', filePath: 'weights.bin' }
    })

    const internals = manager as unknown as {
      tasks: Map<string, { autoExport?: { tool: string; filePath: string } }>
    }
    const tasks = [...internals.tasks.values()]
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.autoExport).toEqual({ tool: 'ollama', filePath: 'weights.bin' })
    manager.shutdown()
  })

  it('attaches autoExport only to a same-environment in-flight task', async () => {
    vi.useFakeTimers()
    const settings = createSettings()
    const hub = createHub()
    const manager = createManager(new FakeDatabase(), hub, settings)

    await manager.start({ repoId: 'org/repo', kind: 'model', files: ['weights.bin'] })
    hub.baseUrl = 'https://other-hub.example.test'
    settings.get().hfCacheDir = '/tmp/omh-other-cache'
    await manager.start({ repoId: 'org/repo', kind: 'model', files: ['weights.bin'] })
    await manager.start({
      repoId: 'org/repo',
      kind: 'model',
      files: ['weights.bin'],
      autoExport: { tool: 'ollama', filePath: 'weights.bin' }
    })

    const internals = manager as unknown as {
      tasks: Map<
        string,
        { environment?: { endpoint: string }; autoExport?: { tool: string; filePath: string } }
      >
    }
    const tasks = [...internals.tasks.values()]
    const original = tasks.find((task) => task.environment?.endpoint === 'https://hub.example.test')
    const other = tasks.find(
      (task) => task.environment?.endpoint === 'https://other-hub.example.test'
    )
    expect(original?.autoExport).toBeUndefined()
    expect(other?.autoExport).toEqual({ tool: 'ollama', filePath: 'weights.bin' })
    manager.shutdown()
  })

  it('does not deduplicate the same branch after it moves to a new commit', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    hub.getRepoDetail
      .mockResolvedValueOnce({ sha: COMMIT_A })
      .mockResolvedValueOnce({ sha: COMMIT_B })
    const manager = createManager(db, hub)

    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const tasks = await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })

    expect(tasks.map((task) => task.resolvedCommit).sort()).toEqual([COMMIT_A, COMMIT_B].sort())
    manager.shutdown()
  })

  it('resumes with the frozen endpoint after the applied endpoint changes', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    const manager = createManager(db, hub)
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const id = manager.list()[0]!.id
    manager.pause(id)
    hub.baseUrl = 'https://another-hub.example.test'

    const resumed = manager.resume(id).find((task) => task.id === id)

    expect(resumed).toMatchObject({
      status: 'queued',
      resolvedCommit: COMMIT_A,
      resumable: true
    })
    expect(resumed?.errorCode).toBeUndefined()
    manager.shutdown()
  })

  it('flushes every dirty task in one timer window instead of only the first', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const hub = createHub()
    hub.getRepoDetail
      .mockResolvedValueOnce({ sha: COMMIT_A })
      .mockResolvedValueOnce({ sha: COMMIT_B })
    const manager = createManager(db, hub)
    await manager.start({ repoId: 'org/a', kind: 'model' })
    await manager.start({ repoId: 'org/b', kind: 'model' })
    const internals = manager as unknown as {
      tasks: Map<string, unknown>
      schedulePersist: (task: unknown) => void
    }
    const tasks = [...internals.tasks.values()]
    db.writes.length = 0

    for (const task of tasks) internals.schedulePersist(task)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(new Set(db.writes.map((write) => write.id))).toEqual(
      new Set(tasks.map((task) => (task as { id: string }).id))
    )
    manager.shutdown()
  })

  it('applies bulk pause, resume, completed cleanup, and clear actions', async () => {
    vi.useFakeTimers()
    const manager = createManager(new FakeDatabase())
    await manager.start({ repoId: 'org/a', kind: 'model' })
    await manager.start({ repoId: 'org/b', kind: 'model' })

    expect(manager.pauseAll().every((task) => task.status === 'paused')).toBe(true)
    expect(manager.resumeAll().every((task) => task.status === 'queued')).toBe(true)

    const internals = manager as unknown as {
      tasks: Map<string, { status: string }>
    }
    const first = [...internals.tasks.values()][0]!
    first.status = 'completed'
    expect(manager.clearCompleted()).toHaveLength(1)
    expect(manager.clearAll()).toHaveLength(0)
    manager.shutdown()
  })

  it('waits for an old worker to exit before pumping an immediate resume', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const settings = createSettings()
    const manager = createManager(db, createHub(), settings)
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const internals = manager as unknown as {
      tasks: Map<
        string,
        {
          id: string
          status: string
          files: Array<{ path: string; status: string }>
        }
      >
      workers: Map<
        string,
        {
          postMessage: ReturnType<typeof vi.fn>
          removeAllListeners: ReturnType<typeof vi.fn>
          terminate: ReturnType<typeof vi.fn>
        }
      >
      stoppingTasks: Map<string, Promise<unknown>>
    }
    const task = [...internals.tasks.values()][0]!
    const file = task.files[0]!
    task.status = 'running'
    file.status = 'running'
    let finishTermination!: () => void
    const terminated = new Promise<void>((resolve) => {
      finishTermination = resolve
    })
    const worker = {
      postMessage: vi.fn(),
      removeAllListeners: vi.fn(),
      terminate: vi.fn(() => terminated)
    }
    internals.workers.set(`${task.id} ${file.path}`, worker)
    settings.get().downloadConcurrency = 1

    manager.pause(task.id)
    manager.resume(task.id)

    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(internals.stoppingTasks.has(task.id)).toBe(true)
    expect(internals.workers.size).toBe(0)
    const stopping = internals.stoppingTasks.get(task.id)!
    settings.get().downloadConcurrency = 0
    finishTermination()
    await stopping
    expect(internals.stoppingTasks.has(task.id)).toBe(false)
    manager.shutdown()
  })

  it('publishes the revision ref only after every file completes', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-ref-'))
    const db = new FakeDatabase()
    const manager = createManager(db, createHub(), createSettings({ hfCacheDir: cacheDir }))
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const { repoDir, refsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(repoDir)
    const refPath = join(refsDir, 'main')
    expect(existsSync(refPath)).toBe(false)

    const internals = manager as unknown as {
      tasks: Map<string, { files: Array<{ status: string; receivedBytes: number; size: number }> }>
      settleTask: (task: unknown) => void
    }
    const task = [...internals.tasks.values()][0]!
    for (const file of task.files) {
      file.status = 'completed'
      file.receivedBytes = file.size
    }
    internals.settleTask(task)

    expect(readFileSync(refPath, 'utf8')).toBe(COMMIT_A)
    expect(manager.list()[0]).toMatchObject({ status: 'completed', resumable: false })
    manager.shutdown()
  })

  it('does not let an older branch resolution overwrite the newest revision ref', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-ref-order-'))
    const hub = createHub()
    hub.getRepoDetail
      .mockResolvedValueOnce({ sha: COMMIT_A })
      .mockResolvedValueOnce({ sha: COMMIT_B })
    const manager = createManager(new FakeDatabase(), hub, createSettings({ hfCacheDir: cacheDir }))
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const { repoDir, refsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(repoDir)
    const internals = manager as unknown as {
      tasks: Map<
        string,
        {
          resolvedCommit: string
          files: Array<{ status: string; receivedBytes: number; size: number }>
        }
      >
      settleTask: (task: unknown) => void
    }
    const tasks = [...internals.tasks.values()]
    const older = tasks.find((task) => task.resolvedCommit === COMMIT_A)!
    const newer = tasks.find((task) => task.resolvedCommit === COMMIT_B)!
    for (const task of [newer, older]) {
      for (const file of task.files) {
        file.status = 'completed'
        file.receivedBytes = file.size
      }
      internals.settleTask(task)
    }

    expect(readFileSync(join(refsDir, 'main'), 'utf8')).toBe(COMMIT_B)
    manager.shutdown()
  })

  it('orders branch aliases by request start even when the older file tree returns last', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-ref-concurrent-'))
    const hub = createHub()
    hub.getRepoDetail
      .mockResolvedValueOnce({ sha: COMMIT_A })
      .mockResolvedValueOnce({ sha: COMMIT_B })
    const tree = [
      {
        type: 'file' as const,
        path: 'weights.bin',
        size: 42,
        lfs: { oid: 'f'.repeat(64), size: 42 }
      }
    ]
    let releaseSlowTree!: () => void
    let markSlowTreeStarted!: () => void
    const slowTreeStarted = new Promise<void>((resolve) => {
      markSlowTreeStarted = resolve
    })
    const slowTree = new Promise<typeof tree>((resolve) => {
      releaseSlowTree = () => resolve(tree)
    })
    hub.getFileTree
      .mockImplementationOnce(() => {
        markSlowTreeStarted()
        return slowTree
      })
      .mockResolvedValueOnce(tree)
    const manager = createManager(new FakeDatabase(), hub, createSettings({ hfCacheDir: cacheDir }))

    const olderStart = manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    await slowTreeStarted
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    releaseSlowTree()
    await olderStart

    const { repoDir, refsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(repoDir)
    const internals = manager as unknown as {
      tasks: Map<
        string,
        {
          resolvedCommit: string
          files: Array<{ status: string; receivedBytes: number; size: number }>
        }
      >
      settleTask: (task: unknown) => void
    }
    const tasks = [...internals.tasks.values()]
    const newer = tasks.find((task) => task.resolvedCommit === COMMIT_B)!
    const older = tasks.find((task) => task.resolvedCommit === COMMIT_A)!
    for (const task of [newer, older]) {
      for (const file of task.files) {
        file.status = 'completed'
        file.receivedBytes = file.size
      }
      internals.settleTask(task)
    }

    expect(readFileSync(join(refsDir, 'main'), 'utf8')).toBe(COMMIT_B)
    manager.shutdown()
  })

  it('refuses to publish a revision ref through a symlinked refs directory', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-ref-link-'))
    const outside = mkdtempSync(join(tmpdir(), 'omh-download-ref-outside-'))
    const db = new FakeDatabase()
    const manager = createManager(db, createHub(), createSettings({ hfCacheDir: cacheDir }))
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const { repoDir, refsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(repoDir)
    symlinkSync(outside, refsDir, process.platform === 'win32' ? 'junction' : 'dir')

    const internals = manager as unknown as {
      tasks: Map<string, { files: Array<{ status: string; receivedBytes: number; size: number }> }>
      settleTask: (task: unknown) => void
    }
    const task = [...internals.tasks.values()][0]!
    for (const file of task.files) {
      file.status = 'completed'
      file.receivedBytes = file.size
    }
    internals.settleTask(task)

    expect(existsSync(join(outside, 'main'))).toBe(false)
    expect(manager.list()[0]).toMatchObject({
      status: 'error',
      errorCode: 'integrity',
      resumable: false
    })
    expect(manager.protectedTaskIds()).not.toContain(manager.list()[0]!.id)
    manager.shutdown()
  })

  it('cleans only partials with the exact task-owned file name', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-partials-'))
    const manager = createManager(
      new FakeDatabase(),
      createHub(),
      createSettings({ hfCacheDir: cacheDir })
    )
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const internals = manager as unknown as {
      tasks: Map<string, { id: string }>
      deleteTaskPartials: (task: unknown) => Promise<void>
    }
    const task = [...internals.tasks.values()][0]!
    const { blobsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(blobsDir, { recursive: true })
    const owned = join(blobsDir, `${'a'.repeat(64)}.incomplete.${task.id}-12345678`)
    const decoy = join(blobsDir, `${'b'.repeat(64)}.incomplete.${task.id}extra-12345678`)
    writeFileSync(owned, 'owned')
    writeFileSync(decoy, 'decoy')

    await internals.deleteTaskPartials(task)

    expect(existsSync(owned)).toBe(false)
    expect(existsSync(decoy)).toBe(true)
    manager.shutdown()
  })

  it('ignores a delayed settlement after a task has been removed', async () => {
    vi.useFakeTimers()
    const db = new FakeDatabase()
    const manager = createManager(db)
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const internals = manager as unknown as {
      tasks: Map<string, { id: string }>
      settleTask: (task: unknown) => void
    }
    const task = [...internals.tasks.values()][0]!
    manager.remove(task.id)
    const writesAfterRemove = db.writes.length

    internals.settleTask(task)

    expect(manager.list()).toHaveLength(0)
    expect(db.writes).toHaveLength(writesAfterRemove)
    manager.shutdown()
  })

  it('keeps legacy in-flight rows visible but non-resumable', () => {
    const db = new FakeDatabase([
      {
        id: 'legacy',
        repo_id: 'org/repo',
        kind: 'model',
        revision: 'main',
        resolved_commit: null,
        endpoint: null,
        proxy_url: null,
        cache_dir: null,
        environment_version: null,
        status: 'paused',
        total_bytes: 1,
        received_bytes: 0,
        files_json: JSON.stringify([{ path: 'a', size: 1, receivedBytes: 0, status: 'paused' }]),
        error: null,
        error_code: null,
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: null
      }
    ])
    const manager = createManager(db)

    expect(manager.list()[0]).toMatchObject({
      id: 'legacy',
      status: 'error',
      errorCode: 'legacy-task',
      resumable: false
    })
    manager.shutdown()
  })

  it('restores a pending one-click run after restart and removes it only after success', async () => {
    const db = new FakeDatabase([persistedCompletedPostActionRow()])
    const onPostAction = vi.fn().mockResolvedValue(undefined)
    const manager = createManager(db, createHub(), createSettings(), onPostAction)

    expect(manager.list()[0]?.postAction).toMatchObject({
      runtime: 'llama.cpp',
      filePath: 'model.gguf',
      status: 'pending'
    })
    manager.resumePendingPostActions()
    await vi.waitFor(() => expect(onPostAction).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(manager.list()[0]?.postAction).toBeUndefined())
    expect(onPostAction).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'org/repo',
        revision: 'v1',
        resolvedCommit: COMMIT_A,
        filePath: 'model.gguf'
      })
    )
    expect(db.writes.at(-1)?.postActionJson).toBeNull()
    manager.shutdown()
  })

  it('converts a persisted running action to pending because no process survives restart', () => {
    const manager = createManager(
      new FakeDatabase([persistedCompletedPostActionRow('running')]),
      createHub(),
      createSettings(),
      vi.fn().mockResolvedValue(undefined)
    )
    expect(manager.list()[0]?.postAction?.status).toBe('pending')
    manager.shutdown()
  })

  it('pauses on changed security evidence until exact reauthorization, then retries once', async () => {
    const db = new FakeDatabase([persistedCompletedPostActionRow()])
    const onPostAction = vi
      .fn()
      .mockRejectedValueOnce(new Error('security.evidenceChanged'))
      .mockResolvedValueOnce(undefined)
    const manager = createManager(db, createHub(), createSettings(), onPostAction)

    manager.resumePendingPostActions()
    await vi.waitFor(() =>
      expect(manager.list()[0]?.postAction).toMatchObject({
        status: 'waiting-confirmation',
        error: 'security.evidenceChanged'
      })
    )
    manager.retryPostAction('post-action-task')
    expect(onPostAction).toHaveBeenCalledTimes(1)
    expect(manager.postActionSecurityRequest('post-action-task')).toEqual({
      action: 'local-run',
      kind: 'model',
      repoId: 'org/repo',
      revision: 'v1',
      resolvedCommit: COMMIT_A,
      files: ['model.gguf']
    })

    manager.reauthorizePostAction('post-action-task', {
      fingerprint: `sha256:${'e'.repeat(64)}`,
      binding: `sha256:${'c'.repeat(64)}`,
      acceptedAt: '2026-08-24T01:00:00.000Z'
    })
    await vi.waitFor(() => expect(onPostAction).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(manager.list()[0]?.postAction).toBeUndefined())
    manager.shutdown()
  })

  it('persists explicit fit confirmation before retrying a queued local run', async () => {
    const db = new FakeDatabase([persistedCompletedPostActionRow()])
    const onPostAction = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime.fitConfirmationRequired:unknown'))
      .mockResolvedValueOnce(undefined)
    const manager = createManager(db, createHub(), createSettings(), onPostAction)

    manager.resumePendingPostActions()
    await vi.waitFor(() =>
      expect(manager.list()[0]?.postAction).toMatchObject({
        status: 'waiting-confirmation',
        error: 'runtime.fitConfirmationRequired:unknown'
      })
    )
    manager.reauthorizePostAction(
      'post-action-task',
      {
        fingerprint: `sha256:${'e'.repeat(64)}`,
        binding: `sha256:${'c'.repeat(64)}`,
        acceptedAt: '2026-08-24T01:00:00.000Z'
      },
      true
    )
    await vi.waitFor(() => expect(onPostAction).toHaveBeenCalledTimes(2))
    expect(onPostAction.mock.calls[1]?.[0]).toMatchObject({ allowTightFit: true })
    manager.shutdown()
  })

  it('keeps completed tasks with an unresolved post-action during completed cleanup', () => {
    const manager = createManager(
      new FakeDatabase([persistedCompletedPostActionRow('waiting-runtime')]),
      createHub(),
      createSettings(),
      vi.fn().mockResolvedValue(undefined)
    )
    expect(manager.clearCompleted()).toHaveLength(1)
    expect(manager.list()[0]?.postAction?.status).toBe('waiting-runtime')
    manager.shutdown()
  })
})

describe('computeSpeedShare', () => {
  it('returns null (unlimited) when no limit is configured', () => {
    expect(computeSpeedShare(null, 3)).toBeNull()
    expect(computeSpeedShare(undefined, 3)).toBeNull()
    expect(computeSpeedShare(0, 3)).toBeNull()
  })

  it('splits the aggregate limit evenly across workers', () => {
    expect(computeSpeedShare(3_000_000, 3)).toBe(1_000_000)
    expect(computeSpeedShare(3_000_000, 1)).toBe(3_000_000)
    expect(computeSpeedShare(1_000_000, 3)).toBe(333_333)
  })

  it('treats zero workers as one and floors at 1 B/s', () => {
    expect(computeSpeedShare(500, 0)).toBe(500)
    expect(computeSpeedShare(2, 4)).toBe(1)
  })
})

describe('DownloadManager disk capacity', () => {
  function storage(freeBytes: number, platform: NodeJS.Platform = 'darwin') {
    return {
      platform,
      statfs: vi.fn().mockResolvedValue({ bavail: freeBytes, bsize: 1 })
    }
  }

  it('queues only when the new writes fit after the safety reserve', async () => {
    vi.useFakeTimers()
    const enoughDb = new FakeDatabase()
    const enough = createManager(
      enoughDb,
      createHub(),
      createSettings(),
      undefined,
      storage(DOWNLOAD_SPACE_RESERVE_BYTES + 42)
    )
    await expect(enough.start({ repoId: 'org/repo', kind: 'model' })).resolves.toHaveLength(1)
    expect(enoughDb.writes).toHaveLength(1)
    enough.shutdown()

    const blockedDb = new FakeDatabase()
    const blocked = createManager(
      blockedDb,
      createHub(),
      createSettings(),
      undefined,
      storage(DOWNLOAD_SPACE_RESERVE_BYTES + 41)
    )
    await expect(blocked.start({ repoId: 'org/repo', kind: 'model' })).rejects.toThrow(
      'download.diskInsufficient'
    )
    expect(blockedDb.writes).toHaveLength(0)
    blocked.shutdown()
  })

  it('subtracts bytes reserved by an existing queued task', async () => {
    vi.useFakeTimers()
    const manager = createManager(
      new FakeDatabase(),
      createHub(),
      createSettings(),
      undefined,
      storage(DOWNLOAD_SPACE_RESERVE_BYTES + 83)
    )
    await manager.start({ repoId: 'org/first', kind: 'model' })

    await expect(manager.start({ repoId: 'org/second', kind: 'model' })).rejects.toThrow(
      'download.diskInsufficient'
    )
    expect(manager.list()).toHaveLength(1)
    expect((await manager.getCapacity()).reservedBytes).toBe(42)
    manager.shutdown()
  })

  it('allows the download when filesystem capacity cannot be read', async () => {
    vi.useFakeTimers()
    const manager = createManager(new FakeDatabase(), createHub(), createSettings(), undefined, {
      platform: 'darwin',
      statfs: vi.fn().mockRejectedValue(new Error('unsupported'))
    })

    await expect(manager.start({ repoId: 'org/repo', kind: 'model' })).resolves.toHaveLength(1)
    expect((await manager.getCapacity()).availableBytes).toBeUndefined()
    manager.shutdown()
  })

  it('does not reserve an existing same-size blob on POSIX', async () => {
    vi.useFakeTimers()
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-capacity-blob-'))
    const { blobsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(blobsDir, { recursive: true })
    writeFileSync(join(blobsDir, 'f'.repeat(64)), Buffer.alloc(42))
    const manager = createManager(
      new FakeDatabase(),
      createHub(),
      createSettings({ hfCacheDir: cacheDir }),
      undefined,
      storage(DOWNLOAD_SPACE_RESERVE_BYTES)
    )

    await expect(manager.start({ repoId: 'org/repo', kind: 'model' })).resolves.toHaveLength(1)
    manager.shutdown()
  })

  it('uses conservative Windows snapshot-copy accounting', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'omh-download-capacity-win-'))
    const files = [
      {
        path: 'weights.bin',
        size: 42,
        receivedBytes: 0,
        status: 'queued' as const,
        sha256: 'f'.repeat(64)
      }
    ]
    expect(
      estimateRequiredDownloadBytes(cacheDir, 'model', 'org/repo', COMMIT_A, files, 'win32')
    ).toBe(84)

    const { blobsDir } = repoCachePaths(cacheDir, 'model', 'org/repo')
    mkdirSync(blobsDir, { recursive: true })
    writeFileSync(join(blobsDir, 'f'.repeat(64)), Buffer.alloc(42))
    expect(
      estimateRequiredDownloadBytes(cacheDir, 'model', 'org/repo', COMMIT_A, files, 'win32')
    ).toBe(42)
    expect(
      estimateRequiredDownloadBytes(cacheDir, 'model', 'org/repo', COMMIT_A, files, 'darwin')
    ).toBe(0)
  })

  it('classifies preflight and worker no-space errors consistently', () => {
    expect(classifyDownloadError('download.diskInsufficient:42:41')).toBe('disk-space')
    expect(classifyDownloadError('write failed: ENOSPC: no space left on device')).toBe(
      'disk-space'
    )
  })
})
