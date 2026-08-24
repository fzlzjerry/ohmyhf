import { existsSync } from 'node:fs'
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  unlink
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { defaultCacheDir, repoCachePaths } from '@oh-my-huggingface/hub-api'
import {
  isValidRepoId,
  type CacheReport,
  type CacheSnapshot,
  type FileTextResult,
  type ResolvedCacheFile,
  type RepoKind
} from '@oh-my-huggingface/shared'
import type { SettingsStore } from './settings'

const COMMIT_HASH = /^[0-9a-f]{40}$/
const PARTIAL_MAX_AGE_MS = 10 * 60_000

interface SafeRepo {
  repo: string
  blobsDir: string
  snapshotsDir: string
  refsDir: string
  blobsExist: boolean
  snapshotsExist: boolean
  refsExist: boolean
}

interface SnapshotDirectory {
  name: string
  path: string
}

interface RevisionDeletionPlan {
  repo: string
  snapshots: string[]
  refs: string[]
  blobs: string[]
  removeRepo: boolean
}

export class CacheManager {
  /**
   * @param protectedTaskIds returns the download task ids whose in-progress
   *   partials are still resumable; their `.incomplete.<id>-*` files are spared
   *   by cleanPartials even when the mtime looks stale (a paused download's
   *   partial has a frozen mtime but is not an orphan).
   * @param protectedCommitHashes returns commits used by active or resumable
   *   downloads for one repository. Renderer input is deliberately not used for
   *   this decision.
   */
  constructor(
    private readonly settings: SettingsStore,
    private readonly protectedTaskIds: () => ReadonlySet<string> = () => new Set(),
    private readonly protectedCommitHashes: (
      kind: RepoKind,
      repoId: string
    ) => ReadonlySet<string> = () => new Set()
  ) {}

  cacheDir(): string {
    return this.settings.get().hfCacheDir ?? defaultCacheDir()
  }

  /** Scan runs in a worker thread; the traversal can touch hundreds of GB. */
  scan(): Promise<CacheReport> {
    const cacheDir = this.cacheDir()
    if (!existsSync(cacheDir)) {
      return Promise.resolve({
        root: cacheDir,
        totalSize: 0,
        repos: [],
        scannedAt: new Date().toISOString()
      })
    }
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(join(__dirname, 'cache-worker.mjs'), {
        workerData: { cacheDir }
      })
      worker.once('message', (report: CacheReport) => {
        resolvePromise(report)
        void worker.terminate()
      })
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`cache scan exited with code ${code}`))
      })
    })
  }

  /**
   * Resolve a repository from its logical identity. This is the only path that
   * cache reveal IPC should use; it applies the same anti-symlink and boundary
   * checks as destructive cache operations.
   */
  async resolveRepo(kind: RepoKind, repoId: string): Promise<string> {
    const safeRepo = await resolveSafeRepo(this.cacheDir(), kind, repoId)
    if (!safeRepo) throw new Error('Repository cache does not exist')
    return safeRepo.repo
  }

  /**
   * Delete snapshot revisions, their refs, and blobs no longer referenced by a
   * remaining snapshot. The repository path is always derived in main from the
   * configured cache root and the logical repository identity.
   */
  async deleteRevisions(
    kind: RepoKind,
    repoId: string,
    commitHashes: string[]
  ): Promise<CacheReport> {
    await deleteRevisionFiles(
      this.cacheDir(),
      kind,
      repoId,
      commitHashes,
      this.protectedCommitHashes(kind, repoId)
    )
    return this.scan()
  }

  /**
   * Delete leftover `*.incomplete*` download partials in a repository's blobs
   * directory. The path is derived and validated in main before any deletion.
   */
  async cleanPartials(kind: RepoKind, repoId: string): Promise<CacheReport> {
    await deleteRepoPartials(this.cacheDir(), kind, repoId, this.protectedTaskIds())
    return this.scan()
  }

  /** Read one immutable snapshot; symbolic refs and latest-directory fallback are forbidden. */
  async snapshot(kind: RepoKind, repoId: string, commit: string): Promise<CacheSnapshot | null> {
    return readCacheSnapshot(this.cacheDir(), kind, repoId, commit)
  }

  /** Resolve an exact cache file for trusted main-process consumers. */
  async resolveFilePath(
    kind: RepoKind,
    repoId: string,
    commit: string,
    path: string
  ): Promise<{ absolutePath: string; info: ResolvedCacheFile } | null> {
    const snapshot = await resolveSnapshot(this.cacheDir(), kind, repoId, commit)
    if (!snapshot || !isSafeRelativeFilePath(path)) return null
    const absolutePath = await resolveSnapshotFile(snapshot.path, snapshot.blobsDir, path)
    if (!absolutePath) return null
    const entry = await stat(absolutePath)
    return {
      absolutePath,
      info: { kind, repoId, commit: snapshot.commit, path, size: entry.size }
    }
  }

  async readText(
    kind: RepoKind,
    repoId: string,
    path: string,
    maxBytes: number | undefined,
    commit: string
  ): Promise<FileTextResult | null> {
    return readCachedText(this.cacheDir(), kind, repoId, path, maxBytes ?? 512 * 1024, commit)
  }
}

/**
 * Filesystem half of deleteRevisions, exported for focused tests. It performs a
 * complete read-only preflight before the first mutation so one unsafe revision,
 * ref, blob, symlink, or junction cannot leave a partially deleted repository.
 *
 * Blob GC only runs when references are provable: the copy-fallback layout
 * (Windows without the symlink privilege) yields zero symlinks, and treating its
 * blobs as unreferenced would wipe the store. With revisions remaining and no
 * detectable references, blob GC is skipped entirely.
 */
export async function deleteRevisionFiles(
  cacheDir: string,
  kind: RepoKind,
  repoId: string,
  commitHashes: string[],
  protectedCommitHashes: ReadonlySet<string> = new Set()
): Promise<void> {
  const hashes = validateCommitHashes(commitHashes)
  const protectedHash = hashes.find((hash) => protectedCommitHashes.has(hash))
  if (protectedHash) {
    throw new Error(`Cannot delete revision used by an active download: ${protectedHash}`)
  }

  const safeRepo = await resolveSafeRepo(cacheDir, kind, repoId)
  if (!safeRepo) return

  const plan = await prepareRevisionDeletion(safeRepo, hashes)
  if (!plan) return

  // All paths and contents were validated above. No mutation happens before
  // this point, preserving all-or-nothing behavior for validation failures.
  for (const snapshot of plan.snapshots) {
    await rm(snapshot, { recursive: true, force: true })
  }
  for (const ref of plan.refs) await unlink(ref)
  for (const blob of plan.blobs) await rm(blob, { force: true })
  if (plan.removeRepo) await rm(plan.repo, { recursive: true, force: true })
}

/**
 * Delete leftover `*.incomplete*` partials from a logically addressed repo.
 * Every blobs entry is validated before stale candidates are removed, preventing
 * a malicious blobs symlink/junction from redirecting cleanup outside the cache.
 */
export async function deleteRepoPartials(
  cacheDir: string,
  kind: RepoKind,
  repoId: string,
  protectedTaskIds: ReadonlySet<string> = new Set()
): Promise<void> {
  const safeRepo = await resolveSafeRepo(cacheDir, kind, repoId)
  if (!safeRepo?.blobsExist) return

  const stalePartials: string[] = []
  const protectedMarkers = [...protectedTaskIds].map((id) => `.incomplete.${id}`)
  for (const name of await readdir(safeRepo.blobsDir)) {
    const full = join(safeRepo.blobsDir, name)
    const entry = await lstat(full)
    assertRegularFile(entry, `blob ${name}`)
    assertDirectChild(safeRepo.blobsDir, await realpath(full), `blob ${name}`)

    if (!name.includes('.incomplete')) continue
    if (protectedMarkers.some((marker) => name.includes(marker))) continue
    if (Date.now() - entry.mtimeMs < PARTIAL_MAX_AGE_MS) continue
    stalePartials.push(full)
  }

  // The loop above is a complete read-only preflight of the blobs directory.
  for (const partial of stalePartials) await rm(partial, { force: true })
}

async function prepareRevisionDeletion(
  safeRepo: SafeRepo,
  hashes: string[]
): Promise<RevisionDeletionPlan | null> {
  const snapshots = await inspectSnapshotDirectories(safeRepo)
  const selected = snapshots.filter(({ name }) => hashes.includes(name))
  if (selected.length === 0) return null

  const remaining = snapshots.filter(({ name }) => !hashes.includes(name))
  const blobFiles = await inspectBlobFiles(safeRepo)
  const refFiles = await inspectRefFiles(safeRepo)

  // Validate every selected tree too. `rm` unlinks leaf symlinks rather than
  // following them, but accepting a link outside blobs would make the safety
  // invariant hard to audit and could become dangerous after a future refactor.
  for (const snapshot of selected) {
    await collectSnapshotReferences(snapshot.path, safeRepo, new Set())
  }

  const referenced = new Set<string>()
  for (const snapshot of remaining) {
    await collectSnapshotReferences(snapshot.path, safeRepo, referenced)
  }

  const refs: string[] = []
  for (const refPath of refFiles) {
    const target = (await readFile(refPath, 'utf8')).trim()
    if (hashes.includes(target)) refs.push(refPath)
  }

  const blobs: string[] = []
  if (remaining.length === 0 || referenced.size > 0) {
    for (const { name, path } of blobFiles) {
      if (!referenced.has(path) && !name.includes('.incomplete')) blobs.push(path)
    }
  }

  if (remaining.length === 0) await validateExtraRepoEntries(safeRepo)

  return {
    repo: safeRepo.repo,
    snapshots: selected.map(({ path }) => path),
    refs,
    blobs,
    removeRepo: remaining.length === 0
  }
}

async function resolveSafeRepo(
  cacheDir: string,
  kind: RepoKind,
  repoId: string
): Promise<SafeRepo | null> {
  if (!isAbsolute(cacheDir)) throw new Error('Cache directory must be absolute')
  if (!isValidRepoId(repoId)) throw new Error('Invalid repository id')

  const cacheRoot = resolve(cacheDir)
  const derived = repoCachePaths(cacheRoot, kind, repoId)
  const expectedRepo = resolve(derived.repoDir)
  const expectedRelative = relative(cacheRoot, expectedRepo)
  if (!isSinglePathSegment(expectedRelative)) {
    throw new Error('Derived repository path is outside the configured cache directory')
  }

  const rootEntry = await lstatIfExists(cacheRoot)
  if (!rootEntry) return null
  assertDirectory(rootEntry, 'cache root')
  const realRoot = await realpath(cacheRoot)

  const repoEntry = await lstatIfExists(expectedRepo)
  if (!repoEntry) return null
  assertDirectory(repoEntry, 'repository')
  const realRepo = await realpath(expectedRepo)
  const actualRelative = relative(realRoot, realRepo)
  if (actualRelative !== expectedRelative || !isSinglePathSegment(actualRelative)) {
    throw new Error('Repository resolves outside the configured cache directory')
  }

  const blobs = await resolveStructuralDirectory(realRepo, 'blobs')
  const snapshots = await resolveStructuralDirectory(realRepo, 'snapshots')
  const refs = await resolveStructuralDirectory(realRepo, 'refs')
  return {
    repo: realRepo,
    blobsDir: blobs.path,
    snapshotsDir: snapshots.path,
    refsDir: refs.path,
    blobsExist: blobs.exists,
    snapshotsExist: snapshots.exists,
    refsExist: refs.exists
  }
}

async function resolveStructuralDirectory(
  repo: string,
  name: 'blobs' | 'snapshots' | 'refs'
): Promise<{ path: string; exists: boolean }> {
  const path = join(repo, name)
  const entry = await lstatIfExists(path)
  if (!entry) return { path, exists: false }
  assertDirectory(entry, name)
  const real = await realpath(path)
  if (relative(repo, real) !== name) {
    throw new Error(`Unsafe cache path: ${name} resolves outside its repository`)
  }
  return { path: real, exists: true }
}

async function inspectSnapshotDirectories(safeRepo: SafeRepo): Promise<SnapshotDirectory[]> {
  if (!safeRepo.snapshotsExist) return []
  const snapshots: SnapshotDirectory[] = []
  for (const name of await readdir(safeRepo.snapshotsDir)) {
    const path = join(safeRepo.snapshotsDir, name)
    const entry = await lstat(path)
    assertDirectory(entry, `snapshot ${name}`)
    const real = await realpath(path)
    assertDirectChild(safeRepo.snapshotsDir, real, `snapshot ${name}`)
    snapshots.push({ name, path: real })
  }
  return snapshots
}

async function inspectBlobFiles(
  safeRepo: SafeRepo
): Promise<Array<{ name: string; path: string }>> {
  if (!safeRepo.blobsExist) return []
  const blobs: Array<{ name: string; path: string }> = []
  for (const name of await readdir(safeRepo.blobsDir)) {
    const path = join(safeRepo.blobsDir, name)
    const entry = await lstat(path)
    assertRegularFile(entry, `blob ${name}`)
    const real = await realpath(path)
    assertDirectChild(safeRepo.blobsDir, real, `blob ${name}`)
    blobs.push({ name, path: real })
  }
  return blobs
}

async function inspectRefFiles(safeRepo: SafeRepo): Promise<string[]> {
  if (!safeRepo.refsExist) return []
  return listRegularFilesRecursive(safeRepo.refsDir, safeRepo.refsDir, 'ref')
}

async function listRegularFilesRecursive(
  directory: string,
  boundary: string,
  label: string
): Promise<string[]> {
  const files: string[] = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      throw new Error(`Unsafe cache path: ${label} ${name} is a symbolic link or junction`)
    }
    if (entry.isDirectory()) {
      const real = await realpath(path)
      assertContained(boundary, real, `${label} directory ${name}`)
      files.push(...(await listRegularFilesRecursive(real, boundary, label)))
      continue
    }
    assertRegularFile(entry, `${label} ${name}`)
    const real = await realpath(path)
    assertContained(boundary, real, `${label} ${name}`)
    files.push(real)
  }
  return files
}

async function collectSnapshotReferences(
  directory: string,
  safeRepo: SafeRepo,
  out: Set<string>
): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isDirectory()) {
      const real = await realpath(path)
      assertContained(directory, real, `snapshot directory ${name}`)
      await collectSnapshotReferences(real, safeRepo, out)
      continue
    }
    if (entry.isSymbolicLink()) {
      if (!safeRepo.blobsExist) {
        throw new Error(`Unsafe cache path: snapshot link ${name} has no blobs directory`)
      }
      const target = resolve(dirname(path), await readlink(path))
      assertContained(safeRepo.blobsDir, target, `snapshot link ${name}`)
      const targetEntry = await lstatIfExists(target)
      if (!targetEntry) throw new Error(`Unsafe cache path: snapshot link ${name} is broken`)
      assertRegularFile(targetEntry, `snapshot link target ${name}`)
      const realTarget = await realpath(target)
      assertDirectChild(safeRepo.blobsDir, realTarget, `snapshot link ${name}`)
      out.add(realTarget)
      continue
    }
    assertRegularFile(entry, `snapshot file ${name}`)
  }
}

/** Validate non-standard repo entries before recursively removing the last snapshot. */
async function validateExtraRepoEntries(safeRepo: SafeRepo): Promise<void> {
  for (const name of await readdir(safeRepo.repo)) {
    if (name === 'blobs' || name === 'snapshots' || name === 'refs') continue
    await validateNoLinks(join(safeRepo.repo, name), safeRepo.repo)
  }
}

async function validateNoLinks(path: string, boundary: string): Promise<void> {
  const entry = await lstat(path)
  if (entry.isSymbolicLink()) {
    throw new Error(`Unsafe cache path: ${relative(boundary, path)} is a symbolic link or junction`)
  }
  if (entry.isDirectory()) {
    const real = await realpath(path)
    assertContained(boundary, real, `directory ${relative(boundary, path)}`)
    for (const name of await readdir(real)) await validateNoLinks(join(real, name), boundary)
    return
  }
  assertRegularFile(entry, `entry ${relative(boundary, path)}`)
  assertContained(boundary, await realpath(path), `entry ${relative(boundary, path)}`)
}

function validateCommitHashes(commitHashes: string[]): string[] {
  if (commitHashes.length < 1 || commitHashes.length > 100) {
    throw new Error('Expected between 1 and 100 commit hashes')
  }
  const hashes = [...new Set(commitHashes)]
  if (hashes.some((hash) => !COMMIT_HASH.test(hash))) throw new Error('Invalid commit hash')
  return hashes
}

function assertDirectory(entry: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (entry.isSymbolicLink()) {
    throw new Error(`Unsafe cache path: ${label} is a symbolic link or junction`)
  }
  if (!entry.isDirectory()) throw new Error(`Unsafe cache path: ${label} is not a directory`)
}

function assertRegularFile(entry: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (entry.isSymbolicLink()) {
    throw new Error(`Unsafe cache path: ${label} is a symbolic link or junction`)
  }
  if (!entry.isFile()) throw new Error(`Unsafe cache path: ${label} is not a regular file`)
}

function assertDirectChild(parent: string, child: string, label: string): void {
  const rel = relative(parent, child)
  if (!isSinglePathSegment(rel)) {
    throw new Error(`Unsafe cache path: ${label} resolves outside its parent`)
  }
}

function assertContained(parent: string, child: string, label: string): void {
  const rel = relative(parent, child)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe cache path: ${label} resolves outside its parent`)
  }
}

function isSinglePathSegment(path: string): boolean {
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path) &&
    !path.includes(sep)
  )
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export async function readCacheSnapshot(
  cacheDir: string,
  kind: RepoKind,
  repoId: string,
  commit: string
): Promise<CacheSnapshot | null> {
  const latest = await resolveSnapshot(cacheDir, kind, repoId, commit)
  if (!latest) return null
  const files: Array<{ path: string; size: number }> = []
  await walkSnapshotFiles(latest.path, latest.path, latest.blobsDir, files)
  return { commit: latest.commit, files }
}

export async function readCachedText(
  cacheDir: string,
  kind: RepoKind,
  repoId: string,
  filePath: string,
  maxBytes: number,
  commit: string
): Promise<FileTextResult | null> {
  const latest = await resolveSnapshot(cacheDir, kind, repoId, commit)
  if (!latest) return null
  if (!isSafeRelativeFilePath(filePath)) return null
  const resolved = await resolveSnapshotFile(latest.path, latest.blobsDir, filePath)
  if (!resolved) return null
  const file = await open(resolved, 'r')
  try {
    const size = (await file.stat()).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, 0)
    return {
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: size > maxBytes,
      size
    }
  } finally {
    await file.close()
  }
}

async function resolveSnapshot(
  cacheDir: string,
  kind: RepoKind,
  repoId: string,
  commit: string
): Promise<{ commit: string; path: string; blobsDir: string | null } | null> {
  const normalized = commit.toLowerCase()
  if (!COMMIT_HASH.test(normalized)) throw new Error('Invalid commit hash')
  const safeRepo = await resolveSafeRepo(cacheDir, kind, repoId)
  if (!safeRepo?.snapshotsExist) return null
  const snapshots = await inspectSnapshotDirectories(safeRepo)
  if (snapshots.length === 0) return null
  const chosen = snapshots.find((snapshot) => snapshot.name === normalized)
  if (!chosen) return null
  return {
    commit: chosen.name,
    path: chosen.path,
    blobsDir: safeRepo.blobsExist ? safeRepo.blobsDir : null
  }
}

function isSafeRelativeFilePath(path: string): boolean {
  return path
    .split('/')
    .every(
      (segment) =>
        Boolean(segment) && segment !== '.' && segment !== '..' && !segment.includes('\\')
    )
}

async function resolveSnapshotFile(
  snapshotRoot: string,
  blobsDir: string | null,
  filePath: string
): Promise<string | null> {
  const target = resolve(snapshotRoot, ...filePath.split('/'))
  const rel = relative(snapshotRoot, target)
  if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  const entry = await lstatIfExists(target)
  if (!entry) return null
  if (entry.isSymbolicLink()) {
    if (!blobsDir) return null
    const linked = resolve(dirname(target), await readlink(target))
    assertContained(blobsDir, linked, `snapshot link ${filePath}`)
    const real = await realpath(linked)
    assertDirectChild(blobsDir, real, `snapshot link ${filePath}`)
    return real
  }
  if (!entry.isFile()) return null
  const real = await realpath(target)
  assertContained(snapshotRoot, real, `snapshot file ${filePath}`)
  return real
}

async function walkSnapshotFiles(
  directory: string,
  snapshotRoot: string,
  blobsDir: string | null,
  out: Array<{ path: string; size: number }>
): Promise<void> {
  for (const name of await readdir(directory)) {
    const full = join(directory, name)
    const entry = await lstat(full)
    const rel = relative(snapshotRoot, full).split(sep).join('/')
    if (entry.isDirectory()) {
      const real = await realpath(full)
      assertContained(snapshotRoot, real, `snapshot directory ${name}`)
      await walkSnapshotFiles(real, snapshotRoot, blobsDir, out)
      continue
    }
    if (entry.isSymbolicLink()) {
      if (!blobsDir) continue
      const linked = resolve(dirname(full), await readlink(full))
      assertContained(blobsDir, linked, `snapshot link ${name}`)
      const real = await realpath(linked)
      assertDirectChild(blobsDir, real, `snapshot link ${name}`)
      out.push({ path: rel, size: (await stat(real)).size })
      continue
    }
    if (entry.isFile()) {
      assertContained(snapshotRoot, await realpath(full), `snapshot file ${name}`)
      out.push({ path: rel, size: entry.size })
    }
  }
}
