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
import type { SecurityReport, RepoKind, SecurityPreflightRequest } from '@oh-my-huggingface/shared'
import { SecurityGate } from './security-gate'
import { EventEmitter } from 'node:events'

const workerRecords = vi.hoisted(
  () => [] as Array<{ job: { authToken?: string; url: string }; messages: unknown[] }>
)
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    private record: { job: { authToken?: string; url: string }; messages: unknown[] }
    constructor(_file: string, options: { workerData: { authToken?: string; url: string } }) {
      super()
      this.record = { job: options.workerData, messages: [] }
      workerRecords.push(this.record)
    }
    postMessage(message: unknown): void {
      this.record.messages.push(message)
    }
    async terminate(): Promise<number> {
      this.emit('exit', 0)
      return 0
    }
  }
}))

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
  const listeners = new Set<(next: typeof value) => void>()
  return {
    get: () => value,
    set: (patch: Partial<typeof value>) => {
      Object.assign(value, patch)
      for (const listener of listeners) listener(value)
    },
    onChange: (listener: (next: typeof value) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listeners
  }
}

function createHub() {
  return {
    baseUrl: 'https://hub.example.test',
    resolveRevision: vi.fn(async (_kind: RepoKind, _repo: string, commit: string) => ({
      resolvedCommit: commit
    })),
    getSecurityReport: vi.fn(
      async (
        kind: RepoKind,
        repoId: string,
        revision: string,
        resolvedCommit: string
      ): Promise<SecurityReport> => ({
        kind,
        repoId,
        revision,
        resolvedCommit,
        overall: 'safe',
        reasons: [],
        evidence: [{ source: 'scanner', status: 'safe' }],
        fingerprint: `sha256:${'c'.repeat(64)}`,
        checkedAt: '2026-08-24T00:00:00.000Z'
      })
    ),
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
  onPostAction?: ConstructorParameters<typeof DownloadManager>[8],
  storageDeps?: ConstructorParameters<typeof DownloadManager>[9]
): DownloadManager {
  return new DownloadManager(
    db as never,
    settings as never,
    hub as never,
    { show: vi.fn() } as never,
    () => 'hf_test',
    vi.fn(),
    (endpoint) => {
      const gate = new SecurityGate({ ...hub, baseUrl: endpoint } as never)
      const authorize = gate.authorize.bind(gate)
      // Starting these fixtures represents an explicitly approved user action.
      // Persisted resume still uses the real acknowledgement/evidence checks.
      gate.authorize = async (request, grantId) => {
        if (grantId) return authorize(request, grantId)
        const preflight = await gate.preflight(request)
        return authorize(
          request,
          preflight.challengeId ? gate.confirm(preflight.challengeId).grantId : undefined
        )
      }
      return gate
    },
    undefined,
    onPostAction,
    storageDeps
  )
}

function persistedCompletedPostActionRow(
  status: 'pending' | 'running' | 'waiting-confirmation' | 'waiting-runtime' | 'error' = 'pending'
): Record<string, unknown> & { id: string } {
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

    const resumed = (await manager.resume(id)).find((task) => task.id === id)

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
    expect((await manager.resumeAll()).every((task) => task.status === 'queued')).toBe(true)

    const internals = manager as unknown as {
      tasks: Map<string, { status: string }>
    }
    const first = [...internals.tasks.values()][0]!
    first.status = 'completed'
    expect(manager.clearCompleted()).toHaveLength(1)
    expect(manager.clearAll()).toHaveLength(0)
    manager.shutdown()
  })

  it('resumes pumping after shutdown so a failed install can continue downloads', async () => {
    const manager = createManager(new FakeDatabase())
    await manager.start({ repoId: 'org/repo', kind: 'model', revision: 'main' })
    const internals = manager as unknown as {
      shuttingDown: boolean
      tasks: Map<string, { status: string; files: Array<{ status: string }> }>
      runtimeAuthTokens: Map<string, string | undefined>
      latestRevisionTasks: Map<string, { taskId: string }>
    }
    const task = [...internals.tasks.values()][0]!
    const taskId = [...internals.tasks.keys()][0]!
    task.status = 'running'
    task.files[0]!.status = 'running'

    manager.shutdown()
    expect(internals.shuttingDown).toBe(true)
    expect(internals.runtimeAuthTokens.size).toBe(0)
    expect(internals.latestRevisionTasks.size).toBe(0)

    await manager.start({ repoId: 'org/other', kind: 'model', revision: 'main' })
    expect(internals.shuttingDown).toBe(true)
    expect(manager.list().find((item) => item.repoId === 'org/other')?.status).toBe('queued')

    await manager.resumeAfterShutdown()
    expect(internals.shuttingDown).toBe(false)
    expect(task.files[0]!.status).toBe('queued')
    expect(internals.runtimeAuthTokens.get(taskId)).toBe('hf_test')
    expect(internals.latestRevisionTasks.size).toBeGreaterThan(0)

    const after = await manager.start({ repoId: 'org/third', kind: 'model', revision: 'main' })
    expect(after.some((item) => item.repoId === 'org/third')).toBe(true)
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
    await manager.resume(task.id)

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

  it('waits for shutdown workers to exit before pumping resumeAfterShutdown', async () => {
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

    manager.shutdown()
    await manager.resumeAfterShutdown()

    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(internals.stoppingTasks.has(task.id)).toBe(true)
    expect(internals.workers.size).toBe(0)
    expect(file.status).toBe('queued')
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

describe('download resume security and live settings', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  it('denies malicious evidence for single and bulk resume without creating workers', async () => {
    const hub = createHub()
    const settings = createSettings()
    const manager = createManager(new FakeDatabase(), hub, settings)
    await manager.start({ kind: 'model', repoId: 'org/repo' })
    const id = manager.list()[0]!.id
    manager.pause(id)
    const report = await hub.getSecurityReport('model', 'org/repo', 'main', COMMIT_A)
    hub.getSecurityReport.mockResolvedValue({
      ...report,
      overall: 'malicious',
      evidence: [{ source: 'scanner', status: 'malicious' }]
    })
    settings.set({ downloadConcurrency: 1 })
    workerRecords.length = 0
    await expect(manager.resume(id)).rejects.toThrow('security.blocked')
    expect((await manager.resumeAll())[0]).toMatchObject({ status: 'error', errorCode: 'security' })
    expect(workerRecords).toEqual([])
    expect((await manager.resumePreflight(id)).decision).toBe('block')
    manager.shutdown()
  })

  it('requires explicit renewed confirmation when evidence changes and retains partial progress', async () => {
    const hub = createHub()
    const manager = createManager(new FakeDatabase(), hub)
    await manager.start({ kind: 'model', repoId: 'org/repo' })
    const id = manager.list()[0]!.id
    manager.pause(id)
    const report = await hub.getSecurityReport('model', 'org/repo', 'main', COMMIT_A)
    hub.getSecurityReport.mockResolvedValue({
      ...report,
      overall: 'unknown',
      fingerprint: `sha256:${'d'.repeat(64)}`,
      evidence: [{ source: 'scanner', status: 'pending' }]
    })
    await expect(manager.resume(id)).rejects.toThrow('security.evidenceChanged')
    expect(manager.list()[0]).toMatchObject({ id, status: 'error', resolvedCommit: COMMIT_A })
    expect(manager.protectedTaskIds()).toContain(id)
    const preflight = await manager.resumePreflight(id)
    expect(preflight.decision).toBe('confirm')
    const grant = manager.confirmResume(id, preflight.challengeId!)
    expect(
      (await manager.resume(id, { reconfirm: true, securityGrantId: grant.grantId }))[0]?.status
    ).toBe('queued')
    manager.pause(id)
    await expect(
      manager.resume(id, { reconfirm: true, securityGrantId: grant.grantId })
    ).rejects.toThrow()
    manager.shutdown()
  })

  it.each(['pause', 'cancel', 'remove', 'shutdown'] as const)(
    'never launches after %s supersedes a pending resume',
    async (intent) => {
      const hub = createHub()
      const settings = createSettings()
      const manager = createManager(new FakeDatabase(), hub, settings)
      await manager.start({ kind: 'model', repoId: 'org/repo' })
      const id = manager.list()[0]!.id
      manager.pause(id)
      await Promise.resolve()
      const report = await hub.getSecurityReport('model', 'org/repo', 'main', COMMIT_A)
      const pending = deferred<SecurityReport>()
      hub.getSecurityReport.mockReturnValue(pending.promise)
      settings.set({ downloadConcurrency: 1 })
      workerRecords.length = 0
      const resumed = manager.resume(id)
      await manager.resume(id)
      if (intent === 'shutdown') manager.shutdown()
      else manager[intent](id)
      pending.resolve(report)
      await resumed
      expect(workerRecords).toEqual([])
      expect(manager.list()[0]?.status).not.toBe('running')
      expect(manager.list()[0]?.status).not.toBe('queued')
      manager.shutdown()
    }
  )

  it('updates an active speed limit immediately and pumps added concurrency without interruption', async () => {
    const settings = createSettings()
    const hub = createHub()
    hub.getFileTree.mockResolvedValue([
      { type: 'file', path: 'one.gguf', size: 42, lfs: { oid: 'a'.repeat(64), size: 42 } },
      { type: 'file', path: 'two.gguf', size: 42, lfs: { oid: 'b'.repeat(64), size: 42 } }
    ])
    const manager = createManager(new FakeDatabase(), hub, settings)
    await manager.start({ kind: 'model', repoId: 'org/repo' })
    workerRecords.length = 0
    settings.set({ downloadConcurrency: 1 })
    expect(workerRecords).toHaveLength(1)
    settings.set({ speedLimitBps: 1024 ** 2 })
    expect(workerRecords[0]!.messages.at(-1)).toEqual({ type: 'limit', limitBps: 1024 ** 2 })
    settings.set({ downloadConcurrency: 2 })
    expect(workerRecords).toHaveLength(2)
    expect(workerRecords[0]!.messages.at(-1)).toEqual({ type: 'limit', limitBps: 1024 ** 2 / 2 })
    expect(workerRecords[0]!.messages).not.toContainEqual({ type: 'abort' })
    manager.shutdown()
    expect(settings.listeners.size).toBe(0)
  })

  it('never forwards current credentials to the old frozen endpoint on resume', async () => {
    const hub = createHub()
    const settings = createSettings()
    const manager = createManager(new FakeDatabase(), hub, settings)
    await manager.start({ kind: 'model', repoId: 'org/repo' })
    const id = manager.list()[0]!.id
    manager.pause(id)
    await Promise.resolve()
    hub.baseUrl = 'https://other.example.test'
    settings.set({ downloadConcurrency: 1 })
    workerRecords.length = 0
    await manager.resume(id)
    expect(workerRecords[0]!.job.url).toContain(
      `https://hub.example.test/org/repo/resolve/${COMMIT_A}/`
    )
    expect(workerRecords[0]!.job.authToken).toBeUndefined()
    manager.shutdown()
  })
})

describe('persisted download authorization', () => {
  it('round-trips the original compound scope rather than the subset left to download', async () => {
    const hub = createHub()
    const db = new FakeDatabase()
    const manager = createManager(db, hub)
    const request: SecurityPreflightRequest = {
      action: 'lock-restore',
      kind: 'model',
      repoId: 'org/repo',
      revision: 'v1',
      resolvedCommit: COMMIT_A,
      files: ['weights.bin', 'config.json']
    }
    const gate = new SecurityGate(hub as never)
    const report = await hub.getSecurityReport('model', 'org/repo', 'v1', COMMIT_A)
    const acknowledgement = gate.acknowledgement(request, report)
    await manager.start({
      kind: 'model',
      repoId: 'org/repo',
      revision: 'v1',
      resolvedCommit: COMMIT_A,
      files: ['weights.bin'],
      securityAuthorization: { request, acknowledgement }
    })
    const id = manager.list()[0]!.id
    manager.pause(id)
    const persisted = db.writes.at(-1)!
    expect(JSON.parse(persisted.securityAuthorizationJson as string)).toEqual({
      request,
      acknowledgement
    })
    expect(manager.list()[0]).not.toHaveProperty('securityAuthorization')
    manager.shutdown()
    const restored = createManager(
      new FakeDatabase([
        {
          ...persistedCompletedPostActionRow(),
          id,
          repo_id: 'org/repo',
          revision: 'v1',
          status: 'paused',
          files_json: persisted.filesJson,
          received_bytes: 12,
          security_authorization_json: persisted.securityAuthorizationJson,
          post_action_json: null,
          security_ack_json: null
        }
      ]),
      hub
    )
    expect((await restored.resume(id))[0]).toMatchObject({
      id,
      status: 'queued',
      resolvedCommit: COMMIT_A,
      receivedBytes: 12
    })
    restored.shutdown()
  })

  it('requires fresh explicit approval for legacy missing acknowledgements, retaining partial ownership', async () => {
    const row = {
      ...persistedCompletedPostActionRow(),
      status: 'paused',
      received_bytes: 12,
      files_json: JSON.stringify([
        { path: 'model.gguf', size: 42, receivedBytes: 12, status: 'paused' }
      ]),
      security_ack_json: '{malformed',
      security_authorization_json: null,
      post_action_json: null
    }
    const manager = createManager(new FakeDatabase([row]))
    await expect(manager.resume(row.id)).rejects.toThrow('security.confirmationRequired')
    expect(manager.protectedTaskIds()).toContain(row.id)
    expect(manager.list()[0]?.receivedBytes).toBe(12)
    const preflight = await manager.resumePreflight(row.id)
    const grant = manager.confirmResume(row.id, preflight.challengeId!)
    expect(
      (await manager.resume(row.id, { reconfirm: true, securityGrantId: grant.grantId }))[0]?.status
    ).toBe('queued')
    manager.shutdown()
  })
})

it('refuses a persisted authorization whose scope no longer covers the task files', async () => {
  const row = {
    ...persistedCompletedPostActionRow(),
    status: 'paused',
    received_bytes: 12,
    files_json: JSON.stringify([
      { path: 'model.gguf', size: 42, receivedBytes: 12, status: 'paused' }
    ]),
    post_action_json: null,
    security_authorization_json: JSON.stringify({
      request: {
        action: 'local-run',
        kind: 'model',
        repoId: 'org/repo',
        revision: 'v1',
        resolvedCommit: COMMIT_A,
        files: ['other.gguf']
      },
      acknowledgement: JSON.parse(persistedCompletedPostActionRow().security_ack_json as string)
    })
  }
  const manager = createManager(new FakeDatabase([row]))
  workerRecords.length = 0
  await expect(manager.resume(row.id)).rejects.toThrow('security.acknowledgementScopeMismatch')
  const renewed = await manager.resumePreflight(row.id)
  expect(renewed.decision).toBe('confirm')
  expect(workerRecords).toEqual([])
  expect(manager.list()[0]?.receivedBytes).toBe(12)
  expect(manager.protectedTaskIds()).toContain(row.id)
  const grant = manager.confirmResume(row.id, renewed.challengeId!)
  expect(
    (await manager.resume(row.id, { reconfirm: true, securityGrantId: grant.grantId }))[0]?.status
  ).toBe('queued')
  manager.shutdown()
})
