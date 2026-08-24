import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import {
  normalizeHubEndpoint,
  ohmyhfLockV1Schema,
  type LockfileInspection,
  type LockfileInspectionResource,
  type LockfileRestoreEvent,
  type LockfileRestoreResult,
  type OhmyhfLockFileEntry,
  type OhmyhfLockResource,
  type OhmyhfLockV1,
  type RuntimeDiscovery,
  type SecurityGrant,
  type SecurityPreflightResult
} from '@oh-my-huggingface/shared'
import type { HubClient } from '@oh-my-huggingface/hub-api'
import type { CacheManager } from './cache'
import type { DownloadManager } from './downloads'
import type { LocalRuntimeManager } from './local-runtime'
import type { SecurityGate } from './security-gate'

const MAX_LOCKFILE_BYTES = 10 * 1024 * 1024
const INSPECTION_TTL_MS = 15 * 60_000

interface StoredInspection {
  value: LockfileInspection
  expiresAt: number
  context: LockfileEndpointContext
}

type LockfileHub = Pick<HubClient, 'resolveRevision' | 'getRepoDetail' | 'getFileTree'> & {
  baseUrl?: string
}
type LockfileSecurity = Pick<SecurityGate, 'preflight' | 'authorize' | 'confirm'>

interface LockfileEndpointContext {
  hub: LockfileHub
  security: LockfileSecurity
}

interface LockfileDeps {
  hub: LockfileHub
  cache: CacheManager
  downloads: DownloadManager
  security: SecurityGate
  localRuntime: LocalRuntimeManager
  /** Builds a throwaway client/gate for one imported lockfile endpoint. */
  contextForEndpoint?: (endpoint: string, authenticated: boolean) => LockfileEndpointContext
  broadcastRestore?: (event: LockfileRestoreEvent) => void
  now?: () => number
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function gitBlobOidFile(path: string, size: number): Promise<string> {
  const hash = createHash('sha1')
  hash.update(`blob ${size}\0`)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function remoteMetadataMatches(
  expected: OhmyhfLockFileEntry,
  actual: { size: number; oid?: string; lfs?: { oid: string; size: number } }
): boolean {
  if (expected.size !== actual.size) return false
  if (expected.lfsSha256 && expected.lfsSha256 !== actual.lfs?.oid?.toLowerCase()) return false
  if (expected.gitBlobOid && expected.gitBlobOid !== actual.oid?.toLowerCase()) return false
  return true
}

function publicProbeAvailable(
  discoveries: RuntimeDiscovery[],
  resource: OhmyhfLockResource
): boolean | undefined {
  if (!resource.runtime) return undefined
  return discoveries.find((item) => item.kind === resource.runtime?.runtime)?.available === true
}

export class LockfileManager {
  private readonly inspections = new Map<string, StoredInspection>()
  private readonly now: () => number

  constructor(private readonly deps: LockfileDeps) {
    this.now = deps.now ?? Date.now
  }

  private broadcast(event: LockfileRestoreEvent): void {
    this.deps.broadcastRestore?.(event)
  }

  /**
   * Validate and canonicalize a renderer-authored lock draft before writing it.
   * Exact subset entries are enriched with a local SHA-256 whenever that file
   * is already present in the active cache root. No absolute path is emitted.
   */
  async prepareExport(lock: OhmyhfLockV1): Promise<OhmyhfLockV1> {
    const parsed = ohmyhfLockV1Schema.parse(lock)
    const resources: OhmyhfLockResource[] = []
    for (const resource of parsed.resources) {
      const files: OhmyhfLockFileEntry[] | undefined = resource.files
        ? await Promise.all(
            resource.files.map(async (file) => {
              const cached = await this.deps.cache.resolveFilePath(
                resource.kind,
                resource.repoId,
                resource.resolvedCommit,
                file.path
              )
              if (!cached) return file
              if (cached.info.size !== file.size) throw new Error(`lockfile.localSize:${file.path}`)
              return { ...file, localSha256: await sha256File(cached.absolutePath) }
            })
          )
        : undefined
      resources.push({ ...resource, files })
    }
    return ohmyhfLockV1Schema.parse({
      ...parsed,
      hubEndpoint: normalizeHubEndpoint(parsed.hubEndpoint),
      resources
    })
  }

  private currentEndpoint(): string {
    return normalizeHubEndpoint(this.deps.hub.baseUrl)
  }

  private purge(): void {
    const now = this.now()
    for (const [id, inspection] of this.inspections) {
      if (inspection.expiresAt <= now) this.inspections.delete(id)
    }
  }

  protectedCommits(kind: OhmyhfLockResource['kind'], repoId: string): ReadonlySet<string> {
    this.purge()
    const commits = new Set<string>()
    for (const inspection of this.inspections.values()) {
      for (const resource of inspection.value.lock.resources) {
        if (resource.kind === kind && resource.repoId === repoId) {
          commits.add(resource.resolvedCommit)
        }
      }
    }
    return commits
  }

  async readAndValidate(path: string): Promise<OhmyhfLockV1> {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_LOCKFILE_BYTES) {
      throw new Error('lockfile.invalidFile')
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch {
      throw new Error('lockfile.invalidJson')
    }
    const parsed = ohmyhfLockV1Schema.safeParse(decoded)
    if (!parsed.success) throw new Error(`lockfile.invalidSchema:${parsed.error.message}`)
    return parsed.data
  }

  async inspectPath(path: string): Promise<LockfileInspection> {
    this.broadcast({ status: 'inspecting' })
    try {
      const inspection = await this.inspect(await this.readAndValidate(path))
      this.broadcast({
        inspectionId: inspection.inspectionId,
        status: 'ready',
        completedResources: inspection.resources.length,
        totalResources: inspection.resources.length
      })
      return inspection
    } catch (error) {
      this.broadcast({
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async inspect(lock: OhmyhfLockV1): Promise<LockfileInspection> {
    const parsed = ohmyhfLockV1Schema.parse(lock)
    this.purge()
    const endpointMatches =
      normalizeHubEndpoint(parsed.hubEndpoint) === normalizeHubEndpoint(this.currentEndpoint())
    const context: LockfileEndpointContext = endpointMatches
      ? { hub: this.deps.hub, security: this.deps.security }
      : (this.deps.contextForEndpoint?.(parsed.hubEndpoint, false) ??
        (() => {
          throw new Error('lockfile.endpointContextUnavailable')
        })())
    const discoveries = await this.deps.localRuntime
      .discover()
      .catch(() => [] as RuntimeDiscovery[])
    const resources: LockfileInspectionResource[] = []
    for (const resource of parsed.resources) {
      resources.push(await this.inspectResource(resource, discoveries, context))
    }
    const inspectionId = randomUUID()
    const expiresAtMs = this.now() + INSPECTION_TTL_MS
    const inspection: LockfileInspection = {
      inspectionId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      endpointMatches,
      endpointConfirmed: endpointMatches,
      lock: parsed,
      resources
    }
    this.inspections.set(inspectionId, { value: inspection, expiresAt: expiresAtMs, context })
    return inspection
  }

  private async inspectResource(
    resource: OhmyhfLockResource,
    discoveries: RuntimeDiscovery[],
    context: LockfileEndpointContext
  ): Promise<LockfileInspectionResource> {
    const errors: string[] = []
    let cachedFiles = 0
    let missingFiles = 0
    let mismatchedFiles = 0
    let securityResult: SecurityPreflightResult | undefined
    try {
      const resolved = await context.hub.resolveRevision(
        resource.kind,
        resource.repoId,
        resource.resolvedCommit
      )
      if (resolved.resolvedCommit !== resource.resolvedCommit) throw new Error('commit-mismatch')
      const remoteTree = (
        await context.hub.getFileTree(resource.kind, resource.repoId, resource.resolvedCommit, '', {
          recursive: true
        })
      ).filter((entry) => entry.type === 'file')
      const remoteByPath = new Map(remoteTree.map((entry) => [entry.path, entry]))
      const expectedFiles: OhmyhfLockFileEntry[] =
        resource.files ??
        remoteTree.map((entry) => ({
          path: entry.path,
          size: entry.size,
          lfsSha256: entry.lfs?.oid,
          gitBlobOid: entry.lfs ? undefined : entry.oid
        }))
      for (const file of expectedFiles) {
        if (!file.lfsSha256 && !file.gitBlobOid) {
          mismatchedFiles += 1
          errors.push(`remote-object-id-missing:${file.path}`)
          continue
        }
        const remote = remoteByPath.get(file.path)
        if (!remote || !remoteMetadataMatches(file, remote)) {
          mismatchedFiles += 1
          errors.push(`remote-metadata:${file.path}`)
          continue
        }
        const cached = await this.deps.cache.resolveFilePath(
          resource.kind,
          resource.repoId,
          resource.resolvedCommit,
          file.path
        )
        if (!cached) {
          missingFiles += 1
          continue
        }
        let matches = cached.info.size === file.size
        if (matches && file.localSha256) {
          matches = (await sha256File(cached.absolutePath)) === file.localSha256
        } else if (matches && file.lfsSha256) {
          matches = (await sha256File(cached.absolutePath)) === file.lfsSha256
        } else if (matches && file.gitBlobOid) {
          matches =
            (await gitBlobOidFile(cached.absolutePath, cached.info.size)) === file.gitBlobOid
        }
        if (matches) cachedFiles += 1
        else {
          mismatchedFiles += 1
          errors.push(`local-integrity:${file.path}`)
        }
      }
      securityResult = await context.security.preflight({
        action: 'lock-restore',
        kind: resource.kind,
        repoId: resource.repoId,
        revision: resource.requestedRevision,
        resolvedCommit: resource.resolvedCommit,
        files: resource.files?.map((file) => file.path)
      })
      if (securityResult.decision === 'block') errors.push('security-blocked')
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    return {
      kind: resource.kind,
      repoId: resource.repoId,
      requestedRevision: resource.requestedRevision,
      resolvedCommit: resource.resolvedCommit,
      cachedFiles,
      missingFiles,
      mismatchedFiles,
      runtimeAvailable: publicProbeAvailable(discoveries, resource),
      currentSecurityDecision: securityResult?.decision,
      securityReasons: securityResult?.reasons,
      securityChallengeId: securityResult?.challengeId,
      securityChanged:
        resource.security && securityResult
          ? resource.security.fingerprint !== securityResult.report.fingerprint
          : undefined,
      errors: [...new Set(errors)]
    }
  }

  /**
   * Explicitly opt one inspection into its lockfile endpoint. The refresh uses
   * a throwaway authenticated client, never changes global network settings,
   * and replaces all anonymous inspection evidence before restore.
   */
  async confirmEndpoint(inspectionId: string): Promise<LockfileInspection> {
    this.purge()
    const stored = this.inspections.get(inspectionId)
    if (!stored) throw new Error('lockfile.inspectionExpired')
    if (stored.value.endpointMatches || stored.value.endpointConfirmed) return stored.value
    const context = this.deps.contextForEndpoint?.(stored.value.lock.hubEndpoint, true)
    if (!context) throw new Error('lockfile.endpointContextUnavailable')
    const discoveries = await this.deps.localRuntime
      .discover()
      .catch(() => [] as RuntimeDiscovery[])
    const resources: LockfileInspectionResource[] = []
    for (const resource of stored.value.lock.resources) {
      resources.push(await this.inspectResource(resource, discoveries, context))
    }
    stored.context = context
    stored.value = { ...stored.value, endpointConfirmed: true, resources }
    return stored.value
  }

  confirmSecurity(inspectionId: string, resourceIndex: number, challengeId: string): SecurityGrant {
    this.purge()
    const stored = this.inspections.get(inspectionId)
    if (!stored) throw new Error('lockfile.inspectionExpired')
    const resource = stored.value.resources[resourceIndex]
    if (!resource || resource.securityChallengeId !== challengeId) {
      throw new Error('security.grantScopeMismatch')
    }
    return stored.context.security.confirm(challengeId)
  }

  async restore(
    inspectionId: string,
    options: { confirmEndpoint?: boolean; securityGrantIds?: string[] } = {}
  ): Promise<LockfileRestoreResult> {
    this.purge()
    const stored = this.inspections.get(inspectionId)
    if (!stored) throw new Error('lockfile.inspectionExpired')
    // One inspection can drive only one execution, preventing stale replay.
    this.inspections.delete(inspectionId)
    const inspection = stored.value
    if (
      !inspection.endpointMatches &&
      (!inspection.endpointConfirmed || options.confirmEndpoint !== true)
    ) {
      this.broadcast({
        inspectionId,
        status: 'error',
        error: 'lockfile.endpointConfirmationRequired'
      })
      throw new Error('lockfile.endpointConfirmationRequired')
    }

    this.broadcast({
      inspectionId,
      status: 'restoring',
      completedResources: 0,
      totalResources: inspection.lock.resources.length
    })
    const queuedDownloadIds: string[] = []
    const readyResources: LockfileRestoreResult['readyResources'] = []
    const blockedResources: LockfileRestoreResult['blockedResources'] = []
    let grantIndex = 0
    for (const [index, resource] of inspection.lock.resources.entries()) {
      this.broadcast({
        inspectionId,
        status: 'restoring',
        resourceIndex: index,
        completedResources: index,
        totalResources: inspection.lock.resources.length
      })
      const prior = inspection.resources[index]
      if (
        !prior ||
        prior.mismatchedFiles > 0 ||
        prior.errors.some((error) => error !== 'security-blocked')
      ) {
        blockedResources.push({
          kind: resource.kind,
          repoId: resource.repoId,
          reason: prior?.errors.join(', ') || 'lockfile.invalidResource'
        })
        continue
      }
      try {
        const grantId =
          prior.currentSecurityDecision === 'confirm'
            ? options.securityGrantIds?.[grantIndex++]
            : undefined
        await stored.context.security.authorize(
          {
            action: 'lock-restore',
            kind: resource.kind,
            repoId: resource.repoId,
            revision: resource.requestedRevision,
            resolvedCommit: resource.resolvedCommit,
            files: resource.files?.map((file) => file.path)
          },
          grantId
        )

        if (resource.runtime) {
          this.deps.localRuntime.savePreset({
            endpoint: inspection.lock.hubEndpoint,
            repoId: resource.repoId,
            revision: resource.requestedRevision,
            resolvedCommit: resource.resolvedCommit,
            filePath: resource.runtime.filePath,
            runtime: resource.runtime.runtime,
            contextLength: resource.runtime.contextLength,
            maxTokens: resource.runtime.maxTokens,
            temperature: resource.runtime.temperature,
            gpuLayers: resource.runtime.gpuLayers
          })
        }

        const targetPaths = resource.files?.map((file) => file.path)
        const missingPaths: string[] = []
        if (targetPaths) {
          for (const path of targetPaths) {
            const cached = await this.deps.cache.resolveFilePath(
              resource.kind,
              resource.repoId,
              resource.resolvedCommit,
              path
            )
            if (!cached) missingPaths.push(path)
          }
        } else if (
          prior.missingFiles > 0 ||
          !(await this.deps.cache.snapshot(resource.kind, resource.repoId, resource.resolvedCommit))
        ) {
          // Omitted files means a complete snapshot, so omit the download file
          // filter and let the exact remote tree define the set.
          missingPaths.push('*')
        }

        if (missingPaths.length === 0) {
          readyResources.push({
            kind: resource.kind,
            repoId: resource.repoId,
            resolvedCommit: resource.resolvedCommit
          })
          continue
        }
        const before = new Set(this.deps.downloads.list().map((task) => task.id))
        const restoreHub = stored.context.hub
        if (!restoreHub.baseUrl) throw new Error('lockfile.endpointContextUnavailable')
        const tasks = await this.deps.downloads.startWithHub(
          {
            kind: resource.kind,
            repoId: resource.repoId,
            revision: resource.requestedRevision,
            resolvedCommit: resource.resolvedCommit,
            files: missingPaths[0] === '*' ? undefined : missingPaths
          },
          {
            baseUrl: restoreHub.baseUrl,
            getRepoDetail: restoreHub.getRepoDetail.bind(restoreHub),
            getFileTree: restoreHub.getFileTree.bind(restoreHub)
          }
        )
        const matching = tasks.filter(
          (task) =>
            task.kind === resource.kind &&
            task.repoId === resource.repoId &&
            task.resolvedCommit === resource.resolvedCommit &&
            (!before.has(task.id) || task.status === 'queued' || task.status === 'running')
        )
        queuedDownloadIds.push(...matching.map((task) => task.id))
      } catch (error) {
        blockedResources.push({
          kind: resource.kind,
          repoId: resource.repoId,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const result = {
      queuedDownloadIds: [...new Set(queuedDownloadIds)],
      readyResources,
      blockedResources
    }
    this.broadcast({
      inspectionId,
      status: 'completed',
      completedResources: inspection.lock.resources.length,
      totalResources: inspection.lock.resources.length
    })
    return result
  }
}

export const lockfileLimits = {
  maxBytes: MAX_LOCKFILE_BYTES,
  maxResources: 100,
  maxFilesPerResource: 10_000
} as const
