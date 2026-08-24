/**
 * Downloads one file into the standard HF cache layout. Runs in a worker_thread so
 * hashing and disk IO never block the main process.
 *
 * Protocol (parentPort messages):
 *   in : { type: 'abort' }
 *        { type: 'limit', limitBps }   // live per-worker share of the speed limit
 *   out: { type: 'meta', commit, etag, size, isLfs }
 *        { type: 'progress', received, size }
 *        { type: 'done', received, verified, snapshotPath, localSha256 }
 *        { type: 'error', message }
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

export interface DownloadJob {
  /** Download-task id owning this file; keys the task-unique partial file. */
  taskId: string
  /** resolve URL, e.g. https://huggingface.co/org/name/resolve/main/file.bin */
  url: string
  /** "models--org--name" repo directory inside the cache. */
  repoDir: string
  /** Frozen absolute cache root used to validate repoDir before any write. */
  cacheDir: string
  /** Repo-relative file path. */
  path: string
  /** Commit resolved by the manager before the file tree was enumerated. */
  expectedCommit: string
  authToken?: string
  /** Per-worker share of the aggregate speed limit; null/undefined = unlimited. */
  speedLimitBps?: number | null
  userAgent: string
  /** App-level HTTP(S) proxy; null/undefined = direct Node fetch. */
  proxyUrl?: string | null
}

// Guarded so tests can import Throttle/gitBlobSha1OfFile outside a worker thread.
const job = (workerData ?? {}) as DownloadJob
const port = parentPort

function post(msg: object): void {
  port?.postMessage(msg)
}

const proxyAgent = job.proxyUrl ? new ProxyAgent(job.proxyUrl) : null

function httpFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!proxyAgent) return fetch(input, init)
  return undiciFetch(input, {
    ...(init as object),
    dispatcher: proxyAgent
  }) as unknown as Promise<Response>
}

let aborted = false
let abortController = new AbortController()
port?.on('message', (msg: { type?: string; limitBps?: number | null }) => {
  if (msg?.type === 'abort') {
    aborted = true
    abortController.abort()
  } else if (msg?.type === 'limit') {
    throttle.setLimit(msg.limitBps ?? null)
  }
})

/**
 * Auth is only sent to the Hub host itself, never across redirects to CDNs —
 * signed storage URLs reject requests carrying a second auth mechanism.
 */
function requestHeaders(url: string): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': job.userAgent,
    'Accept-Encoding': 'identity'
  }
  if (job.authToken && new URL(url).host === new URL(job.url).host) {
    h.Authorization = `Bearer ${job.authToken}`
  }
  return h
}

interface FileMetadata {
  commit: string
  etag: string
  size: number
  isLfs: boolean
  downloadUrl: string
}

/**
 * Reject a drifting or malicious resolve response before any cache directory is
 * created. The manager only schedules 40-hex commit-pinned URLs; the response
 * must attest to that exact commit as well.
 */
export function assertExpectedCommit(actual: string, expected: string): string {
  const normalizedActual = actual.toLowerCase()
  const normalizedExpected = expected.toLowerCase()
  if (
    !/^[0-9a-f]{40}$/.test(normalizedActual) ||
    !/^[0-9a-f]{40}$/.test(normalizedExpected) ||
    normalizedActual !== normalizedExpected
  ) {
    throw new Error('commit-mismatch')
  }
  return normalizedActual
}

export function assertSafeCacheKey(value: string): string {
  const normalized = value.toLowerCase()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalized)) {
    throw new Error('invalid-etag')
  }
  return normalized
}

export function assertSafeRepoFilePath(path: string): void {
  const segments = path.split('/')
  if (
    path.startsWith('/') ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        segment.includes('\0')
    )
  ) {
    throw new Error('unsafe-file-path')
  }
}

/**
 * HF puts LFS metadata on the *redirect* response, so redirects are handled manually
 * (mirrors huggingface_hub's hf_hub_download).
 */
async function fetchMetadata(): Promise<FileMetadata> {
  const res = await httpFetch(job.url, {
    method: 'HEAD',
    headers: requestHeaders(job.url),
    redirect: 'manual',
    signal: abortController.signal
  })
  if (res.status >= 400) {
    throw new Error(`HEAD ${job.url} failed: ${res.status} ${res.statusText}`)
  }
  const linkedEtag = res.headers.get('x-linked-etag')
  const rawEtag = linkedEtag ?? res.headers.get('etag') ?? ''
  const etag = assertSafeCacheKey(rawEtag.replace(/^W\//, '').replace(/"/g, ''))
  const commit = assertExpectedCommit(res.headers.get('x-repo-commit') ?? '', job.expectedCommit)
  const location = res.headers.get('location')
  const downloadUrl = location ? new URL(location, job.url).toString() : job.url

  // x-linked-size is authoritative. Without it, content-length only counts when the
  // response is the file itself — on a redirect it describes the redirect body.
  let size = Number(res.headers.get('x-linked-size') ?? Number.NaN)
  if (!Number.isFinite(size)) {
    if (res.status >= 300 && location) {
      const head = await httpFetch(downloadUrl, {
        method: 'HEAD',
        headers: requestHeaders(downloadUrl),
        signal: abortController.signal
      })
      size = Number(head.headers.get('content-length') ?? 0)
    } else {
      size = Number(res.headers.get('content-length') ?? 0)
    }
  }
  // LFS etags are content SHA-256; 40-hex non-LFS etags are verified as Git blob OIDs.
  const isLfs = Boolean(linkedEtag) && /^[0-9a-f]{64}$/.test(etag)
  return { commit, etag, size, isLfs, downloadUrl }
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** Git blob oid: sha1 of `blob <size>\0` + content — what non-LFS etags are. */
export function gitBlobSha1OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    hash.update(`blob ${statSync(path).size}\0`)
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** Simple token bucket; sleeps when the rolling send rate exceeds the limit. */
export class Throttle {
  private windowStart = Date.now()
  private windowBytes = 0

  constructor(private limitBps: number | null) {}

  /** Live rate update from the manager as sibling workers spawn/exit; null = unlimited. */
  setLimit(limitBps: number | null): void {
    this.limitBps = limitBps
    this.windowStart = Date.now()
    this.windowBytes = 0
  }

  async take(bytes: number): Promise<void> {
    if (!this.limitBps) return
    this.windowBytes += bytes
    const elapsed = (Date.now() - this.windowStart) / 1000
    const expected = this.windowBytes / this.limitBps
    if (expected > elapsed) {
      await new Promise((r) => setTimeout(r, (expected - elapsed) * 1000))
    }
    if (elapsed > 2) {
      this.windowStart = Date.now()
      this.windowBytes = 0
    }
  }
}

const throttle = new Throttle(job.speedLimitBps ?? null)

function linkSnapshot(snapshotFile: string, blobPath: string): void {
  rmSync(snapshotFile, { force: true })
  const target = relative(dirname(snapshotFile), blobPath)
  try {
    symlinkSync(target, snapshotFile)
  } catch {
    // Windows without developer mode: fall back to a copy, like huggingface_hub.
    copyFileSync(blobPath, snapshotFile)
  }
}

/**
 * Task-unique partial path: two tasks (or two identical-content files within one
 * task) must never append to a shared '.incomplete' file — a corrupt interleaved
 * blob could be promoted. Stable across pause/resume because the task id persists.
 */
function partialPath(blobPath: string): string {
  const pathHash = createHash('sha1').update(job.path).digest('hex').slice(0, 8)
  return `${blobPath}.incomplete.${job.taskId}-${pathHash}`
}

function directChildName(parent: string, child: string): string | null {
  const rel = relative(parent, child)
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.includes(sep) ? rel : null
}

function ensureDirectDirectory(parent: string, name: string, label: string): string {
  const path = join(parent, name)
  if (!existsSync(path)) mkdirSync(path)
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`unsafe-cache-layout:${label}`)
  }
  const real = realpathSync(path)
  if (directChildName(parent, real) !== name) throw new Error(`unsafe-cache-layout:${label}`)
  return real
}

function assertExistingRegularFile(path: string, parent: string, label: string): void {
  if (!existsSync(path)) return
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`unsafe-cache-layout:${label}`)
  if (directChildName(parent, realpathSync(path)) === null) {
    throw new Error(`unsafe-cache-layout:${label}`)
  }
}

/**
 * Create and validate every directory the worker may write. No recursive mkdir
 * is used below the cache root, so a pre-existing repo/blob/snapshot symlink or
 * junction cannot redirect writes outside the frozen cache.
 */
export function prepareSafeCacheDirectories(
  input: Pick<DownloadJob, 'cacheDir' | 'repoDir' | 'expectedCommit' | 'path'>
): { blobsDir: string; snapshotParent: string } {
  if (!isAbsolute(input.cacheDir) || !isAbsolute(input.repoDir)) {
    throw new Error('unsafe-cache-layout:absolute-path-required')
  }
  const cachePath = resolve(input.cacheDir)
  const repoPath = resolve(input.repoDir)
  const expectedRepoName = directChildName(cachePath, repoPath)
  if (!expectedRepoName) throw new Error('unsafe-cache-layout:repository-boundary')

  if (!existsSync(cachePath)) mkdirSync(cachePath, { recursive: true })
  const rootEntry = lstatSync(cachePath)
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error('unsafe-cache-layout:cache-root')
  }
  const realRoot = realpathSync(cachePath)
  const realRepo = ensureDirectDirectory(realRoot, expectedRepoName, 'repository')
  const blobsDir = ensureDirectDirectory(realRepo, 'blobs', 'blobs')
  const snapshotsDir = ensureDirectDirectory(realRepo, 'snapshots', 'snapshots')
  let snapshotParent = ensureDirectDirectory(snapshotsDir, input.expectedCommit, 'snapshot-commit')
  const segments = input.path.split('/')
  for (const segment of segments.slice(0, -1)) {
    snapshotParent = ensureDirectDirectory(snapshotParent, segment, 'snapshot-directory')
  }
  return { blobsDir, snapshotParent }
}

async function downloadToBlob(meta: FileMetadata, blobPath: string): Promise<number> {
  const incomplete = partialPath(blobPath)
  const blobsDir = dirname(blobPath)
  assertExistingRegularFile(blobPath, blobsDir, 'blob')
  assertExistingRegularFile(incomplete, blobsDir, 'partial')

  let offset = 0
  if (existsSync(incomplete)) {
    offset = statSync(incomplete).size
    if (offset > meta.size) {
      rmSync(incomplete, { force: true })
      offset = 0
    }
  }

  if (offset < meta.size || meta.size === 0) {
    abortController = new AbortController()
    if (aborted) throw new Error('aborted')
    const headers: Record<string, string> = requestHeaders(meta.downloadUrl)
    if (offset > 0) headers.Range = `bytes=${offset}-`
    const res = await httpFetch(meta.downloadUrl, { headers, signal: abortController.signal })
    if (res.status === 200 && offset > 0) {
      // Server ignored the Range; start over.
      rmSync(incomplete, { force: true })
      offset = 0
    } else if (!res.ok && res.status !== 206) {
      throw new Error(`GET failed: ${res.status} ${res.statusText}`)
    }
    if (!res.body) throw new Error('Response has no body')

    const out = createWriteStream(incomplete, { flags: offset > 0 ? 'a' : 'w' })
    let received = offset
    let lastReport = 0
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (aborted) throw new Error('aborted')
        received += value.byteLength
        await new Promise<void>((resolve, reject) =>
          out.write(value, (err) => (err ? reject(err) : resolve()))
        )
        await throttle.take(value.byteLength)
        const now = Date.now()
        if (now - lastReport > 200) {
          lastReport = now
          post({ type: 'progress', received, size: meta.size })
        }
      }
    } finally {
      await new Promise((r) => out.end(r))
    }
    if (meta.size > 0 && received !== meta.size) {
      throw new Error(`Incomplete download: got ${received} of ${meta.size} bytes`)
    }
  }

  // LFS etags are the sha256 of the content; non-LFS etags are the git blob oid.
  // Verify either before promoting the blob.
  let verified = false
  if (meta.isLfs && /^[0-9a-f]{64}$/.test(meta.etag)) {
    const digest = await sha256OfFile(incomplete)
    if (digest !== meta.etag) {
      rmSync(incomplete, { force: true })
      throw new Error('Checksum mismatch (sha256); the partial file was discarded')
    }
    verified = true
  } else if (!meta.isLfs && /^[0-9a-f]{40}$/.test(meta.etag)) {
    const digest = await gitBlobSha1OfFile(incomplete)
    if (digest !== meta.etag) {
      rmSync(incomplete, { force: true })
      throw new Error('Checksum mismatch (git blob sha1); the partial file was discarded')
    }
    verified = true
  }
  rmSync(blobPath, { force: true })
  renameSync(incomplete, blobPath)
  return verified ? 1 : 0
}

async function run(): Promise<void> {
  assertSafeRepoFilePath(job.path)
  const meta = await fetchMetadata()
  post({ type: 'meta', commit: meta.commit, etag: meta.etag, size: meta.size, isLfs: meta.isLfs })

  const { blobsDir, snapshotParent } = prepareSafeCacheDirectories(job)
  const blobPath = join(blobsDir, meta.etag)
  const snapshotFile = join(snapshotParent, job.path.split('/').at(-1)!)
  assertExistingRegularFile(blobPath, blobsDir, 'blob')

  let verified = false
  let haveBlob = false
  if (existsSync(blobPath) && (meta.size === 0 || statSync(blobPath).size === meta.size)) {
    if (meta.isLfs) {
      // Existing caches may predate strict verification. Re-hash before reuse;
      // a same-size corrupt blob must never be linked into a completed snapshot.
      verified = (await sha256OfFile(blobPath)) === meta.etag
      haveBlob = verified
    } else if (/^[0-9a-f]{40}$/.test(meta.etag)) {
      // Cheap for small non-LFS files; redownload if a pre-verification blob is corrupt.
      verified = (await gitBlobSha1OfFile(blobPath)) === meta.etag
      haveBlob = verified
    } else {
      haveBlob = true
    }
  }
  if (!haveBlob) {
    verified = (await downloadToBlob(meta, blobPath)) === 1
  }
  linkSnapshot(snapshotFile, blobPath)

  post({
    type: 'done',
    received: meta.size,
    verified,
    snapshotPath: snapshotFile,
    localSha256: await sha256OfFile(blobPath)
  })
}

if (port) {
  run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    post({ type: 'error', message: aborted ? 'aborted' : message })
  })
}
