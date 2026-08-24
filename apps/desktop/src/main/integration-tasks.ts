import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { BrowserWindow, dialog, shell, type WebContents } from 'electron'
import ignore from 'ignore'
import type {
  ExportIntegrationTask,
  ExportStartRequest,
  IntegrationTask,
  RepoKind,
  UploadIntegrationTask,
  UploadSelection,
  UploadStartRequest,
  UploadWarning,
  UploadWarningCode
} from '@oh-my-huggingface/shared'
import type { NotificationService } from './notifications'
import { runExport } from './integrations/export'
import {
  createRepoAndUpload,
  type UploadManifest,
  type UploadManifestFile
} from './integrations/upload'

const SELECTION_TTL_MS = 15 * 60 * 1000
const TERMINAL_TTL_MS = 10 * 60 * 1000
const MAX_TERMINAL_TASKS = 20
const MAX_FILES = 10_000
const LARGE_UPLOAD_BYTES = 50 * 1024 ** 3
const HARD_SKIP_NAMES = new Set(['.git', 'node_modules', '.ds_store'])

const ROUTE_PREFIX: Record<RepoKind, string> = {
  model: '/models',
  dataset: '/datasets',
  space: '/spaces'
}

interface SelectionRecord {
  ownerId: number
  expiresAtMs: number
  publicSelection: UploadSelection
  manifest: UploadManifest
}

export interface IntegrationTaskDeps {
  accessToken: () => string | undefined
  username: () => string | undefined
  cacheDir: () => string
  broadcast: (tasks: IntegrationTask[]) => void
  notifications: NotificationService
  /** Test seams also keep filesystem/network side effects outside task-state tests. */
  selectUploadDirectory?: (owner: WebContents) => Promise<string | null>
  runUpload?: typeof createRepoAndUpload
  runExport?: typeof runExport
  revealPath?: (path: string) => void
  now?: () => number
  createId?: () => string
}

function isTerminal(task: IntegrationTask): boolean {
  return task.status === 'done' || task.status === 'error' || task.status === 'canceled'
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const name = normalized.split('/').at(-1) ?? normalized
  return (
    name.startsWith('.env') ||
    /\.(?:pem|key|p12|pfx)$/.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name) ||
    name.startsWith('credentials') ||
    name === '.npmrc' ||
    name === '.pypirc' ||
    name === '.netrc' ||
    /^secrets?\./.test(name) ||
    /(?:^|\/)\.ssh\//.test(normalized) ||
    /(?:^|\/)\.aws\/credentials$/.test(normalized)
  )
}

async function readIgnoreFile(root: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(root, name), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw new Error('upload.ignoreUnreadable', { cause: error })
  }
}

function isSafeUploadRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false
  if (
    [...path].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
    })
  ) {
    return false
  }
  return path.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

export async function scanUploadFolder(rootPath: string): Promise<{
  manifest: UploadManifest
  excludedCount: number
  warnings: UploadWarning[]
  totalBytes: number
}> {
  const rootEntry = await lstat(rootPath)
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory())
    throw new Error('upload.invalidFolder')
  const rootRealPath = await realpath(rootPath)
  const rootStats = await stat(rootRealPath)
  if (!rootStats.isDirectory()) throw new Error('upload.invalidFolder')

  const matcher = ignore()
  for (const name of ['.gitignore', '.hfignore']) {
    const contents = await readIgnoreFile(rootRealPath, name)
    if (contents) matcher.add(contents)
  }

  const files: UploadManifestFile[] = []
  const sensitivePaths: string[] = []
  let sensitiveOverflow = 0
  let totalBytes = 0
  let excludedCount = 0

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!isSafeUploadRelativePath(rel)) throw new Error('upload.invalidPath')
      if (
        HARD_SKIP_NAMES.has(entry.name.toLowerCase()) ||
        matcher.ignores(entry.isDirectory() ? `${rel}/` : rel)
      ) {
        excludedCount++
        continue
      }
      const absolutePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        excludedCount++
        continue
      }
      if (entry.isDirectory()) {
        const directoryEntry = await lstat(absolutePath)
        const resolvedDirectory = await realpath(absolutePath)
        const directoryStats = await stat(resolvedDirectory)
        if (
          directoryEntry.isSymbolicLink() ||
          !directoryStats.isDirectory() ||
          !isInside(rootRealPath, resolvedDirectory)
        ) {
          throw new Error('upload.invalidFolder')
        }
        await visit(resolvedDirectory, rel)
        continue
      }
      if (!entry.isFile()) {
        // Sockets, FIFOs and devices are not ordinary upload content. Reject
        // the selection instead of silently presenting an incomplete manifest.
        throw new Error('upload.specialFile')
      }

      const fileEntry = await lstat(absolutePath)
      const resolved = await realpath(absolutePath)
      const fileStats = await stat(resolved)
      if (fileEntry.isSymbolicLink() || !fileStats.isFile() || !isInside(rootRealPath, resolved)) {
        excludedCount++
        continue
      }
      files.push({
        relativePath: rel,
        absolutePath: resolved,
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs,
        dev: fileStats.dev,
        ino: fileStats.ino
      })
      if (files.length > MAX_FILES) throw new Error('upload.tooManyFiles')
      totalBytes += fileStats.size
      if (isSensitivePath(rel)) {
        if (sensitivePaths.length < 20) sensitivePaths.push(rel)
        else sensitiveOverflow++
      }
    }
  }
  await visit(rootRealPath, '')

  const warnings: UploadWarning[] = []
  if (sensitivePaths.length > 0) {
    warnings.push({
      code: 'sensitive-path',
      paths: sensitivePaths,
      overflow: sensitiveOverflow,
      requiresAcknowledgement: true
    })
  }
  if (totalBytes > LARGE_UPLOAD_BYTES) {
    warnings.push({ code: 'large-upload', requiresAcknowledgement: true })
  }

  return {
    manifest: {
      rootPath,
      rootRealPath,
      rootDev: rootStats.dev,
      rootIno: rootStats.ino,
      files
    },
    excludedCount,
    warnings,
    totalBytes
  }
}

export class IntegrationTaskManager {
  private readonly selections = new Map<string, SelectionRecord>()
  private readonly tasks = new Map<string, IntegrationTask>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly outputPaths = new Map<string, string>()
  private readonly ownersWithSelectionCleanup = new Set<number>()

  constructor(private readonly deps: IntegrationTaskDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private createId(): string {
    return this.deps.createId?.() ?? randomUUID()
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }

  private ensureSelectionCleanup(owner: WebContents): void {
    if (this.ownersWithSelectionCleanup.has(owner.id)) return
    this.ownersWithSelectionCleanup.add(owner.id)
    owner.once('destroyed', () => {
      this.ownersWithSelectionCleanup.delete(owner.id)
      this.revokeSelections(owner.id)
    })
  }

  list(): IntegrationTask[] {
    this.prune()
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => structuredClone(task))
  }

  async selectUploadFolder(owner: WebContents): Promise<UploadSelection | null> {
    this.prune()
    if (owner.isDestroyed?.()) return null
    this.ensureSelectionCleanup(owner)
    let rootPath: string | null | undefined
    if (this.deps.selectUploadDirectory) {
      rootPath = await this.deps.selectUploadDirectory(owner)
    } else {
      const parent = BrowserWindow.fromWebContents(owner)
      const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      rootPath = result.canceled ? undefined : result.filePaths[0]
    }
    if (!rootPath) return null

    const scanned = await scanUploadFolder(rootPath)
    if (owner.isDestroyed?.()) return null
    const selectionId = this.createId()
    const expiresAtMs = this.now() + SELECTION_TTL_MS
    const publicSelection: UploadSelection = {
      selectionId,
      label: basename(scanned.manifest.rootRealPath),
      expiresAt: new Date(expiresAtMs).toISOString(),
      fileCount: scanned.manifest.files.length,
      totalBytes: scanned.totalBytes,
      excludedCount: scanned.excludedCount,
      warnings: scanned.warnings
    }
    this.selections.set(selectionId, {
      ownerId: owner.id,
      expiresAtMs,
      publicSelection,
      manifest: scanned.manifest
    })
    return structuredClone(publicSelection)
  }

  startUpload(request: UploadStartRequest, ownerId: number): { id: string } {
    this.prune()
    if (this.hasActive('upload')) throw new Error('upload.alreadyRunning')
    const selected = this.selections.get(request.selectionId)
    if (!selected) throw new Error('upload.selectionExpired')
    if (selected.ownerId !== ownerId) throw new Error('upload.selectionExpired')
    if (selected.expiresAtMs <= this.now()) {
      this.selections.delete(request.selectionId)
      throw new Error('upload.selectionExpired')
    }
    const acknowledged = new Set<UploadWarningCode>(request.acknowledgedWarningCodes)
    const missing = selected.publicSelection.warnings.find(
      (warning) => warning.requiresAcknowledgement && !acknowledged.has(warning.code)
    )
    if (missing) throw new Error(`upload.warningNotAcknowledged:${missing.code}`)
    this.selections.delete(request.selectionId)

    const id = this.createId()
    const now = this.timestamp()
    const username = this.deps.username()
    const task: UploadIntegrationTask = {
      id,
      kind: 'upload',
      repoKind: request.kind,
      repoId: username ? `${username}/${request.name}` : undefined,
      status: 'preparing',
      phase: 'preparing',
      progress: 0,
      createdAt: now,
      updatedAt: now
    }
    const controller = new AbortController()
    this.tasks.set(id, task)
    this.controllers.set(id, controller)
    this.emit()
    void this.executeUpload(task, request, selected.manifest, controller)
    return { id }
  }

  recordExportError(request: ExportStartRequest, error: unknown): void {
    this.prune()
    const message = (error instanceof Error ? error.message : String(error)).trim().slice(0, 200)
    const id = this.createId()
    const now = this.timestamp()
    const task: ExportIntegrationTask = {
      id,
      kind: 'export',
      tool: request.tool,
      repoKind: request.kind,
      repoId: request.repoId,
      filePath: request.filePath,
      status: 'error',
      phase: 'error',
      createdAt: now,
      updatedAt: now,
      messageKey: message === 'export.alreadyRunning' ? 'export.alreadyRunning' : 'export.failed',
      params: message === 'export.alreadyRunning' ? undefined : { error: message }
    }
    this.tasks.set(id, task)
    this.emit()
  }

  startExport(request: ExportStartRequest): { id: string } {
    this.prune()
    if (this.hasActive('export')) throw new Error('export.alreadyRunning')
    const id = this.createId()
    const now = this.timestamp()
    const task: ExportIntegrationTask = {
      id,
      kind: 'export',
      tool: request.tool,
      repoKind: request.kind,
      repoId: request.repoId,
      filePath: request.filePath,
      status: 'preparing',
      phase: 'preparing',
      progress: 0,
      createdAt: now,
      updatedAt: now
    }
    const controller = new AbortController()
    this.tasks.set(id, task)
    this.controllers.set(id, controller)
    this.emit()
    void this.executeExport(task, request, controller)
    return { id }
  }

  cancel(id: string, kind: 'upload' | 'export'): { canceled: boolean } {
    const task = this.tasks.get(id)
    if (task?.kind === kind && task.status === 'canceled') return { canceled: true }
    const controller = this.controllers.get(id)
    if (!task || task.kind !== kind || !controller || isTerminal(task)) return { canceled: false }
    controller.abort()
    this.updateTask(task.id, { status: 'canceled', phase: 'canceled' })
    return { canceled: true }
  }

  revealOutput(id: string): void {
    const task = this.tasks.get(id)
    const path = this.outputPaths.get(id)
    if (!task || task.status !== 'done' || !path) throw new Error('integration.outputUnavailable')
    ;(this.deps.revealPath ?? shell.showItemInFolder)(path)
  }

  shutdown(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    this.selections.clear()
  }

  private async executeUpload(
    task: UploadIntegrationTask,
    request: UploadStartRequest,
    manifest: UploadManifest,
    controller: AbortController
  ): Promise<void> {
    try {
      const result = await (this.deps.runUpload ?? createRepoAndUpload)(
        { kind: request.kind, name: request.name, private: request.private, manifest },
        {
          accessToken: this.deps.accessToken(),
          username: this.deps.username(),
          signal: controller.signal,
          onProgress: (progress) => {
            this.updateTask(task.id, {
              status: progress.phase === 'preparing' ? 'preparing' : 'running',
              phase: progress.phase,
              progress: progress.progress,
              path: progress.path
            })
          }
        }
      )
      controller.signal.throwIfAborted()
      if (!result.ok) {
        this.updateTask(task.id, {
          status: 'error',
          phase: 'error',
          progress: result.progress,
          messageKey: result.messageKey,
          params: result.params
        })
        return
      }
      const completed = this.updateTask(task.id, {
        status: 'done',
        phase: 'done',
        progress: 1,
        repoId: result.repoId,
        repoUrl: result.repoUrl,
        messageKey: result.messageKey,
        params: result.params
      })
      if (!completed) return
      this.deps.notifications.show(
        'notifications.uploadComplete',
        'notifications.uploadCompleteBody',
        { repo: result.repoId },
        `${ROUTE_PREFIX[request.kind]}/${result.repoId}`
      )
    } catch (err) {
      if (controller.signal.aborted) {
        this.updateTask(task.id, { status: 'canceled', phase: 'canceled' })
      } else {
        this.updateTask(task.id, {
          status: 'error',
          phase: 'error',
          messageKey: 'upload.failed',
          params: {
            error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
          }
        })
      }
    } finally {
      this.controllers.delete(task.id)
    }
  }

  private async executeExport(
    task: ExportIntegrationTask,
    request: ExportStartRequest,
    controller: AbortController
  ): Promise<void> {
    try {
      const result = await (this.deps.runExport ?? runExport)(
        request.tool,
        request.kind,
        request.repoId,
        request.filePath,
        {
          cacheDir: this.deps.cacheDir(),
          resolvedCommit: request.resolvedCommit,
          signal: controller.signal,
          onProgress: ({ phase, progress }) =>
            this.updateTask(task.id, { status: 'running', phase, progress })
        }
      )
      controller.signal.throwIfAborted()
      if (!result.ok) {
        this.updateTask(task.id, {
          status: 'error',
          phase: 'error',
          messageKey: result.messageKey,
          params: result.params
        })
        return
      }
      if (result.outputPath) this.outputPaths.set(task.id, result.outputPath)
      const completed = this.updateTask(task.id, {
        status: 'done',
        phase: 'done',
        progress: 1,
        outputLabel: result.outputLabel,
        messageKey: result.messageKey,
        params: result.params
      })
      if (!completed) return
      this.deps.notifications.show(
        'notifications.exportComplete',
        'notifications.exportCompleteBody',
        {
          name: result.outputLabel ?? request.filePath
        }
      )
    } catch (err) {
      if (controller.signal.aborted) {
        this.updateTask(task.id, { status: 'canceled', phase: 'canceled' })
      } else {
        this.updateTask(task.id, {
          status: 'error',
          phase: 'error',
          messageKey: 'export.failed',
          params: {
            error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
          }
        })
      }
    } finally {
      this.controllers.delete(task.id)
    }
  }

  private hasActive(kind: IntegrationTask['kind']): boolean {
    return [...this.tasks.values()].some((task) => task.kind === kind && !isTerminal(task))
  }

  private updateTask(id: string, patch: Partial<IntegrationTask>): boolean {
    const task = this.tasks.get(id)
    if (!task || isTerminal(task)) return false
    Object.assign(task, patch, { updatedAt: this.timestamp() })
    this.emit()
    return true
  }

  private revokeSelections(ownerId: number): void {
    for (const [id, selection] of this.selections) {
      if (selection.ownerId === ownerId) this.selections.delete(id)
    }
  }

  private prune(): void {
    const cutoff = this.now() - TERMINAL_TTL_MS
    for (const [id, task] of this.tasks) {
      if (isTerminal(task) && Date.parse(task.updatedAt) < cutoff) {
        this.tasks.delete(id)
        this.outputPaths.delete(id)
      }
    }
    const terminal = [...this.tasks.values()]
      .filter(isTerminal)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    for (const task of terminal.slice(MAX_TERMINAL_TASKS)) {
      this.tasks.delete(task.id)
      this.outputPaths.delete(task.id)
    }
    for (const [id, selection] of this.selections) {
      if (selection.expiresAtMs <= this.now()) this.selections.delete(id)
    }
  }

  private emit(): void {
    this.prune()
    this.deps.broadcast(this.list())
  }
}
