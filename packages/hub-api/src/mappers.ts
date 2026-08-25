/** Maps raw Hub REST payloads into the shared domain types. */
import type {
  AccessRequest,
  ActivityDiscussion,
  ActivityFeed,
  ActivityItem,
  BillingUsage,
  CollectionDetail,
  CollectionItem,
  CollectionSummary,
  DatasetRows,
  DiscussionDetail,
  DiscussionSummary,
  EvalIdentity,
  FileTreeEntry,
  GatedFormField,
  HubNotification,
  HubOrgPlan,
  HubProfileSettings,
  MyRepoEntry,
  LeaderboardEntry,
  LeaderboardPage,
  ModelEvalResult,
  NotificationsPage,
  PaperSummary,
  PostComment,
  PostAttachment,
  PostReaction,
  PostSummary,
  RepoDetail,
  RepoCommitSummary,
  RepoKind,
  RepoRef,
  RepoRefs,
  RepoSummary,
  SecurityEvidence,
  SecurityEvidenceStatus,
  SecurityReasonCode,
  SecurityReport,
  SpaceSecret,
  SpaceVariable,
  UserOverview,
  UserProfile
} from '@oh-my-huggingface/shared'
import { hubRelativeUrl, securityEvidenceFingerprint } from '@oh-my-huggingface/shared'

/** Plural URL segment per repo kind (kept local: client.ts imports this module). */
const REPO_URL_SEGMENT: Record<RepoKind, string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces'
}

/** Narrows a raw repo `type` to the kinds the app supports (drops bucket/kernel). */
function asRepoKind(type: string | undefined): RepoKind | undefined {
  return type === 'model' || type === 'dataset' || type === 'space' ? type : undefined
}

interface RawRepo {
  id?: string
  _id?: string
  modelId?: string
  author?: string
  likes?: number
  downloads?: number
  lastModified?: string
  createdAt?: string
  private?: boolean
  gated?: string | boolean
  tags?: string[]
  pipeline_tag?: string
  library_name?: string
  sdk?: string
  trendingScore?: number
  safetensors?: { total?: number }
  cardData?: Record<string, unknown>
  /** Canonical live-app URL, e.g. https://owner-name.hf.space or *.static.hf.space */
  host?: string
  /** Hub-assigned subdomain without the suffix, e.g. "owner-name". */
  subdomain?: string
  runtime?: {
    stage?: string
    hardware?: { current?: string | null }
    domains?: Array<{ domain?: string; stage?: string }>
  }
  siblings?: Array<{ rfilename: string; size?: number }>
  sha?: string
  usedStorage?: number
  downloadsAllTime?: number
}

function splitRepoId(id: string): { author: string; name: string } {
  const slash = id.indexOf('/')
  if (slash === -1) return { author: '', name: id }
  return { author: id.slice(0, slash), name: id.slice(slash + 1) }
}

function licenseFromTags(tags: string[] | undefined): string | undefined {
  const tag = tags?.find((t) => t.startsWith('license:'))
  return tag?.slice('license:'.length)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function hostnameFromMaybeUrl(value: string | undefined): string | undefined {
  const raw = optionalString(value)?.trim()
  if (!raw) return undefined
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`)
    return url.hostname || undefined
  } catch {
    return undefined
  }
}

/**
 * Hostname to iframe. `runtime.domains[0]` is often a stale rename/move alias
 * that 404s; static Spaces live on `*.static.hf.space` with an empty domains
 * list. The Hub `host` field is the current origin.
 */
function spaceEmbedHost(raw: RawRepo): string | undefined {
  const fromHost = hostnameFromMaybeUrl(raw.host)
  if (fromHost) return fromHost

  const subdomain = optionalString(raw.subdomain)?.trim()
  const domains = (raw.runtime?.domains ?? [])
    .map((entry) => optionalString(entry.domain)?.trim())
    .filter((domain): domain is string => Boolean(domain))

  if (subdomain) {
    const current = domains.find(
      (domain) => domain === `${subdomain}.hf.space` || domain === `${subdomain}.static.hf.space`
    )
    if (current) return current
    return `${subdomain}.hf.space`
  }

  const ready = raw.runtime?.domains?.find(
    (entry) => entry.stage === 'READY' && optionalString(entry.domain)
  )?.domain
  return optionalString(ready) ?? domains[0]
}

export function mapRepoSummary(raw: RawRepo, kind: RepoKind): RepoSummary {
  const id = raw.id ?? raw.modelId ?? ''
  const { author, name } = splitRepoId(id)
  // Gallery card fields are Space-specific: models/datasets keep them undefined
  // even though their payloads may also carry a cardData object.
  const card = kind === 'space' ? raw.cardData : undefined
  return {
    id,
    kind,
    author: raw.author ?? author,
    name,
    likes: raw.likes ?? 0,
    downloads: raw.downloads ?? 0,
    updatedAt: raw.lastModified,
    createdAt: raw.createdAt,
    private: raw.private ?? false,
    gated: raw.gated ?? false,
    tags: raw.tags ?? [],
    pipelineTag: raw.pipeline_tag,
    libraryName: raw.library_name,
    license: licenseFromTags(raw.tags),
    paramCount: raw.safetensors?.total,
    sdk: raw.sdk,
    trendingScore: raw.trendingScore,
    emoji: optionalString(card?.emoji),
    colorFrom: optionalString(card?.colorFrom),
    colorTo: optionalString(card?.colorTo),
    shortDescription: optionalString(card?.short_description),
    runtimeStage: kind === 'space' ? raw.runtime?.stage : undefined,
    hardware: kind === 'space' ? (raw.runtime?.hardware?.current ?? undefined) : undefined
  }
}

export function mapRepoDetail(raw: RawRepo, kind: RepoKind): RepoDetail {
  return {
    ...mapRepoSummary(raw, kind),
    sha: raw.sha,
    spaceDomain: kind === 'space' ? spaceEmbedHost(raw) : undefined,
    lastModified: raw.lastModified,
    cardData: raw.cardData,
    siblings: raw.siblings,
    usedStorage: raw.usedStorage,
    downloadsAllTime: raw.downloadsAllTime
  }
}

interface RawTreeEntry {
  type: 'file' | 'directory'
  path: string
  size?: number
  oid?: string
  lfs?: { oid: string; size: number }
  security?: unknown
  securityFileStatus?: unknown
}

export function mapFileTree(raw: RawTreeEntry[]): FileTreeEntry[] {
  return raw.map((e) => ({
    type: e.type,
    path: e.path,
    size: e.lfs?.size ?? e.size ?? 0,
    oid: e.oid,
    lfs: e.lfs,
    security: mapFileSecurity(e.securityFileStatus ?? e.security)
  }))
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function securityStatusFrom(value: unknown, source = ''): SecurityEvidenceStatus {
  if (typeof value === 'boolean') {
    // Exact field names only — `/virus/` would match VirusTotal report URLs.
    if (/virusFound|infected|malware|malicious/i.test(source)) {
      return value ? 'malicious' : 'safe'
    }
    if (/scansDone|scans_done/i.test(source)) return 'unknown'
    if (/pending/i.test(source)) return value ? 'pending' : 'safe'
    if (/error|failed/i.test(source)) return value ? 'error' : 'safe'
    if (/pickle|unsafe|danger|secret|custom.?code|remote.?code/i.test(source)) {
      return value ? 'warning' : 'safe'
    }
    return value ? 'safe' : 'warning'
  }
  const normalized = stringValue(value)?.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')
  if (!normalized) return 'unknown'
  // Pickle / format risk is confirmation, not a malware verdict. Hugging Face
  // uses `unsafe` on the file envelope for that case (`safe = status === "safe"`).
  if (
    normalized === 'unsafe' ||
    normalized === 'dangerous' ||
    normalized === 'suspicious' ||
    normalized === 'warning'
  ) {
    return 'warning'
  }
  if (normalized === 'malicious' || normalized === 'infected') return 'malicious'
  if (
    normalized === 'safe' ||
    normalized === 'clean' ||
    normalized === 'passed' ||
    normalized === 'ok' ||
    normalized === 'innocuous'
  )
    return 'safe'
  if (normalized === 'pending' || normalized === 'scan-in-progress') return 'pending'
  if (normalized === 'error' || normalized === 'failed') return 'error'
  if (normalized === 'unscanned') return 'unknown'
  return 'unknown'
}

function aggregateSecurityStatus(evidence: SecurityEvidence[]): SecurityEvidenceStatus {
  return evidence.some((item) => item.status === 'malicious')
    ? 'malicious'
    : evidence.some((item) => item.status === 'warning')
      ? 'warning'
      : evidence.some((item) => item.status === 'pending')
        ? 'pending'
        : evidence.some((item) => item.status === 'error')
          ? 'error'
          : evidence.length > 0 && evidence.every((item) => item.status === 'safe')
            ? 'safe'
            : 'unknown'
}

function mapFileSecurity(value: unknown): FileTreeEntry['security'] {
  const envelope = object(value)
  if (!envelope) return undefined
  // Older expanded tree responses wrapped Hugging Face's result in `hf`;
  // current responses use `securityFileStatus`. Support both without treating
  // envelope metadata such as blobId/indexed as scanner conclusions.
  const raw = object(envelope.hf) ?? envelope
  const evidence = evidenceFromObject(raw, undefined, 'hub-file-scan')
  if (evidence.length === 0) return undefined
  const envelopeStatus =
    raw.status !== undefined
      ? securityStatusFrom(raw.status, 'hub-file-scan.status')
      : raw.safe !== undefined
        ? securityStatusFrom(raw.safe, 'hub-file-scan.safe')
        : undefined
  const contradicting = evidence.some(
    (item) => item.status === 'malicious' || item.status === 'warning'
  )
  // Hub's official file verdict is `status === "safe"`. Nested `unscanned`
  // scanners and leftover URLs must not override that unless a known scanner
  // reports malware or pickle risk.
  const status =
    envelopeStatus === 'safe' && !contradicting
      ? 'safe'
      : envelopeStatus === 'warning' && !evidence.some((item) => item.status === 'malicious')
        ? 'warning'
        : aggregateSecurityStatus(evidence)
  const message = evidence.map((item) => item.message).find(Boolean)
  return {
    status,
    scanners: [...new Set(evidence.map((item) => item.source))],
    message,
    evidence: evidence.map(({ source, status: itemStatus, message: itemMessage, checkedAt }) => ({
      source,
      status: itemStatus,
      message: itemMessage,
      checkedAt
    }))
  }
}

function rawRefList(value: unknown, type: RepoRef['type']): RepoRef[] {
  return array(value).flatMap((entry) => {
    const raw = object(entry)
    if (!raw) return []
    const ref = stringValue(raw.ref) ?? stringValue(raw.gitRef)
    const name =
      stringValue(raw.name) ??
      ref?.replace(/^refs\/(?:heads|tags)\//, '') ??
      (type === 'pull-request' ? ref : undefined)
    const targetCommit =
      stringValue(raw.targetCommit) ??
      stringValue(raw.target_commit) ??
      stringValue(raw.commit) ??
      stringValue(raw.sha)
    if (!name || !targetCommit || !/^[0-9a-f]{40}$/i.test(targetCommit)) return []
    const fullRef =
      ref ??
      (type === 'branch' ? `refs/heads/${name}` : type === 'tag' ? `refs/tags/${name}` : name)
    return [
      {
        name,
        ref: fullRef,
        targetCommit: targetCommit.toLowerCase(),
        type,
        isDefault: raw.isDefault === true || raw.default === true
      }
    ]
  })
}

export function mapRepoRefs(value: unknown): RepoRefs {
  const raw = object(value) ?? {}
  const branches = rawRefList(raw.branches, 'branch')
  const tags = rawRefList(raw.tags, 'tag')
  const pullRequests = rawRefList(
    raw.pullRequests ?? raw.pull_requests ?? raw.prs ?? raw.converts,
    'pull-request'
  )
  const defaultBranch =
    stringValue(raw.defaultBranch) ??
    stringValue(raw.default_branch) ??
    branches.find((branch) => branch.isDefault)?.name
  return {
    branches: branches.map((branch) => ({
      ...branch,
      isDefault: branch.isDefault === true || branch.name === defaultBranch
    })),
    tags,
    pullRequests,
    defaultBranch
  }
}

export function mapRepoCommits(value: unknown): RepoCommitSummary[] {
  const raw = object(value)
  const items = Array.isArray(value) ? value : array(raw?.commits ?? raw?.items)
  return items.flatMap((entry) => {
    const commit = object(entry)
    if (!commit) return []
    const id =
      stringValue(commit.id) ??
      stringValue(commit.commitId) ??
      stringValue(commit.commit_id) ??
      stringValue(commit.sha)
    if (!id || !/^[0-9a-f]{40}$/i.test(id)) return []
    const authors = array(commit.authors).flatMap((author) => {
      if (typeof author === 'string') return author ? [author] : []
      const authorObject = object(author)
      const name = stringValue(authorObject?.name) ?? stringValue(authorObject?.username)
      return name ? [name] : []
    })
    return [
      {
        id: id.toLowerCase(),
        authors,
        createdAt:
          stringValue(commit.createdAt) ??
          stringValue(commit.created_at) ??
          stringValue(commit.date),
        title: stringValue(commit.title) ?? stringValue(commit.message)?.split('\n')[0] ?? '',
        message: stringValue(commit.message)
      }
    ]
  })
}

const SECURITY_METADATA_KEYS = new Set([
  'status',
  'state',
  'result',
  'verdict',
  'conclusion',
  'virusFound',
  'virusNames',
  'highestSafetyLevel',
  'safe',
  'checkedAt',
  'checked_at',
  'scannedAt',
  'scanned_at',
  'updatedAt',
  'updated_at',
  'timestamp',
  'message',
  'detail',
  'reason',
  'error',
  'scanner',
  'source',
  'name',
  'blobId',
  'indexed',
  'imports',
  'reportLink',
  'report_link',
  'version',
  'pickleImports',
  'pickle_imports',
  'scansDone',
  'scans_done',
  'filesWithIssues',
  'files_with_issues',
  'path',
  'filePath',
  'level'
])

const KNOWN_SCANNER_KEYS = new Set([
  'avScan',
  'av_scan',
  'virusTotalScan',
  'virus_total_scan',
  'protectAiScan',
  'protect_ai_scan',
  'jFrogScan',
  'jfrog_scan',
  'pickleImportScan',
  'pickle_import_scan',
  'malware'
])

function isEnvelopeRoot(prefix: string): boolean {
  return prefix === '' || prefix === 'hub-file-scan'
}

function skipInconclusiveStatus(status: SecurityEvidenceStatus, value: unknown): boolean {
  if (status !== 'unknown') return false
  const normalized = stringValue(value)?.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-')
  return normalized === 'unscanned'
}

function evidenceFromObject(
  raw: Record<string, unknown>,
  filePath?: string,
  prefix = ''
): SecurityEvidence[] {
  const evidence: SecurityEvidence[] = []
  const checkedAt =
    stringValue(raw.checkedAt) ??
    stringValue(raw.checked_at) ??
    stringValue(raw.scannedAt) ??
    stringValue(raw.scanned_at) ??
    stringValue(raw.updatedAt) ??
    stringValue(raw.updated_at) ??
    stringValue(raw.timestamp)
  const message =
    stringValue(raw.message) ??
    stringValue(raw.detail) ??
    stringValue(raw.reason) ??
    stringValue(raw.error)
  const declaredSource =
    stringValue(raw.scanner) ?? stringValue(raw.source) ?? stringValue(raw.name) ?? prefix

  for (const item of array(raw.filesWithIssues ?? raw.files_with_issues)) {
    const issue = object(item)
    if (!issue) continue
    const path = stringValue(issue.path) ?? stringValue(issue.filePath) ?? filePath
    const level = issue.level ?? issue.status ?? issue.result
    const status = securityStatusFrom(level, 'filesWithIssues.level')
    if (skipInconclusiveStatus(status, level)) continue
    evidence.push({
      source: prefix ? `${prefix}.filesWithIssues` : 'filesWithIssues',
      status,
      filePath: path,
      message: stringValue(issue.message) ?? message,
      checkedAt
    })
  }

  const statusCandidates: Array<[string, unknown]> = [
    ['status', raw.status],
    ['state', raw.state],
    ['result', raw.result],
    ['verdict', raw.verdict],
    ['conclusion', raw.conclusion],
    ['virusFound', raw.virusFound],
    ['highestSafetyLevel', raw.highestSafetyLevel],
    ['safe', raw.safe]
  ]
  const explicit = statusCandidates.find(([, candidate]) => candidate !== undefined)
  if (explicit) {
    const [key, candidate] = explicit
    const source = declaredSource || 'hub'
    const status = securityStatusFrom(candidate, `${source}.${key}`)
    if (!skipInconclusiveStatus(status, candidate)) {
      evidence.push({
        source,
        status,
        filePath,
        message,
        checkedAt
      })
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (SECURITY_METADATA_KEYS.has(key)) continue
    const source = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'boolean' || typeof value === 'string') {
      if (!KNOWN_SCANNER_KEYS.has(key)) continue
      const status = securityStatusFrom(value, source)
      if (skipInconclusiveStatus(status, value)) continue
      evidence.push({ source, status, filePath, checkedAt })
      continue
    }
    const nested = object(value)
    if (nested) {
      if (isEnvelopeRoot(prefix) && !KNOWN_SCANNER_KEYS.has(key)) continue
      evidence.push(...evidenceFromObject(nested, filePath, source))
    }
  }
  return evidence
}

function securityReasonForStatus(status: SecurityEvidenceStatus): SecurityReasonCode | undefined {
  if (status === 'malicious') return 'confirmed-malicious'
  if (status === 'pending') return 'scan-pending'
  if (status === 'error') return 'scan-error'
  if (status === 'unknown') return 'scan-unknown'
  if (status === 'warning') return 'unscanned-file'
  return undefined
}

export function mapSecurityReport(
  value: unknown,
  tree: FileTreeEntry[],
  kind: RepoKind,
  repoId: string,
  revision: string,
  resolvedCommit: string
): SecurityReport {
  const raw = object(value) ?? {}
  const repositoryStatus =
    object(raw.securityRepoStatus) ??
    object(raw.security_repo_status) ??
    object(raw.securityStatus) ??
    object(raw.security)
  const evidence = repositoryStatus ? evidenceFromObject(repositoryStatus) : []
  for (const file of tree) {
    if (!file.security) continue
    if (file.security.evidence?.length) {
      for (const item of file.security.evidence) {
        evidence.push({ ...item, filePath: file.path })
      }
      continue
    }
    const scanners = file.security.scanners?.length ? file.security.scanners : ['hub-file-scan']
    for (const source of scanners) {
      evidence.push({
        source,
        status: file.security.status,
        filePath: file.path,
        message: file.security.message
      })
    }
  }
  const tags = array(raw.tags).flatMap((tag) => (typeof tag === 'string' ? [tag] : []))
  const cardData = object(raw.cardData ?? raw.card_data)
  const library = stringValue(raw.library_name) ?? stringValue(raw.libraryName)
  const customCode =
    tags.some((tag) => /custom.?code|trust_remote_code/i.test(tag)) ||
    object(cardData?.auto_map) !== undefined ||
    cardData?.trust_remote_code === true
  if (customCode) {
    evidence.push({ source: 'model-metadata.custom-code', status: 'warning' })
  }
  if (evidence.length === 0) evidence.push({ source: 'hub', status: 'unknown' })
  const overall = aggregateSecurityStatus(evidence)
  const reasons = [
    ...new Set([
      ...evidence.map((item) => securityReasonForStatus(item.status)).filter(Boolean),
      ...(customCode ? (['custom-code', 'trust-remote-code'] as const) : [])
    ])
  ] as SecurityReasonCode[]
  const baseModelRaw = cardData?.base_model ?? cardData?.baseModel
  const baseModels = Array.isArray(baseModelRaw)
    ? baseModelRaw.flatMap((item) => (typeof item === 'string' ? [item] : []))
    : typeof baseModelRaw === 'string'
      ? [baseModelRaw]
      : undefined
  const commitAuthors = [raw.author, ...array(raw.authors)].flatMap((author) => {
    if (typeof author === 'string') return author ? [author] : []
    const authorObject = object(author)
    const name =
      stringValue(authorObject?.name) ??
      stringValue(authorObject?.username) ??
      stringValue(authorObject?.fullname)
    return name ? [name] : []
  })
  const checkedAt = new Date().toISOString()
  return {
    kind,
    repoId,
    revision,
    resolvedCommit: resolvedCommit.toLowerCase(),
    overall,
    evidence,
    reasons,
    fingerprint: securityEvidenceFingerprint({ repoId, resolvedCommit, evidence }),
    checkedAt,
    provenance: {
      license:
        stringValue(cardData?.license) ??
        tags.find((tag) => tag.startsWith('license:'))?.slice('license:'.length),
      baseModels,
      library,
      customCode
    },
    commit: {
      authors: commitAuthors.length ? commitAuthors : undefined,
      createdAt: stringValue(raw.lastModified) ?? stringValue(raw.createdAt),
      signature:
        raw.signed === true || raw.signatureVerified === true
          ? 'verified'
          : raw.signed === false || raw.signatureVerified === false
            ? 'unverified'
            : 'unknown'
    }
  }
}

function identityFromEval(raw: Record<string, unknown>): EvalIdentity | undefined {
  const dataset = object(raw.dataset)
  const task = object(raw.task)
  const metricObject = object(raw.metric)
  const datasetId =
    stringValue(raw.dataset_id) ??
    stringValue(raw.datasetId) ??
    stringValue(dataset?.id) ??
    stringValue(dataset?.type) ??
    stringValue(dataset?.name)
  const taskId =
    stringValue(raw.task_id) ??
    stringValue(raw.taskId) ??
    stringValue(task?.id) ??
    stringValue(task?.type) ??
    stringValue(task?.name)
  const metric =
    stringValue(raw.metric_id) ??
    stringValue(raw.metricId) ??
    stringValue(raw.metric) ??
    stringValue(metricObject?.id) ??
    stringValue(metricObject?.type) ??
    stringValue(metricObject?.name)
  if (!datasetId || !taskId || !metric) return undefined
  return {
    datasetId,
    taskId,
    config:
      stringValue(raw.config) ??
      stringValue(raw.dataset_config) ??
      stringValue(dataset?.config) ??
      stringValue(dataset?.configName),
    split: stringValue(raw.split) ?? stringValue(dataset?.split),
    revision:
      stringValue(raw.revision) ??
      stringValue(raw.dataset_revision) ??
      stringValue(dataset?.revision),
    metric
  }
}

function evalResultRows(value: unknown): Array<Record<string, unknown>> {
  const raw = object(value)
  const rows = array(raw?.evalResults ?? raw?.eval_results)
  return rows.flatMap((entry) => {
    const result = object(entry)
    if (!result) return []
    const metrics = array(result.metrics)
    if (metrics.length === 0) return [result]
    return metrics.flatMap((metric) => {
      const metricRaw = object(metric)
      return metricRaw
        ? [{ ...result, ...metricRaw, metric: metricRaw.type ?? metricRaw.name }]
        : []
    })
  })
}

export function mapModelEvalResults(value: unknown): ModelEvalResult[] {
  const seen = new Set<string>()
  const output: ModelEvalResult[] = []
  for (const raw of evalResultRows(value)) {
    const identity = identityFromEval(raw)
    const resultValue = raw.value ?? object(raw.metric)?.value
    if (!identity || (typeof resultValue !== 'number' && typeof resultValue !== 'string')) continue
    const key = JSON.stringify(identity)
    if (seen.has(key)) continue
    seen.add(key)
    output.push({
      identity,
      value: resultValue,
      source: 'eval-results',
      verified: raw.verified === true,
      createdAt: stringValue(raw.createdAt) ?? stringValue(raw.created_at),
      notes: stringValue(raw.notes) ?? stringValue(raw.note)
    })
  }
  // Compatibility fallback: only fill identities missing from the canonical
  // `.eval_results` expansion. Never let legacy model-index overwrite it.
  const root = object(value)
  const cardData = object(root?.cardData ?? root?.card_data)
  const modelIndex = array(cardData?.['model-index'] ?? cardData?.model_index)
  for (const model of modelIndex) {
    const modelObject = object(model)
    for (const result of array(modelObject?.results)) {
      const resultObject = object(result)
      if (!resultObject) continue
      for (const metric of array(resultObject.metrics)) {
        const metricObject = object(metric)
        if (!metricObject) continue
        const row = {
          ...resultObject,
          ...metricObject,
          metric: metricObject.type ?? metricObject.name,
          value: metricObject.value
        }
        const identity = identityFromEval(row)
        const resultValue = row.value
        if (!identity || (typeof resultValue !== 'number' && typeof resultValue !== 'string')) {
          continue
        }
        const key = JSON.stringify(identity)
        if (seen.has(key)) continue
        seen.add(key)
        output.push({
          identity,
          value: resultValue,
          source: 'model-index',
          verified: metricObject.verified === true || resultObject.verified === true,
          createdAt: stringValue(resultObject.createdAt) ?? stringValue(resultObject.created_at),
          notes: stringValue(metricObject.notes) ?? stringValue(resultObject.notes)
        })
      }
    }
  }
  return output
}

function leaderboardRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const raw = object(value)
  return array(raw?.leaderboard ?? raw?.entries ?? raw?.items ?? raw?.results)
}

export function mapLeaderboardPage(
  value: unknown,
  datasetId: string,
  nextCursor?: string
): LeaderboardPage {
  const entries: LeaderboardEntry[] = []
  for (const [index, item] of leaderboardRows(value).entries()) {
    const raw = object(item)
    if (!raw) continue
    const model = object(raw.model)
    const modelId =
      stringValue(raw.model_id) ??
      stringValue(raw.modelId) ??
      stringValue(model?.id) ??
      stringValue(raw.repo_id)
    // Leaderboard rows also use `revision` for the model commit. EvalIdentity
    // revision is the *dataset* revision, so never let that field leak across
    // identities when the API omits dataset_revision.
    const explicitIdentity = identityFromEval({
      dataset_id: datasetId,
      ...raw,
      revision: raw.dataset_revision ?? raw.datasetRevision
    })
    // The official dataset leaderboard response currently contains one raw
    // benchmark score per row but does not always expose task/metric metadata.
    // Retain the row under a dataset-scoped sentinel identity rather than
    // dropping real leaderboard data or guessing a benchmark definition.
    const identity: EvalIdentity = explicitIdentity ?? {
      datasetId,
      taskId: 'dataset-leaderboard',
      metric: 'raw-score'
    }
    const resultValue = raw.value ?? raw.score ?? raw.metric_value
    if (
      !modelId ||
      !identity ||
      (typeof resultValue !== 'number' && typeof resultValue !== 'string')
    )
      continue
    const sourceObject = object(raw.source)
    const authorObject = object(raw.author)
    const authorName =
      stringValue(authorObject?.name) ??
      stringValue(authorObject?.username) ??
      stringValue(authorObject?.fullname) ??
      stringValue(raw.author)
    const authorTypeRaw = stringValue(authorObject?.type)
    const pullRequest = raw.pull_request ?? raw.pullRequest
    entries.push({
      rank: typeof raw.rank === 'number' ? raw.rank : index + 1,
      modelId,
      identity,
      identityProvided: explicitIdentity !== undefined,
      value: resultValue,
      verified: raw.verified === true,
      source: stringValue(raw.source) ?? stringValue(sourceObject?.name),
      sourceUrl: stringValue(sourceObject?.url),
      sourceExternal:
        typeof sourceObject?.isExternal === 'boolean' ? sourceObject.isExternal : undefined,
      author: authorName
        ? {
            name: authorName,
            fullname: stringValue(authorObject?.fullname),
            type: authorTypeRaw === 'user' || authorTypeRaw === 'org' ? authorTypeRaw : undefined
          }
        : undefined,
      filename: stringValue(raw.filename),
      revision: stringValue(raw.revision) ?? stringValue(model?.revision),
      notes: stringValue(raw.notes) ?? stringValue(raw.note),
      pullRequest: typeof pullRequest === 'number' ? String(pullRequest) : stringValue(pullRequest),
      lowerIsBetter:
        typeof raw.lower_is_better === 'boolean'
          ? raw.lower_is_better
          : typeof raw.lowerIsBetter === 'boolean'
            ? raw.lowerIsBetter
            : undefined,
      parameterCount:
        typeof raw.num_parameters === 'number'
          ? raw.num_parameters
          : typeof raw.numParameters === 'number'
            ? raw.numParameters
            : undefined
    })
  }
  return { datasetId, entries, nextCursor }
}

interface RawPaperAuthor {
  name?: string
  user?: { name?: string } | string
  username?: string
}

interface RawPaperFields {
  id?: string
  title?: string
  summary?: string
  upvotes?: number
  publishedAt?: string
  authors?: RawPaperAuthor[]
  thumbnail?: string
  numComments?: number
  githubRepo?: string
  github_repo?: string
  projectPage?: string
  project_page?: string
  ai_summary?: string
  aiSummary?: string
}

interface RawDailyPaper extends RawPaperFields {
  paper?: RawPaperFields
  submittedBy?: { name?: string } | string
  submittedOnDailyAt?: string
}

function paperAuthorName(author: RawPaperAuthor): string {
  return stringValue(author.name) ?? ''
}

function paperAuthorUsername(author: RawPaperAuthor): string | undefined {
  if (typeof author.user === 'string') return stringValue(author.user)
  return stringValue(object(author.user)?.name) ?? stringValue(author.username)
}

function submittedByName(value: RawDailyPaper['submittedBy']): string | undefined {
  if (typeof value === 'string') return stringValue(value)
  return stringValue(object(value)?.name)
}

export function mapPaper(raw: RawDailyPaper): PaperSummary {
  const p = raw.paper ?? raw
  const authorProfiles = (p.authors ?? [])
    .map((author) => {
      const name = paperAuthorName(author)
      if (!name) return undefined
      const username = paperAuthorUsername(author)
      return username ? { name, username } : { name }
    })
    .filter((author): author is NonNullable<typeof author> => Boolean(author))
  return {
    id: stringValue(p.id) ?? '',
    title: stringValue(p.title) ?? stringValue(raw.title) ?? '',
    summary: stringValue(p.summary) ?? '',
    publishedAt: stringValue(p.publishedAt) ?? stringValue(raw.publishedAt),
    upvotes: p.upvotes ?? 0,
    authors: authorProfiles.map((author) => author.name),
    authorProfiles,
    thumbnail: stringValue(p.thumbnail) ?? stringValue(raw.thumbnail),
    numComments: p.numComments ?? raw.numComments,
    githubRepo: stringValue(p.githubRepo) ?? stringValue(p.github_repo),
    projectPage: stringValue(p.projectPage) ?? stringValue(p.project_page),
    submittedBy: submittedByName(raw.submittedBy),
    submittedOnDailyAt: stringValue(raw.submittedOnDailyAt),
    aiSummary: stringValue(p.aiSummary) ?? stringValue(p.ai_summary)
  }
}

/** Direct /api/papers/{id} responses are the bare paper object (no {paper} wrapper). */
export function mapPaperDetail(raw: NonNullable<RawDailyPaper['paper']>): PaperSummary {
  return mapPaper({ paper: raw })
}

interface RawPaperComment {
  id?: string
  type?: string
  author?: { name?: string; fullname?: string; avatarUrl?: string; isPro?: boolean }
  createdAt?: string
  data?: {
    hidden?: boolean
    hiddenReason?: string
    hiddenBy?: string
    latest?: { raw?: string }
    reactions?: RawReaction[]
    /** Threads one level deep, like post/discussion comments (openapi.json). */
    parentCommentId?: string
  }
}

/**
 * Comments on a Daily Papers entry, from `GET /api/papers/{id}?field=comments`
 * — a flat list threaded via `data.parentCommentId`, unlike the pre-nested
 * shape post comments arrive in. Nested one level to match the Hub's own
 * reply depth (a reply-to-a-reply attaches to its immediate parent).
 */
export function mapPaperComments(raw: { comments?: RawPaperComment[] }): PostComment[] {
  const all = (raw.comments ?? []).filter(
    (c): c is RawPaperComment & { id: string } => c.type === 'comment' && Boolean(c.id)
  )
  const byParent = new Map<string, RawPaperComment[]>()
  for (const c of all) {
    const parentId = c.data?.parentCommentId
    if (parentId === undefined) continue
    byParent.set(parentId, [...(byParent.get(parentId) ?? []), c])
  }
  const mapOne = (c: RawPaperComment & { id: string }): PostComment => {
    const hidden = c.data?.hidden === true
    const replies = (byParent.get(c.id) ?? [])
      .filter((r): r is RawPaperComment & { id: string } => Boolean(r.id))
      .map(mapOne)
    return {
      id: c.id,
      author: c.author?.name ?? '',
      authorFullname: c.author?.fullname,
      authorAvatarUrl: c.author?.avatarUrl,
      authorIsPro: c.author?.isPro,
      createdAt: c.createdAt,
      content: hidden ? '' : (c.data?.latest?.raw ?? ''),
      reactions: normalizeReactions(c.data?.reactions),
      ...(replies.length > 0 ? { replies } : {}),
      ...(hidden
        ? { hidden: true, hiddenReason: c.data?.hiddenReason, hiddenBy: c.data?.hiddenBy }
        : {})
    }
  }
  return all.filter((c) => c.data?.parentCommentId === undefined).map(mapOne)
}

interface RawDiscussion {
  num?: number
  title?: string
  status?: string
  isPullRequest?: boolean
  author?: { name?: string }
  createdAt?: string
  numComments?: number
  changes?: { base?: string }
  diffUrl?: string
  events?: Array<{
    id?: string
    type?: string
    author?: { name?: string }
    createdAt?: string
    data?: {
      latest?: { raw?: string }
      status?: string
      oid?: string
      subject?: string
      /** Same {reaction, users, count} rows as posts (live-verified 2026-07-11). */
      reactions?: RawReaction[]
      /** title-change events (openapi.json, verified 2026-07-13). */
      from?: string
      to?: string
      /** pinning-change events. */
      pinned?: boolean
      /** locking-change events. */
      locked?: boolean
    }
  }>
}

export function mapDiscussionSummary(raw: RawDiscussion): DiscussionSummary {
  const status = raw.status
  return {
    num: raw.num ?? 0,
    title: raw.title ?? '',
    status: status === 'closed' || status === 'merged' || status === 'draft' ? status : 'open',
    isPullRequest: raw.isPullRequest ?? false,
    author: raw.author?.name,
    createdAt: raw.createdAt,
    numComments: raw.numComments
  }
}

export function mapDiscussionDetail(raw: RawDiscussion): DiscussionDetail {
  return {
    ...mapDiscussionSummary(raw),
    baseRef: raw.changes?.base,
    diffUrl: raw.diffUrl,
    events: (raw.events ?? []).map((e, i) => ({
      id: e.id ?? String(i),
      type: e.type ?? 'comment',
      author: e.author?.name,
      createdAt: e.createdAt,
      content: e.data?.latest?.raw,
      status: e.data?.status,
      oid: e.data?.oid,
      subject: e.data?.subject,
      reactions: normalizeReactions(e.data?.reactions),
      titleFrom: e.data?.from,
      titleTo: e.data?.to,
      pinned: e.data?.pinned,
      locked: e.data?.locked
    }))
  }
}

interface RawReaction {
  reaction?: string
  count?: number
  users?: string[]
}

/**
 * Normalize Hub reaction rows to {emoji, count, users}; keep only entries with
 * an emoji so a malformed row can't produce an unclickable ghost pill.
 */
function normalizeReactions(raw: RawReaction[] | undefined): PostReaction[] {
  return (raw ?? []).flatMap((r) => {
    const emoji = r?.reaction
    if (!emoji) return []
    const users = Array.isArray(r?.users)
      ? r.users.filter((u): u is string => typeof u === 'string')
      : []
    const count = typeof r?.count === 'number' ? r.count : users.length
    return [{ emoji, count, users }]
  })
}

interface RawPost {
  slug?: string
  author?: { name?: string; fullname?: string; avatarUrl?: string; isPro?: boolean }
  rawContent?: string
  publishedAt?: string
  numComments?: number
  reactions?: Array<{ reaction?: string; count?: number; users?: string[] }>
  /** Image/video media, kept separate from rawContent (live-verified 2026-07-11). */
  attachments?: Array<{ type?: string; url?: string }>
  /** Relative path like "/posts/<author>/<slug>". */
  url?: string
}

/** Keep only well-formed image/video attachments, with absolutized URLs. */
function mapPostAttachments(
  raw: RawPost['attachments'],
  absolutize: (u: string | undefined) => string | undefined
): PostAttachment[] {
  return (raw ?? []).flatMap((a) => {
    const url = absolutize(a?.url)
    if (url === undefined || (a?.type !== 'image' && a?.type !== 'video')) return []
    return [{ type: a.type, url }]
  })
}

export function mapPost(raw: RawPost, endpoint: string): PostSummary {
  const absolutize = (u: string | undefined): string | undefined =>
    u ? hubRelativeUrl(u, endpoint) : undefined
  const author = raw.author?.name ?? ''
  const slug = raw.slug ?? ''
  const reactions = normalizeReactions(raw.reactions)
  const numReactions = reactions.reduce((acc, r) => acc + (r.count || 1), 0)
  return {
    slug,
    author,
    authorFullname: raw.author?.fullname,
    authorAvatarUrl: absolutize(raw.author?.avatarUrl),
    authorIsPro: raw.author?.isPro,
    content: raw.rawContent ?? '',
    publishedAt: raw.publishedAt,
    numComments: raw.numComments,
    numReactions,
    reactions,
    attachments: mapPostAttachments(raw.attachments, absolutize),
    url: absolutize(raw.url) ?? `${endpoint}/posts/${author}/${slug}`
  }
}

interface RawPostComment {
  id?: string
  type?: string
  author?: { name?: string; fullname?: string; avatarUrl?: string; isPro?: boolean }
  createdAt?: string
  data?: {
    hidden?: boolean
    hiddenReason?: string
    hiddenBy?: string
    latest?: { raw?: string }
    reactions?: RawReaction[]
  }
  /** The Hub threads replies one level deep, nested on the parent comment. */
  replies?: RawPostComment[]
}

/** Decode the HTML-attribute escaping the Hub applies to embedded JSON islands. */
function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Comments on a community post, parsed from the post page HTML. The Hub has
 * no JSON endpoint for post comments — the thread ships inside the
 * SocialPost component's data-props attribute (live-verified 2026-07-11:
 * socialPost.comments carries the same event shape as discussion comments).
 * Returns [] when the island is missing (page shape drift degrades to an
 * empty thread, never a crash).
 */
export function parsePostComments(html: string, endpoint: string): PostComment[] {
  const match =
    /data-target="SocialPost"[^>]*data-props="([^"]*)"/.exec(html) ??
    /data-props="([^"]*)"[^>]*data-target="SocialPost"/.exec(html)
  if (!match) return []
  let comments: RawPostComment[]
  try {
    const props = JSON.parse(decodeHtmlAttribute(match[1]!)) as {
      socialPost?: { comments?: RawPostComment[] }
    }
    comments = props.socialPost?.comments ?? []
  } catch {
    return []
  }
  const absolutize = (u: string | undefined): string | undefined =>
    u ? hubRelativeUrl(u, endpoint) : undefined
  const mapOne = (c: RawPostComment): PostComment[] => {
    if (c.type !== 'comment' || !c.id) return []
    const hidden = c.data?.hidden === true
    const replies = (c.replies ?? []).flatMap(mapOne)
    return [
      {
        id: c.id,
        author: c.author?.name ?? '',
        authorFullname: c.author?.fullname,
        authorAvatarUrl: absolutize(c.author?.avatarUrl),
        authorIsPro: c.author?.isPro,
        createdAt: c.createdAt,
        // The Hub withholds hidden content; keep the row so the UI can show
        // the "this comment has been hidden" placeholder.
        content: hidden ? '' : (c.data?.latest?.raw ?? ''),
        reactions: normalizeReactions(c.data?.reactions),
        ...(replies.length > 0 ? { replies } : {}),
        ...(hidden
          ? { hidden: true, hiddenReason: c.data?.hiddenReason, hiddenBy: c.data?.hiddenBy }
          : {})
      }
    ]
  }
  return comments.flatMap(mapOne)
}

/**
 * The Settings → Profile form, parsed from its SSR HTML (live-captured
 * 2026-07-11: saving is a urlencoded POST back to /settings/profile carrying
 * the page's csrf token; there is no JSON endpoint). Returns undefined when
 * the form is absent — the Hub serves the login page to signed-out sessions.
 */
export function parseProfileSettingsPage(
  html: string
): { csrf: string; settings: HubProfileSettings } | undefined {
  // Scope to the form carrying the profile fields; other forms on the page
  // (logout) have their own csrf inputs.
  const form = html.split('<form').find((chunk) => chunk.includes('name="fullname"'))
  if (form === undefined) return undefined

  const input = (name: string): string => {
    const tag = new RegExp(`<input[^>]*\\bname="${name}"[^>]*>`).exec(form)?.[0] ?? ''
    return decodeHtmlAttribute(/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? '')
  }
  const textarea = (name: string): string => {
    const m = new RegExp(`<textarea[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)</textarea>`).exec(form)
    // Browsers drop a single leading newline after <textarea>; mirror that.
    return decodeHtmlAttribute((m?.[1] ?? '').replace(/^\n/, ''))
  }

  const csrf = input('csrf')
  if (csrf === '') return undefined

  const selectHtml = /<select[^>]*\bname="primaryOrg"[\s\S]*?<\/select>/.exec(form)?.[0] ?? ''
  let primaryOrg = ''
  const primaryOrgOptions: Array<{ value: string; label: string }> = []
  for (const m of selectHtml.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)) {
    const value = decodeHtmlAttribute(/\bvalue="([^"]*)"/.exec(m[1]!)?.[1] ?? '')
    if (/\bselected\b/.test(m[1]!)) primaryOrg = value
    if (value !== '') primaryOrgOptions.push({ value, label: decodeHtmlAttribute(m[2]!.trim()) })
  }

  return {
    csrf,
    settings: {
      fullname: input('fullname'),
      homepage: input('homepage'),
      details: textarea('details'),
      github: input('github'),
      twitter: input('twitter'),
      linkedin: input('linkedin'),
      bluesky: input('bluesky'),
      primaryOrg,
      primaryOrgOptions
    }
  }
}

/**
 * The gated repo access form, parsed from the repo page's SSR HTML
 * (live-captured 2026-07-11: `<form action=".../ask-access...">` posting
 * urlencoded csrf + one field per gate question, named by the question text).
 * Returns undefined when the page offers no ask-access form — either the repo
 * isn't gated for this account, or a manual request is already pending.
 */
export function parseAskAccessForm(
  html: string
): { csrf: string; fields: GatedFormField[] } | undefined {
  const form = html.split('<form').find((chunk) => chunk.includes('/ask-access'))
  if (form === undefined) return undefined
  const body = form.slice(0, form.indexOf('</form>'))

  let csrf = ''
  const fields: GatedFormField[] = []
  for (const m of body.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
    const attrs = m[2]!
    const name = decodeHtmlAttribute(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '')
    if (name === '') continue
    const type = /\btype="([^"]*)"/.exec(attrs)?.[1] ?? 'text'
    if (name === 'csrf') {
      csrf = decodeHtmlAttribute(/\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? '')
      continue
    }
    if (type === 'hidden') continue
    const required = /\brequired\b/.test(attrs)
    if (m[1] === 'select') {
      const selectHtml =
        new RegExp(
          `<select[^>]*name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?</select>`
        ).exec(body)?.[0] ?? ''
      const options = [...selectHtml.matchAll(/<option[^>]*value="([^"]*)"/g)]
        .map((o) => decodeHtmlAttribute(o[1]!))
        .filter((v) => v !== '')
      fields.push({ name, type: 'select', required, options })
    } else if (m[1] === 'textarea') {
      fields.push({ name, type: 'textarea', required })
    } else if (type === 'checkbox') {
      fields.push({ name, type: 'checkbox', required })
    } else if (type === 'date') {
      fields.push({ name, type: 'date', required })
    } else {
      fields.push({ name, type: 'text', required })
    }
  }
  if (csrf === '') return undefined
  return { csrf, fields }
}

/**
 * SSR sample rows from a dataset page's DatasetViewer island — the Hub's own
 * fallback when the datasets-server viewer is unavailable (huge or failed
 * builds). Returns undefined when the island carries no sample.
 */
export function parseDatasetSampleRows(html: string): DatasetRows | undefined {
  const match =
    /data-target="DatasetViewer"[^>]*data-props="([^"]*)"/.exec(html) ??
    /data-props="([^"]*)"[^>]*data-target="DatasetViewer"/.exec(html)
  if (!match) return undefined
  let sample: {
    columns?: Array<{ name?: string }>
    rows?: Array<{ cells?: Record<string, { value?: unknown }> }>
  }
  try {
    const props = JSON.parse(decodeHtmlAttribute(match[1]!)) as {
      data?: { sampleData?: { sampleData?: typeof sample } }
    }
    sample = props.data?.sampleData?.sampleData ?? {}
  } catch {
    return undefined
  }
  const columns = (sample.columns ?? []).flatMap((c) => (c?.name ? [c.name] : []))
  const rows = (sample.rows ?? []).map((r) =>
    columns.map((col) => {
      const value = r?.cells?.[col]?.value
      if (value === undefined || value === null) return ''
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return text.length > 500 ? `${text.slice(0, 500)}…` : text
    })
  )
  if (columns.length === 0 || rows.length === 0) return undefined
  return { columns, rows, sample: true }
}

interface RawUserOverview {
  _id?: string
  name?: string
  isFollowing?: boolean
  user?: string
  fullname?: string
  avatarUrl?: string
  isPro?: boolean
  /** Org paid plan (`team` / `enterprise` / `plus` / `academia`). */
  plan?: string
  /** Free-form bio text. */
  details?: string
  numModels?: number
  numDatasets?: number
  numSpaces?: number
  numPapers?: number
  numFollowers?: number
  numFollowing?: number
  /** Present on organization overviews (member count). */
  numUsers?: number
  numLikes?: number
  /** Org handle arrives under `name` or `user` depending on the payload. */
  orgs?: Array<{
    name?: string
    user?: string
    fullname?: string
    avatarUrl?: string
    plan?: string
  }>
  createdAt?: string
}

const HUB_ORG_PLANS = new Set(['team', 'enterprise', 'plus', 'academia'])

/** Normalize Hub `plan` strings; unknown values are dropped. */
export function mapHubOrgPlan(raw: string | undefined): HubOrgPlan | undefined {
  if (raw === undefined || raw === '') return undefined
  const plan = raw.toLowerCase()
  return HUB_ORG_PLANS.has(plan) ? (plan as HubOrgPlan) : undefined
}

export function mapUserOverview(
  raw: RawUserOverview,
  endpoint: string,
  isOrg = false
): UserOverview {
  const absolutize = (u: string | undefined): string | undefined =>
    u ? hubRelativeUrl(u, endpoint) : undefined
  return {
    internalId: raw._id,
    name: raw.user ?? raw.name ?? '',
    fullname: raw.fullname,
    avatarUrl: absolutize(raw.avatarUrl),
    bio: raw.details,
    isPro: raw.isPro,
    plan: mapHubOrgPlan(raw.plan),
    numModels: raw.numModels ?? 0,
    numDatasets: raw.numDatasets ?? 0,
    numSpaces: raw.numSpaces ?? 0,
    numPapers: raw.numPapers ?? 0,
    numFollowers: raw.numFollowers ?? 0,
    numFollowing: raw.numFollowing ?? 0,
    numUsers: raw.numUsers,
    numLikes: raw.numLikes ?? 0,
    orgs: (raw.orgs ?? []).map((o) => ({
      name: o.name ?? o.user ?? '',
      fullname: o.fullname,
      avatarUrl: absolutize(o.avatarUrl),
      plan: mapHubOrgPlan(o.plan)
    })),
    createdAt: raw.createdAt,
    isFollowing: raw.isFollowing,
    isOrg
  }
}

interface RawWhoAmI {
  name?: string
  fullname?: string
  email?: string
  avatarUrl?: string
  isPro?: boolean
  orgs?: Array<{ name?: string; fullname?: string; avatarUrl?: string; plan?: string }>
  /**
   * Present when authenticating with a User Access Token; mirrors and proxy
   * endpoints may omit it entirely, so every field is optional.
   */
  auth?: {
    type?: string
    accessToken?: { displayName?: string; role?: string }
  }
}

export function mapWhoAmI(raw: RawWhoAmI, endpoint: string): UserProfile {
  // The Hub returns avatar paths relative to the site root (e.g. /avatars/x.svg);
  // absolutize so consumers can render them directly (the renderer has its own
  // origin, so a relative src would 404).
  const absolutize = (u: string | undefined): string | undefined =>
    u ? hubRelativeUrl(u, endpoint) : undefined
  return {
    name: raw.name ?? '',
    fullname: raw.fullname,
    email: raw.email,
    avatarUrl: absolutize(raw.avatarUrl),
    isPro: raw.isPro,
    orgs: (raw.orgs ?? []).map((o) => ({
      name: o.name ?? '',
      fullname: o.fullname,
      avatarUrl: absolutize(o.avatarUrl),
      plan: mapHubOrgPlan(o.plan)
    }))
  }
}

export interface WhoAmIDetailed {
  user: UserProfile
  tokenDisplayName?: string
  tokenRole?: string
}

/** Like mapWhoAmI, plus the token identity block when the Hub reports one. */
export function mapWhoAmIAuth(raw: RawWhoAmI, endpoint: string): WhoAmIDetailed {
  const accessToken = raw.auth?.accessToken
  return {
    user: mapWhoAmI(raw, endpoint),
    tokenDisplayName: accessToken?.displayName || undefined,
    tokenRole: accessToken?.role || undefined
  }
}

/** Owner arrives as an expanded object; older payloads may carry a bare handle. */
interface RawCollectionOwner {
  name?: string
  user?: string
}

interface RawCollectionItem {
  _id?: string
  type?: string
  id?: string
  title?: string
  /** Routable slug carried by type:'collection' items (id is the internal 24-hex id). */
  slug?: string
  /** Notes are pre-rendered; the raw text is what the app edits and displays. */
  note?: { text?: string; html?: string }
  position?: number
  downloads?: number
  likes?: number
  upvotes?: number
  emoji?: string
}

interface RawCollection {
  slug?: string
  title?: string
  description?: string
  owner?: RawCollectionOwner | string
  private?: boolean
  theme?: string
  upvotes?: number
  /** Detail responses only; reflects the authenticated caller. */
  isUpvotedByUser?: boolean
  lastUpdated?: string
  numberItems?: number
  items?: RawCollectionItem[]
}

export function mapCollectionSummary(raw: RawCollection): CollectionSummary {
  const owner = typeof raw.owner === 'string' ? raw.owner : (raw.owner?.name ?? raw.owner?.user)
  return {
    slug: raw.slug ?? '',
    title: raw.title ?? '',
    description: raw.description,
    owner: owner ?? '',
    private: raw.private ?? false,
    theme: raw.theme,
    // List payloads embed a (possibly truncated) items array instead of a count.
    itemCount: raw.numberItems ?? raw.items?.length,
    upvotes: raw.upvotes,
    isUpvoted: raw.isUpvotedByUser,
    updatedAt: raw.lastUpdated
  }
}

const COLLECTION_ITEM_TYPES: ReadonlySet<string> = new Set([
  'model',
  'dataset',
  'space',
  'paper',
  'collection'
])

/** Returns undefined for item types the app does not display (e.g. buckets). */
function mapCollectionItem(raw: RawCollectionItem): CollectionItem | undefined {
  if (!raw.type || !COLLECTION_ITEM_TYPES.has(raw.type)) return undefined
  return {
    itemId: raw._id ?? '',
    type: raw.type as CollectionItem['type'],
    id: raw.id ?? '',
    title: raw.title ?? raw.id,
    slug: raw.slug,
    note: raw.note?.text,
    position: raw.position,
    downloads: raw.downloads,
    // Papers and nested collections report upvotes instead of likes.
    likes: raw.likes ?? raw.upvotes,
    emoji: raw.emoji
  }
}

export function mapCollectionDetail(raw: RawCollection): CollectionDetail {
  return {
    ...mapCollectionSummary(raw),
    items: (raw.items ?? [])
      .map(mapCollectionItem)
      .filter((item): item is CollectionItem => item !== undefined)
  }
}

interface RawNotificationParticipant {
  user?: string
  avatar?: string
}

/**
 * Discriminated by `type`; unknown variants degrade to kind 'other'.
 * The Hub exposes NO per-notification id (openapi-verified 2026-07-12), so the
 * nested discussion/post/blog id — a discussion id in every case — is the only
 * handle mark-as-read accepts. All four documented variants require one; only
 * undocumented variants (org invites, …) can yield an id-less notification,
 * which is clearable solely via the applyToAll "mark all read" form.
 */
interface RawNotification {
  type?: string
  read?: boolean
  updatedAt?: string
  repo?: { name?: string; type?: string }
  discussion?: {
    num?: number
    title?: string
    status?: string
    id?: string
    isPullRequest?: boolean
    participating?: RawNotificationParticipant[]
  }
  paper?: { _id?: string; title?: string }
  paperDiscussion?: { id?: string; participating?: RawNotificationParticipant[] }
  post?: {
    id?: string
    slug?: string
    authorName?: string
    title?: string
    participating?: RawNotificationParticipant[]
  }
  blog?: { id?: string; title?: string; participating?: RawNotificationParticipant[] }
}

export function mapNotification(raw: RawNotification, endpoint: string): HubNotification {
  const absolutize = (u: string | undefined): string | undefined =>
    u ? hubRelativeUrl(u, endpoint) : undefined
  const participants = (
    list: RawNotificationParticipant[] | undefined
  ): HubNotification['participants'] =>
    (list ?? [])
      .filter((p) => p.user)
      .map((p) => ({ user: p.user ?? '', avatar: absolutize(p.avatar) }))
  const base = { read: raw.read ?? false, updatedAt: raw.updatedAt }
  if (raw.type === 'repo' && raw.repo) {
    const repoKind = asRepoKind(raw.repo.type)
    const num = raw.discussion?.num
    const status = raw.discussion?.status
    return {
      ...base,
      kind: 'repo',
      title: raw.discussion?.title ?? raw.repo.name ?? '',
      discussionId: raw.discussion?.id,
      repoId: raw.repo.name,
      repoKind,
      discussionNum: num,
      discussionStatus:
        status === 'draft' || status === 'open' || status === 'closed' || status === 'merged'
          ? status
          : undefined,
      isPullRequest: raw.discussion?.isPullRequest,
      participants: participants(raw.discussion?.participating),
      route:
        repoKind && raw.repo.name && num !== undefined
          ? `/${REPO_URL_SEGMENT[repoKind]}/${raw.repo.name}/discussions/${num}`
          : undefined
    }
  }
  if (raw.type === 'paper' && raw.paper) {
    return {
      ...base,
      kind: 'paper',
      title: raw.paper.title ?? '',
      discussionId: raw.paperDiscussion?.id,
      participants: participants(raw.paperDiscussion?.participating),
      route: raw.paper._id ? `/papers/${raw.paper._id}` : undefined
    }
  }
  if (raw.type === 'post' && raw.post) {
    return {
      ...base,
      kind: 'post',
      title: raw.post.title ?? '',
      discussionId: raw.post.id,
      participants: participants(raw.post.participating),
      route:
        raw.post.authorName && raw.post.slug
          ? `/posts/${raw.post.authorName}/${raw.post.slug}`
          : undefined
    }
  }
  // Unknown variants (community_blog, org invites, …) still render as inbox rows.
  return {
    ...base,
    kind: 'other',
    title: raw.blog?.title ?? '',
    discussionId: raw.blog?.id,
    participants: participants(raw.blog?.participating)
  }
}

interface RawNotificationsPage {
  notifications?: RawNotification[]
  count?: { view?: number; unread?: number; all?: number }
}

export function mapNotificationsPage(
  raw: RawNotificationsPage,
  endpoint: string
): NotificationsPage {
  const items = (raw.notifications ?? []).map((n) => mapNotification(n, endpoint))
  // `view` counts the entries matching the current filters; `all` is the fallback.
  return { count: raw.count?.view ?? raw.count?.all ?? items.length, items }
}

interface RawMyRepo {
  id?: string
  type?: string
  updatedAt?: string
  visibility?: string
  storage?: number
  storagePercent?: number
}

/** Keeps model/dataset/space entries only; buckets and kernels are dropped. */
export function mapMyRepos(raw: RawMyRepo[]): MyRepoEntry[] {
  const entries: MyRepoEntry[] = []
  for (const r of raw) {
    const kind = asRepoKind(r.type)
    if (!kind || !r.id) continue
    entries.push({
      id: r.id,
      kind,
      visibility:
        r.visibility === 'private' || r.visibility === 'protected' ? r.visibility : 'public',
      updatedAt: r.updatedAt ?? '',
      storage: r.storage ?? 0,
      storagePercent: r.storagePercent ?? 0
    })
  }
  return entries
}

interface RawAccessRequest {
  /** The requesting user's handle arrives under `user.user`. */
  user?: { user?: string; fullname?: string; avatarUrl?: string }
  timestamp?: string
  fields?: Record<string, string>
}

export function mapAccessRequest(raw: RawAccessRequest, endpoint: string): AccessRequest {
  return {
    user: {
      name: raw.user?.user ?? '',
      fullname: raw.user?.fullname,
      avatarUrl: raw.user?.avatarUrl ? hubRelativeUrl(raw.user.avatarUrl, endpoint) : undefined
    },
    timestamp: raw.timestamp,
    fields: raw.fields
  }
}

interface RawSpaceEnvEntry {
  key?: string
  value?: string
  description?: string
  updatedAt?: string
}

/** The secrets endpoint returns an object map keyed by secret key. */
export function mapSpaceSecrets(raw: Record<string, RawSpaceEnvEntry>): SpaceSecret[] {
  return Object.entries(raw ?? {}).map(([key, entry]) => ({
    key: entry?.key ?? key,
    description: entry?.description,
    updatedAt: entry?.updatedAt
  }))
}

/** The variables endpoint returns an object map keyed by variable key. */
export function mapSpaceVariables(raw: Record<string, RawSpaceEnvEntry>): SpaceVariable[] {
  return Object.entries(raw ?? {}).map(([key, entry]) => ({
    key: entry?.key ?? key,
    value: entry?.value,
    description: entry?.description,
    updatedAt: entry?.updatedAt
  }))
}

interface RawBillingUsageItem {
  label?: string | null
  product?: string
  productPrettyName?: string
  quantity?: number
  unitLabel?: string
  totalCostMicroUSD?: number
}

interface RawBillingUsage {
  period?: { periodStart?: string; periodEnd?: string }
  usage?: Record<string, RawBillingUsageItem[] | undefined>
}

/** Tolerant of shape drift: flattens the per-product usage map into display rows. */
export function mapBillingUsage(raw: RawBillingUsage): BillingUsage {
  const rows: BillingUsage['rows'] = []
  for (const [group, items] of Object.entries(raw.usage ?? {})) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const detailParts: string[] = []
      if (item.label && item.productPrettyName) detailParts.push(item.productPrettyName)
      if (typeof item.quantity === 'number' && item.unitLabel) {
        detailParts.push(`${item.quantity} ${item.unitLabel}`)
      }
      rows.push({
        label: item.label ?? item.productPrettyName ?? item.product ?? group,
        detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
        // The API reports micro-USD; the UI displays cents (1 cent = 10,000 µUSD).
        amountCents:
          typeof item.totalCostMicroUSD === 'number'
            ? Math.round(item.totalCostMicroUSD / 10_000)
            : undefined
      })
    }
  }
  return { periodStart: raw.period?.periodStart, periodEnd: raw.period?.periodEnd, rows }
}

interface RawActivityRepo {
  id?: string
  author?: string
  repoType?: RepoKind
  likes?: number
  downloads?: number
  private?: boolean
  gated?: string | boolean
  lastModified?: string
}

interface RawActivityItem {
  time?: string
  user?: string
  userAvatarUrl?: string
  orgAvatarUrl?: string
  isPro?: boolean
  type?: string
  repoData?: RawActivityRepo
  repoId?: string
  repoType?: RepoKind
  socialPost?: unknown
  discussionData?: {
    num?: number
    title?: string
    status?: string
    isPullRequest?: boolean
    numComments?: number
  }
}

function mapActivityRepo(raw: RawActivityRepo, repoType: RepoKind): RepoSummary {
  const id = raw.id ?? ''
  const slash = id.indexOf('/')
  return {
    id,
    kind: raw.repoType ?? repoType,
    author: raw.author ?? (slash >= 0 ? id.slice(0, slash) : id),
    name: slash >= 0 ? id.slice(slash + 1) : id,
    likes: raw.likes ?? 0,
    downloads: raw.downloads ?? 0,
    updatedAt: raw.lastModified,
    private: raw.private ?? false,
    gated: raw.gated ?? false,
    tags: []
  }
}

/**
 * Personalized following feed (`/api/recent-activity`). Maps the actor + verb +
 * target for the kinds the app renders (repo like/update/publish, social posts,
 * discussions); silently drops collection/upvote/paper-daily items for now.
 */
export function mapActivityFeed(
  raw: { recentActivity?: RawActivityItem[]; cursor?: string },
  endpoint: string
): ActivityFeed {
  const abs = (u: string | undefined): string | undefined =>
    u ? hubRelativeUrl(u, endpoint) : undefined
  const items: ActivityItem[] = []
  for (const a of raw.recentActivity ?? []) {
    const actor = a.user ?? ''
    const actorAvatarUrl = abs(a.userAvatarUrl ?? a.orgAvatarUrl)
    const actorIsPro = a.isPro
    const repoType = a.repoType ?? 'model'
    if ((a.type === 'like' || a.type === 'update' || a.type === 'publish') && a.repoData?.id) {
      items.push({
        kind: a.type,
        time: a.time,
        actor,
        actorAvatarUrl,
        actorIsPro,
        repo: mapActivityRepo(a.repoData, repoType)
      })
    } else if (a.type === 'social-post' && a.socialPost) {
      items.push({
        kind: 'social-post',
        time: a.time,
        actor,
        actorAvatarUrl,
        actorIsPro,
        post: mapPost(a.socialPost as never, endpoint)
      })
    } else if (
      a.type === 'discussion' &&
      a.discussionData &&
      a.repoId &&
      typeof a.discussionData.num === 'number'
    ) {
      const d: ActivityDiscussion = {
        repoId: a.repoId,
        repoKind: repoType,
        num: a.discussionData.num,
        title: a.discussionData.title ?? '',
        isPullRequest: a.discussionData.isPullRequest ?? false,
        status: a.discussionData.status,
        numComments: a.discussionData.numComments
      }
      items.push({
        kind: 'discussion',
        time: a.time,
        actor,
        actorAvatarUrl,
        actorIsPro,
        discussion: d
      })
    }
  }
  return { items, cursor: raw.cursor }
}
