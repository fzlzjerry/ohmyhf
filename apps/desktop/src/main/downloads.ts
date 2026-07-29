import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { computeSpeedShare } from '@oh-my-huggingface/shared'
import type {
  DownloadFileState,
  DownloadRequest,
  DownloadStatus,
  DownloadTask
} from '@oh-my-huggingface/shared'
import type { HubClient } from '@oh-my-huggingface/hub-api'
import { RESOLVE_PREFIX, defaultCacheDir, repoCachePaths } from '@oh-my-huggingface/hub-api'
import type { AppDatabase } from './db'
import { resolveSystemProxyUrl } from './hub'
import type { NotificationService } from './notifications'
import type { SettingsStore } from './settings'
import type { DownloadJob } from './workers/download-worker'

interface WorkerMessage {
  type: 'meta' | 'progress' | 'done' | 'error'
  received?: number
  size?: number
  commit?: string
  message?: string
  verified?: boolean
}

const PROGRESS_BROADCAST_MS = 400
const PROGRESS_PERSIST_MS = 3000
const DOWNLOAD_ENVIRONMENT_VERSION = 1

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function safeExistingDirectory(path: string, parentRealPath?: string): string {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Unsafe cache directory')
  const resolvedPath = realpathSync(path)
  if (parentRealPath) {
    const rel = relative(parentRealPath, resolvedPath)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error('Cache directory escaped its expected parent')
    }
  }
  return resolvedPath
}

function safeChildDirectory(parentRealPath: string, name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('Unsafe cache directory segment')
  }
  const childPath = resolve(parentRealPath, name)
  const rel = relative(parentRealPath, childPath)
  if (rel !== name || isAbsolute(rel)) throw new Error('Unsafe cache directory path')
  try {
    mkdirSync(childPath)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  return safeExistingDirectory(childPath, parentRealPath)
}
const COMMIT_RE = /^[0-9a-f]{40}$/
type ResolvedCommit = string & { readonly __resolvedCommit: unique symbol }

type DownloadErrorCode =
  'legacy-task' | 'environment-mismatch' | 'commit-mismatch' | 'network' | 'integrity'

interface DownloadEnvironment {
  endpoint: string
  proxyUrl: string | null
  cacheDir: string
  version: number
}

interface ManagedDownloadTask extends DownloadTask {
  resolvedCommit?: string
  errorCode?: DownloadErrorCode
  resumable: boolean
  /** Main-process-only fields. Never returned by list() or broadcast over IPC. */
  environment?: DownloadEnvironment
  revisionSequence?: number
}

interface DownloadRow {
  id: string
  repo_id: string
  kind: string
  revision: string
  resolved_commit: string | null
  endpoint: string | null
  proxy_url: string | null
  cache_dir: string | null
  environment_version: number | null
  status: string
  total_bytes: number
  received_bytes: number
  files_json: string
  error: string | null
  error_code: string | null
  created_at: string
  completed_at: string | null
}

export function isResolvedCommit(value: string | undefined | null): value is ResolvedCommit {
  return Boolean(value && COMMIT_RE.test(value.toLowerCase()))
}

export function buildFrozenResolveUrl(
  endpoint: string,
  kind: DownloadTask['kind'],
  repoId: string,
  commit: string,
  path: string
): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  return `${endpoint.replace(/\/+$/, '')}/${RESOLVE_PREFIX[kind]}${repoId}/resolve/${commit}/${encodedPath}`
}

export function isSafeRepoFilePath(path: string): boolean {
  const segments = path.split('/')
  return (
    !isAbsolute(path) &&
    segments.every(
      (segment) =>
        Boolean(segment) &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('\\') &&
        !segment.includes('\0')
    )
  )
}

function normalizeErrorCode(value: string | null): DownloadErrorCode | undefined {
  switch (value) {
    case 'legacy-task':
    case 'environment-mismatch':
    case 'commit-mismatch':
    case 'network':
    case 'integrity':
      return value
    default:
      return undefined
  }
}

function classifyDownloadError(message: string | undefined): DownloadErrorCode {
  if (message === 'commit-mismatch') return 'commit-mismatch'
  if (
    message &&
    /checksum|sha1|sha256|etag|incomplete download|unsafe-cache-layout|unsafe download cache|escapes its/i.test(
      message
    )
  ) {
    return 'integrity'
  }
  return 'network'
}

export class DownloadManager {
  private readonly tasks = new Map<string, ManagedDownloadTask>()
  private readonly workers = new Map<string, Worker>()
  private readonly runtimeAuthTokens = new Map<string, string | undefined>()
  private readonly stoppingTasks = new Map<string, Promise<unknown>>()
  private readonly latestRevisionTasks = new Map<string, { sequence: number; taskId: string }>()
  private readonly speedWindow = new Map<string, { at: number; bytes: number; bps: number }>()
  private readonly dirtyTaskIds = new Set<string>()
  private broadcastTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private suppressPump = false
  private revisionSequence = 0

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: SettingsStore,
    private readonly hub: HubClient,
    private readonly notifications: NotificationService,
    private readonly getAuthToken: () => string | undefined,
    private readonly broadcast: (tasks: DownloadTask[]) => void
  ) {
    this.loadPersisted()
  }

  private loadPersisted(): void {
    const rows = this.db
      .prepare('SELECT * FROM downloads ORDER BY created_at')
      .all() as DownloadRow[]
    for (const row of rows) {
      let files: DownloadFileState[] = []
      try {
        files = JSON.parse(row.files_json) as DownloadFileState[]
      } catch {
        /* corrupted row; keep empty file list */
      }
      const resolvedCommit = row.resolved_commit?.toLowerCase()
      const hasEnvironment =
        isResolvedCommit(resolvedCommit) &&
        Boolean(row.endpoint) &&
        Boolean(row.cache_dir && isAbsolute(row.cache_dir)) &&
        row.environment_version === DOWNLOAD_ENVIRONMENT_VERSION
      const isLegacyActive =
        !hasEnvironment &&
        (row.status === 'queued' ||
          row.status === 'running' ||
          row.status === 'paused' ||
          row.status === 'error')
      // Anything that was mid-flight when the app quit resumes as paused, but
      // pre-environment tasks are explicitly non-resumable.
      const status = (
        isLegacyActive
          ? 'error'
          : row.status === 'running' || row.status === 'queued'
            ? 'paused'
            : row.status
      ) as DownloadStatus
      for (const f of files) {
        if (f.status === 'running' || f.status === 'queued') f.status = 'paused'
      }
      const task: ManagedDownloadTask = {
        id: row.id,
        repoId: row.repo_id,
        kind: row.kind as DownloadTask['kind'],
        revision: row.revision,
        resolvedCommit: isResolvedCommit(resolvedCommit) ? resolvedCommit : undefined,
        status,
        totalBytes: row.total_bytes,
        receivedBytes: row.received_bytes,
        speedBps: 0,
        files,
        error: isLegacyActive
          ? 'This download was created by an older version and cannot be resumed.'
          : (row.error ?? undefined),
        errorCode: isLegacyActive ? 'legacy-task' : normalizeErrorCode(row.error_code),
        resumable: false,
        createdAt: row.created_at,
        completedAt: row.completed_at ?? undefined,
        environment: hasEnvironment
          ? {
              endpoint: row.endpoint!.replace(/\/+$/, ''),
              proxyUrl: row.proxy_url,
              cacheDir: row.cache_dir!,
              version: row.environment_version!
            }
          : undefined,
        revisionSequence:
          hasEnvironment && !isResolvedCommit(row.revision) ? ++this.revisionSequence : undefined
      }
      task.resumable = this.canResume(task)
      this.tasks.set(row.id, task)
      this.rememberRevisionTask(task)
    }
  }

  private persistRow(task: ManagedDownloadTask): void {
    this.db
      .prepare(
        `INSERT INTO downloads (id, repo_id, kind, revision, resolved_commit, endpoint, proxy_url, cache_dir, environment_version, status, total_bytes, received_bytes, files_json, error, error_code, created_at, completed_at)
         VALUES (@id, @repoId, @kind, @revision, @resolvedCommit, @endpoint, @proxyUrl, @cacheDir, @environmentVersion, @status, @totalBytes, @receivedBytes, @filesJson, @error, @errorCode, @createdAt, @completedAt)
         ON CONFLICT(id) DO UPDATE SET
           resolved_commit = excluded.resolved_commit,
           endpoint = excluded.endpoint,
           proxy_url = excluded.proxy_url,
           cache_dir = excluded.cache_dir,
           environment_version = excluded.environment_version,
           status = excluded.status,
           total_bytes = excluded.total_bytes,
           received_bytes = excluded.received_bytes,
           files_json = excluded.files_json,
           error = excluded.error,
           error_code = excluded.error_code,
           completed_at = excluded.completed_at`
      )
      .run({
        id: task.id,
        repoId: task.repoId,
        kind: task.kind,
        revision: task.revision,
        resolvedCommit: task.resolvedCommit ?? null,
        endpoint: task.environment?.endpoint ?? null,
        proxyUrl: task.environment?.proxyUrl ?? null,
        cacheDir: task.environment?.cacheDir ?? null,
        environmentVersion: task.environment?.version ?? null,
        status: task.status,
        totalBytes: task.totalBytes,
        receivedBytes: task.receivedBytes,
        filesJson: JSON.stringify(task.files),
        error: task.error ?? null,
        errorCode: task.errorCode ?? null,
        createdAt: task.createdAt,
        completedAt: task.completedAt ?? null
      })
  }

  private persist(task: ManagedDownloadTask): void {
    this.dirtyTaskIds.delete(task.id)
    this.persistRow(task)
  }

  private persistTasks(ids: Iterable<string>): void {
    const tasks = [...new Set(ids)]
      .map((id) => this.tasks.get(id))
      .filter((task): task is ManagedDownloadTask => Boolean(task))
    if (tasks.length === 0) return
    this.db.transaction(() => {
      for (const task of tasks) this.persistRow(task)
    })()
    for (const task of tasks) this.dirtyTaskIds.delete(task.id)
  }

  private flushDirtyTasks(): void {
    if (this.dirtyTaskIds.size === 0) return
    this.persistTasks([...this.dirtyTaskIds])
  }

  list(): DownloadTask[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => {
        task.resumable = this.canResume(task)
        const {
          environment: _environment,
          revisionSequence: _revisionSequence,
          ...publicTask
        } = task
        return publicTask
      })
  }

  /**
   * Task ids whose `.incomplete.<id>-*` partials are still resumable and must
   * not be reclaimed by the cache cleaner (paused/queued/running/errored, but
   * not completed — canceled tasks already deleted their own partials).
   */
  protectedTaskIds(): Set<string> {
    const ids = new Set<string>()
    for (const task of this.tasks.values()) {
      if (task.environment && this.canResume(task)) ids.add(task.id)
    }
    return ids
  }

  /** Commits whose snapshots/partials are owned by an active or resumable task. */
  protectedCommits(kind: DownloadTask['kind'], repoId: string): ReadonlySet<string> {
    const commits = new Set<string>()
    for (const task of this.tasks.values()) {
      if (task.kind !== kind || task.repoId !== repoId) continue
      if (!task.environment || !isResolvedCommit(task.resolvedCommit)) continue
      if (!this.canResume(task)) continue
      commits.add(task.resolvedCommit)
    }
    return commits
  }

  /** Resolve a reveal target from trusted task metadata, never a renderer path. */
  async resolveRevealPath(id: string): Promise<string> {
    const task = this.tasks.get(id)
    if (!task?.environment) throw new Error('Download task has no frozen cache directory')
    const { repoDir } = repoCachePaths(task.environment.cacheDir, task.kind, task.repoId)
    const info = await lstat(repoDir)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Download cache target is not a regular directory')
    }
    const [cacheRoot, realRepoDir] = await Promise.all([
      realpath(task.environment.cacheDir),
      realpath(repoDir)
    ])
    const relativeRepo = relative(cacheRoot, realRepoDir)
    if (!relativeRepo || relativeRepo.startsWith('..') || isAbsolute(relativeRepo)) {
      throw new Error('Download cache target escapes the frozen cache root')
    }
    return realRepoDir
  }

  private currentEndpoint(): string {
    return this.hub.baseUrl.replace(/\/+$/, '')
  }

  private canResume(task: ManagedDownloadTask): boolean {
    if (!task.environment || !isResolvedCommit(task.resolvedCommit)) return false
    if (task.status === 'completed' || task.status === 'canceled') return false
    if (task.errorCode === 'legacy-task') return false
    if (task.files.every((file) => file.status === 'completed')) return false
    return true
  }

  private revisionAliasKey(task: ManagedDownloadTask): string | null {
    if (!task.environment) return null
    return this.makeRevisionAliasKey(task.environment, task.kind, task.repoId, task.revision)
  }

  private makeRevisionAliasKey(
    environment: DownloadEnvironment,
    kind: DownloadTask['kind'],
    repoId: string,
    revision: string
  ): string | null {
    if (isResolvedCommit(revision)) return null
    return JSON.stringify([environment.cacheDir, kind, repoId, revision])
  }

  private rememberRevisionTask(task: ManagedDownloadTask): void {
    const key = this.revisionAliasKey(task)
    if (!key || task.revisionSequence === undefined) return
    const current = this.latestRevisionTasks.get(key)
    if (!current || task.revisionSequence > current.sequence) {
      this.latestRevisionTasks.set(key, { sequence: task.revisionSequence, taskId: task.id })
    }
  }

  private scheduleBroadcast(): void {
    if (this.shuttingDown) return
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.broadcast(this.list())
    }, PROGRESS_BROADCAST_MS)
  }

  private schedulePersist(task: ManagedDownloadTask): void {
    if (this.shuttingDown) return
    this.dirtyTaskIds.add(task.id)
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flushDirtyTasks()
    }, PROGRESS_PERSIST_MS)
  }

  async start(request: DownloadRequest): Promise<DownloadTask[]> {
    const revision = request.revision ?? 'main'
    const revisionSequence = isResolvedCommit(revision) ? undefined : ++this.revisionSequence
    // Property access on createHubProxy returns a method bound to the current
    // concrete client. Capture both methods before the first await so a Settings
    // endpoint rebuild cannot split detail resolution and tree enumeration.
    const getRepoDetail = this.hub.getRepoDetail.bind(this.hub)
    const getFileTree = this.hub.getFileTree.bind(this.hub)
    const settings = this.settings.get()
    const endpoint = this.currentEndpoint()
    const environment: DownloadEnvironment = {
      endpoint,
      // Worker threads use Node/undici and cannot see Electron's system proxy.
      // Freeze the currently resolved HTTP(S) route with the task so file
      // downloads follow the same network path as the metadata requests.
      proxyUrl: settings.proxyUrl ?? (await resolveSystemProxyUrl(endpoint)),
      cacheDir: resolve(settings.hfCacheDir ?? defaultCacheDir()),
      version: DOWNLOAD_ENVIRONMENT_VERSION
    }
    const detail = await getRepoDetail(request.kind, request.repoId, revision)
    const resolvedCommit = detail.sha?.toLowerCase()
    if (!isResolvedCommit(resolvedCommit)) {
      throw new Error('Hub did not resolve the requested revision to a 40-character commit')
    }
    const tree = await getFileTree(request.kind, request.repoId, resolvedCommit, '', {
      recursive: true
    })
    const wanted = new Set(request.files)
    const treeFiles = tree.filter((entry) => entry.type === 'file')
    if (treeFiles.some((entry) => !isSafeRepoFilePath(entry.path))) {
      throw new Error('Hub file tree contains an unsafe relative path')
    }
    const files: DownloadFileState[] = treeFiles
      .filter((e) => !request.files || wanted.has(e.path))
      .map((e) => ({
        path: e.path,
        size: e.size,
        receivedBytes: 0,
        status: 'queued' as const,
        sha256: e.lfs?.oid
      }))
    if (files.length === 0) throw new Error('No matching files to download')

    // Same-revision dedup: a second task covering files a task with a live
    // worker already holds would race two workers onto the same blob. Only
    // queued/running tasks have (or are about to have) a worker; a paused task
    // has none, so it cannot race — and treating its files as covered would
    // silently swallow a legitimate re-download request. Merge by dropping the
    // covered files; when nothing is left, the existing task IS the download.
    const covered = new Set<string>()
    for (const existing of this.tasks.values()) {
      if (existing.repoId !== request.repoId || existing.kind !== request.kind) continue
      if (existing.resolvedCommit !== resolvedCommit) continue
      if (existing.environment?.endpoint !== environment.endpoint) continue
      if (existing.environment.cacheDir !== environment.cacheDir) continue
      if (existing.status !== 'queued' && existing.status !== 'running') continue
      for (const f of existing.files) covered.add(f.path)
    }
    const newFiles = files.filter((f) => !covered.has(f.path))
    if (newFiles.length === 0) return this.list()

    const task: ManagedDownloadTask = {
      id: randomUUID(),
      repoId: request.repoId,
      kind: request.kind,
      revision,
      resolvedCommit,
      status: 'queued',
      totalBytes: newFiles.reduce((acc, f) => acc + f.size, 0),
      receivedBytes: 0,
      speedBps: 0,
      files: newFiles,
      resumable: true,
      environment,
      revisionSequence,
      createdAt: new Date().toISOString()
    }
    this.tasks.set(task.id, task)
    this.rememberRevisionTask(task)
    this.runtimeAuthTokens.set(task.id, this.getAuthToken())
    this.persist(task)
    this.pump()
    return this.list()
  }

  private runningCount(): number {
    return this.workers.size
  }

  private pump(): void {
    if (this.shuttingDown || this.suppressPump) return
    const concurrency = this.settings.get().downloadConcurrency
    for (const task of this.tasks.values()) {
      if (task.status !== 'queued' && task.status !== 'running') continue
      if (this.stoppingTasks.has(task.id)) continue
      for (const file of task.files) {
        if (this.runningCount() >= concurrency) break
        if (file.status !== 'queued') continue
        this.spawnWorker(task, file)
      }
    }
    this.scheduleBroadcast()
  }

  private workerKey(taskId: string, path: string): string {
    return `${taskId} ${path}`
  }

  private spawnWorker(task: ManagedDownloadTask, file: DownloadFileState): void {
    if (!task.environment || !isResolvedCommit(task.resolvedCommit)) {
      file.status = 'error'
      file.error = 'legacy-task'
      task.errorCode = 'legacy-task'
      task.error = 'This download has no safe, frozen environment.'
      task.status = 'error'
      task.resumable = false
      this.persist(task)
      return
    }
    const paths = repoCachePaths(task.environment.cacheDir, task.kind, task.repoId)
    const job: DownloadJob = {
      taskId: task.id,
      url: buildFrozenResolveUrl(
        task.environment.endpoint,
        task.kind,
        task.repoId,
        task.resolvedCommit,
        file.path
      ),
      repoDir: paths.repoDir,
      cacheDir: task.environment.cacheDir,
      path: file.path,
      expectedCommit: task.resolvedCommit,
      authToken: this.runtimeAuthTokens.get(task.id),
      // Each worker gets a share of the limit so the cap holds in aggregate.
      speedLimitBps: computeSpeedShare(this.settings.get().speedLimitBps, this.workers.size + 1),
      userAgent: `oh-my-huggingface/${app.getVersion()} (unofficial desktop client)`,
      proxyUrl: task.environment.proxyUrl
    }
    const worker = new Worker(join(__dirname, 'download-worker.mjs'), { workerData: job })
    const key = this.workerKey(task.id, file.path)
    this.workers.set(key, worker)
    this.rebalanceSpeedLimit()
    file.status = 'running'
    task.status = 'running'

    worker.on('message', (msg: WorkerMessage) => {
      if (this.tasks.get(task.id) !== task) return
      if (msg.type === 'meta') {
        if (msg.size !== undefined && msg.size !== file.size) {
          task.totalBytes += msg.size - file.size
          file.size = msg.size
        }
        this.schedulePersist(task)
      } else if (msg.type === 'progress') {
        file.receivedBytes = msg.received ?? file.receivedBytes
        if (msg.size && msg.size !== file.size) {
          task.totalBytes += msg.size - file.size
          file.size = msg.size
        }
        this.recomputeTask(task)
        this.scheduleBroadcast()
        this.schedulePersist(task)
      } else if (msg.type === 'done') {
        file.status = 'completed'
        file.receivedBytes = file.size
        file.verified = msg.verified
        this.finishWorker(key, task)
      } else if (msg.type === 'error') {
        if (msg.message === 'aborted') {
          if (file.status === 'running') file.status = 'paused'
        } else {
          file.status = 'error'
          file.error = msg.message
          task.errorCode = classifyDownloadError(msg.message)
        }
        this.finishWorker(key, task)
      }
    })
    worker.on('error', (err: Error) => {
      if (this.tasks.get(task.id) !== task) return
      file.status = 'error'
      file.error = err.message
      task.errorCode = classifyDownloadError(err.message)
      this.finishWorker(key, task)
    })
    worker.on('exit', () => {
      if (this.tasks.get(task.id) !== task) return
      if (this.workers.get(key)) {
        this.workers.delete(key)
        this.rebalanceSpeedLimit()
        if (file.status === 'running') file.status = 'paused'
        this.settleTask(task)
      }
    })
  }

  /** Re-split the aggregate speed limit across the live workers. */
  private rebalanceSpeedLimit(): void {
    const share = computeSpeedShare(this.settings.get().speedLimitBps, this.workers.size)
    for (const worker of this.workers.values()) {
      worker.postMessage({ type: 'limit', limitBps: share })
    }
  }

  private finishWorker(key: string, task: ManagedDownloadTask): void {
    const worker = this.workers.get(key)
    this.workers.delete(key)
    worker?.removeAllListeners()
    void worker?.terminate()
    this.rebalanceSpeedLimit()
    this.settleTask(task)
  }

  private recomputeTask(task: ManagedDownloadTask): void {
    task.receivedBytes = task.files.reduce((acc, f) => acc + f.receivedBytes, 0)
    const now = Date.now()
    const window = this.speedWindow.get(task.id)
    if (window) {
      const dt = (now - window.at) / 1000
      if (dt > 0.5) {
        const instant = Math.max(0, (task.receivedBytes - window.bytes) / dt)
        task.speedBps = Math.round(window.bps * 0.6 + instant * 0.4)
        this.speedWindow.set(task.id, { at: now, bytes: task.receivedBytes, bps: task.speedBps })
      }
    } else {
      this.speedWindow.set(task.id, { at: now, bytes: task.receivedBytes, bps: 0 })
    }
  }

  /** Atomically publish the user-facing revision alias after the full task succeeds. */
  private writeRevisionRef(task: ManagedDownloadTask): void {
    if (isResolvedCommit(task.revision)) return
    if (!task.environment || !isResolvedCommit(task.resolvedCommit)) {
      throw new Error('Cannot write a revision ref without a frozen commit and cache root')
    }
    const aliasKey = this.revisionAliasKey(task)
    if (!aliasKey || this.latestRevisionTasks.get(aliasKey)?.taskId !== task.id) return
    const segments = task.revision.split('/')
    if (
      segments.some(
        (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\')
      )
    ) {
      throw new Error('Unsafe revision ref')
    }
    const { repoDir } = repoCachePaths(task.environment.cacheDir, task.kind, task.repoId)
    const cacheRoot = safeExistingDirectory(task.environment.cacheDir)
    const repoRoot = safeExistingDirectory(repoDir, cacheRoot)
    let refParent = safeChildDirectory(repoRoot, 'refs')
    for (const segment of segments.slice(0, -1)) {
      refParent = safeChildDirectory(refParent, segment)
    }
    const refPath = resolve(refParent, segments.at(-1)!)
    const relativeRef = relative(refParent, refPath)
    if (relativeRef !== segments.at(-1) || isAbsolute(relativeRef))
      throw new Error('Unsafe revision ref path')
    try {
      const existingRef = lstatSync(refPath)
      if (existingRef.isSymbolicLink() || !existingRef.isFile()) {
        throw new Error('Unsafe existing revision ref')
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const tempPath = `${refPath}.tmp.${task.id}.${randomUUID()}`
    try {
      writeFileSync(tempPath, task.resolvedCommit, { encoding: 'utf8', flag: 'wx' })
      renameSync(tempPath, refPath)
    } catch (err) {
      rmSync(tempPath, { force: true })
      throw err
    }
  }

  /** Re-derive task status after a file finished, errored, or was paused. */
  private settleTask(task: ManagedDownloadTask): void {
    if (this.tasks.get(task.id) !== task) return
    this.recomputeTask(task)
    if (task.status === 'canceled') {
      this.persist(task)
      this.scheduleBroadcast()
      return
    }
    const hasRunning = task.files.some((f) => f.status === 'running')
    const hasQueued = task.files.some((f) => f.status === 'queued')
    const hasError = task.files.some((f) => f.status === 'error')
    const allCompleted = task.files.every((f) => f.status === 'completed')

    if (allCompleted) {
      try {
        this.writeRevisionRef(task)
      } catch (err) {
        task.status = 'error'
        task.speedBps = 0
        task.errorCode = 'integrity'
        task.error = err instanceof Error ? err.message : String(err)
        task.resumable = false
        this.runtimeAuthTokens.delete(task.id)
        this.speedWindow.delete(task.id)
        this.persist(task)
        this.scheduleBroadcast()
        this.pump()
        return
      }
      task.status = 'completed'
      task.speedBps = 0
      task.completedAt = new Date().toISOString()
      task.error = undefined
      task.errorCode = undefined
      task.resumable = false
      this.runtimeAuthTokens.delete(task.id)
      this.notifications.show(
        'notifications.downloadComplete',
        'notifications.downloadCompleteBody',
        { repo: task.repoId },
        '/downloads'
      )
    } else if (hasError && !hasRunning && !hasQueued) {
      task.status = 'error'
      task.speedBps = 0
      task.error = task.files.find((f) => f.error)?.error
      task.errorCode ??= classifyDownloadError(task.error)
      task.resumable = this.canResume(task)
      this.notifications.show(
        'notifications.downloadFailed',
        'notifications.downloadFailedBody',
        { repo: task.repoId, error: task.error ?? '' },
        '/downloads'
      )
    } else if (!hasRunning && !hasQueued) {
      task.status = 'paused'
      task.speedBps = 0
      task.resumable = this.canResume(task)
    }
    this.persist(task)
    if (task.status !== 'running' && task.status !== 'queued') this.speedWindow.delete(task.id)
    this.pump()
  }

  /** Abort and terminate this task's workers; resolves once they have exited. */
  private abortTaskWorkers(task: ManagedDownloadTask): Promise<unknown> {
    const existing = this.stoppingTasks.get(task.id)
    if (existing) return existing
    const exits: Array<Promise<unknown>> = []
    for (const [key, worker] of this.workers) {
      if (key.startsWith(`${task.id} `)) {
        worker.removeAllListeners()
        worker.postMessage({ type: 'abort' })
        this.workers.delete(key)
        exits.push(worker.terminate().catch(() => undefined))
      }
    }
    this.rebalanceSpeedLimit()
    const stopping = Promise.all(exits).finally(() => {
      if (this.stoppingTasks.get(task.id) === stopping) this.stoppingTasks.delete(task.id)
      this.pump()
    })
    this.stoppingTasks.set(task.id, stopping)
    return stopping
  }

  /** Remove this task's on-disk `.incomplete.<taskId>-*` partial files. */
  private async deleteTaskPartials(task: ManagedDownloadTask): Promise<void> {
    // Never guess the cache root for a legacy task.
    if (!task.environment) return
    const cacheRootPath = resolve(task.environment.cacheDir)
    const { repoDir, blobsDir } = repoCachePaths(cacheRootPath, task.kind, task.repoId)
    const expectedRepoName = relative(cacheRootPath, repoDir)
    if (!expectedRepoName || expectedRepoName.includes(sep) || isAbsolute(expectedRepoName)) {
      throw new Error('Unsafe download cache repository path')
    }

    let rootEntry: Awaited<ReturnType<typeof lstat>>
    try {
      rootEntry = await lstat(cacheRootPath)
    } catch (error) {
      if (isMissingPath(error)) return
      throw error
    }
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throw new Error('Unsafe download cache root')
    }
    const realRoot = await realpath(cacheRootPath)
    const repoEntry = await lstat(repoDir).catch((error: unknown) => {
      if (isMissingPath(error)) return null
      throw error
    })
    if (!repoEntry) return
    if (repoEntry.isSymbolicLink() || !repoEntry.isDirectory()) {
      throw new Error('Unsafe download cache repository')
    }
    const realRepo = await realpath(repoDir)
    if (relative(realRoot, realRepo) !== expectedRepoName) {
      throw new Error('Download cache repository escapes its frozen root')
    }
    const blobsEntry = await lstat(blobsDir).catch((error: unknown) => {
      if (isMissingPath(error)) return null
      throw error
    })
    if (!blobsEntry) return
    if (blobsEntry.isSymbolicLink() || !blobsEntry.isDirectory()) {
      throw new Error('Unsafe download cache blobs directory')
    }
    const realBlobs = await realpath(blobsDir)
    if (relative(realRepo, realBlobs) !== 'blobs') {
      throw new Error('Download blobs directory escapes its repository')
    }

    const partials: string[] = []
    const escapedTaskId = task.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const ownedPartial = new RegExp(
      `^(?:[0-9a-f]{40}|[0-9a-f]{64})\\.incomplete\\.${escapedTaskId}-[0-9a-f]{8}$`,
      'i'
    )
    const names = await readdir(realBlobs)
    for (const name of names) {
      const candidate = join(realBlobs, name)
      const entry = await lstat(candidate)
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error('Unsafe entry in download blobs directory')
      }
      const realCandidate = await realpath(candidate)
      const rel = relative(realBlobs, realCandidate)
      if (!rel || rel.includes(sep) || isAbsolute(rel)) {
        throw new Error('Download partial escapes its blobs directory')
      }
      if (ownedPartial.test(name)) partials.push(realCandidate)
    }
    // Complete preflight above before the first mutation.
    for (const partial of partials) await rm(partial, { force: true })
  }

  pause(id: string): DownloadTask[] {
    const task = this.tasks.get(id)
    if (task && (task.status === 'running' || task.status === 'queued')) {
      void this.abortTaskWorkers(task)
      for (const f of task.files) {
        if (f.status === 'running' || f.status === 'queued') f.status = 'paused'
      }
      task.status = 'paused'
      task.speedBps = 0
      this.speedWindow.delete(task.id)
      task.resumable = this.canResume(task)
      this.persist(task)
      this.pump()
    }
    return this.list()
  }

  resume(id: string): DownloadTask[] {
    const task = this.tasks.get(id)
    if (task && (task.status === 'paused' || task.status === 'error')) {
      if (!this.canResume(task)) {
        task.resumable = false
        return this.list()
      }
      if (!task.environment || !isResolvedCommit(task.resolvedCommit)) {
        task.status = 'error'
        task.errorCode = 'legacy-task'
        task.error = 'This download was created by an older version and cannot be resumed.'
        task.resumable = false
        this.persist(task)
        this.scheduleBroadcast()
        return this.list()
      }
      for (const f of task.files) {
        if (f.status === 'paused' || f.status === 'error') {
          f.status = 'queued'
          f.error = undefined
        }
      }
      task.status = 'queued'
      task.error = undefined
      task.errorCode = undefined
      task.resumable = true
      task.revisionSequence = ++this.revisionSequence
      this.rememberRevisionTask(task)
      this.runtimeAuthTokens.set(task.id, this.getAuthToken())
      this.persist(task)
      this.pump()
    }
    return this.list()
  }

  cancel(id: string): DownloadTask[] {
    const task = this.tasks.get(id)
    if (task && task.status !== 'completed') {
      task.status = 'canceled'
      const stopped = this.abortTaskWorkers(task)
      for (const f of task.files) {
        if (f.status !== 'completed') f.status = 'canceled'
      }
      task.speedBps = 0
      this.speedWindow.delete(task.id)
      task.resumable = false
      task.errorCode = undefined
      this.runtimeAuthTokens.delete(task.id)
      // Canceled partials are never resumed — clean them once the workers exit.
      void stopped
        .then(() => this.deleteTaskPartials(task))
        .catch((error: unknown) => console.warn('[downloads] partial cleanup refused', error))
      this.persist(task)
      this.pump()
    }
    return this.list()
  }

  remove(id: string): DownloadTask[] {
    const task = this.tasks.get(id)
    if (task) {
      if (task.status === 'running' || task.status === 'queued') this.cancel(id)
      else if (task.status !== 'completed') {
        void this.deleteTaskPartials(task).catch((error: unknown) =>
          console.warn('[downloads] partial cleanup refused', error)
        )
      }
      this.tasks.delete(id)
      this.runtimeAuthTokens.delete(id)
      this.speedWindow.delete(id)
      this.dirtyTaskIds.delete(id)
      this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id)
      this.scheduleBroadcast()
    }
    return this.list()
  }

  /** Pause every running or queued task. */
  pauseAll(): DownloadTask[] {
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || task.status === 'queued') this.pause(task.id)
    }
    return this.list()
  }

  /** Resume every paused or failed task. */
  resumeAll(): DownloadTask[] {
    for (const task of this.tasks.values()) {
      if (task.status === 'paused' || task.status === 'error') this.resume(task.id)
    }
    return this.list()
  }

  /** Drop every completed task from the list (memory + DB). */
  clearCompleted(): DownloadTask[] {
    for (const task of [...this.tasks.values()]) {
      if (task.status === 'completed') this.remove(task.id)
    }
    return this.list()
  }

  /** Cancel in-flight work and drop every download task (memory + DB). */
  clearAll(): DownloadTask[] {
    this.suppressPump = true
    try {
      for (const id of [...this.tasks.keys()]) this.remove(id)
    } finally {
      this.suppressPump = false
    }
    this.pump()
    return this.list()
  }

  shutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }
    for (const [, worker] of this.workers) {
      worker.removeAllListeners()
      worker.postMessage({ type: 'abort' })
      void worker.terminate()
    }
    this.workers.clear()
    this.stoppingTasks.clear()
    const idsToFlush = new Set(this.dirtyTaskIds)
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || task.status === 'queued') idsToFlush.add(task.id)
    }
    this.persistTasks(idsToFlush)
    this.runtimeAuthTokens.clear()
    this.speedWindow.clear()
    this.latestRevisionTasks.clear()
  }
}
