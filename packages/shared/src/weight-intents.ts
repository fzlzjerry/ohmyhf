/**
 * Card-level weight variants derived from a repo file list (Hub `siblings`
 * or a recursive tree). Multipart weights are one download intent; this
 * filename convention reader never opens the blobs.
 */
import type { ExportTool, MachineProfile, ModelFitLevel } from './types'

export type WeightFormat = 'gguf' | 'safetensors' | 'ckpt' | 'pt' | 'pth' | 'bin'

export interface WeightVariant {
  path: string
  files: Array<{ path: string; size?: number }>
  size?: number
  format: WeightFormat
  /** e.g. Q4_K_M, Q5_K_S, F16 — GGUF / quantised checkpoints only. */
  quant?: string
  label: string
  /** Expected number of shards; absent for a standalone weight. */
  shardCount?: number
  complete: boolean
}

export interface WeightFitEstimate {
  path: string
  level: ModelFitLevel
  estimatedSystemMemoryBytes: number
  estimatedGpuBytes: number
  requiredDiskBytes: number
}

export interface WeightRecommendation {
  recommendedPath?: string
  estimates: WeightFitEstimate[]
}

const FORMAT_EXT: Record<string, WeightFormat> = {
  gguf: 'gguf',
  safetensors: 'safetensors',
  ckpt: 'ckpt',
  pt: 'pt',
  pth: 'pth',
  bin: 'bin'
}

const SKIP_NAME = /(?:^|[._-])(optimizer|training_args|scheduler|rng_state)(?:[._-]|$)/i

const PREFERRED_QUANTS = ['Q4_K_M', 'Q5_K_M', 'Q4_K_S', 'Q4_0', 'Q5_0', 'Q8_0', 'Q6_K']

const GIB = 1024 ** 3
const AUXILIARY_GGUF_NAME =
  /(?:^|[._ -])(?:mmproj|projector|vision|clip|embedding|embedder|reranker|rerank|imatrix)(?:$|[._ -])/i
const WEIGHT_SHARD_SUFFIX = /-(\d{5})-of-(\d{5})(\.(?:gguf|safetensors|ckpt|pt|pth|bin))$/i

/** Hub paths are attacker-controlled; only a basename prefix is a quant label. */
const MAX_QUANT_SCAN = 256

const QUANT_ALIASES = ['FP16', 'FP32', 'BF16'] as const

/** Longer prefixes first so IQ/BF win over Q/F. */
const QUANT_PREFIXES = ['IQ', 'BF', 'Q', 'F'] as const

function isQuantBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '-' || ch === '_' || ch === '.'
}

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isAsciiAlnum(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z')
}

export function extensionOfPath(path: string): string {
  const name = path.split('/').at(-1) ?? path
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Only standard, in-range multipart suffixes identify a shard set. */
export function parseWeightShard(
  path: string
): { groupPath: string; index: number; total: number } | undefined {
  const match = WEIGHT_SHARD_SUFFIX.exec(path)
  if (!match) return undefined
  const index = Number(match[1])
  const total = Number(match[2])
  if (total < 2 || index < 1 || index > total) return undefined
  return { groupPath: path.slice(0, match.index) + match[3], index, total }
}

/**
 * Read a GGUF-style quant token (Q4_K_M, IQ4_XS, F16, …) from a filename.
 * Left-to-right, no backtracking — a nested `_*` / `+` regex on Hub paths
 * is polynomial (CodeQL js/polynomial-redos: `q9`+`_f0`, `q9_`+`0_f0_`).
 */
export function parseQuantLabel(path: string): string | undefined {
  const raw = path.split('/').at(-1) ?? path
  const name = raw.length > MAX_QUANT_SCAN ? raw.slice(0, MAX_QUANT_SCAN) : raw
  const upper = name.toUpperCase()

  for (let i = 0; i < upper.length; i++) {
    if (i > 0 && !isQuantBoundary(upper[i - 1])) continue

    for (const alias of QUANT_ALIASES) {
      if (upper.startsWith(alias, i) && isQuantBoundary(upper[i + alias.length])) {
        return alias
      }
    }

    for (const prefix of QUANT_PREFIXES) {
      if (!upper.startsWith(prefix, i)) continue
      let j = i + prefix.length
      const firstDigit = upper[j]
      if (firstDigit === undefined || !isAsciiDigit(firstDigit)) continue
      j += 1
      for (; j < upper.length; j++) {
        const ch = upper[j]
        if (ch === undefined || !isAsciiDigit(ch)) break
      }

      while (j < upper.length && upper[j] === '_') {
        const start = j + 1
        let k = start
        for (; k < upper.length; k++) {
          const ch = upper[k]
          if (ch === undefined || !isAsciiAlnum(ch)) break
        }
        if (k === start) break
        j = k
      }

      if (isQuantBoundary(upper[j])) return upper.slice(i, j)
    }
  }
  return undefined
}

export function exportToolsForFormat(format: WeightFormat): ExportTool[] {
  if (format === 'gguf') return ['ollama', 'lmstudio', 'comfyui']
  return ['comfyui']
}

export function listWeightVariants(
  files: Array<{ path?: string; rfilename?: string; size?: number }>
): WeightVariant[] {
  const variants = new Map<string, WeightVariant>()
  const seen = new Set<string>()
  for (const file of files) {
    const path = file.path ?? file.rfilename
    if (!path || seen.has(path)) continue
    seen.add(path)
    const format = FORMAT_EXT[extensionOfPath(path)]
    if (!format) continue
    const name = path.split('/').at(-1) ?? path
    if (SKIP_NAME.test(name)) continue
    const shard = parseWeightShard(path)
    const groupPath = shard?.groupPath ?? path
    const key = shard ? `${groupPath}\0${shard.total}` : path
    const part = { path, size: file.size }
    const existing = variants.get(key)
    if (existing) {
      existing.files.push(part)
      continue
    }
    const quant =
      format === 'gguf' || format === 'safetensors' ? parseQuantLabel(groupPath) : undefined
    variants.set(key, {
      path,
      files: [part],
      format,
      quant,
      label: quant ?? groupPath.split('/').at(-1) ?? groupPath,
      shardCount: shard?.total,
      complete: !shard
    })
  }

  const out = [...variants.values()]
  const labelCounts = new Map<string, number>()
  for (const variant of out) {
    // The standard suffix has fixed-width indexes, so lexical order is numeric.
    variant.files.sort((a, b) => a.path.localeCompare(b.path))
    variant.path = variant.files[0]!.path
    variant.complete = !variant.shardCount || variant.files.length === variant.shardCount
    if (variant.complete && variant.files.every((file) => file.size !== undefined)) {
      variant.size = variant.files.reduce((total, file) => total + file.size!, 0)
    }
    labelCounts.set(variant.label, (labelCounts.get(variant.label) ?? 0) + 1)
  }
  for (const variant of out) {
    if (labelCounts.get(variant.label)! <= 1) continue
    const groupPath = parseWeightShard(variant.path)?.groupPath ?? variant.path
    variant.label = variant.quant ? `${variant.quant} · ${groupPath}` : groupPath
    if (variant.shardCount) variant.label += ` (${variant.shardCount})`
  }
  return out.sort((a, b) => {
    if (a.format !== b.format) return a.format === 'gguf' ? -1 : b.format === 'gguf' ? 1 : 0
    return a.label.localeCompare(b.label) || a.path.localeCompare(b.path)
  })
}

/** Best default for downloading a complete weight variant. */
export function preferredWeightVariant(files: WeightVariant[]): WeightVariant | undefined {
  if (files.length === 0) return undefined
  const complete = files.filter((file) => file.complete)
  const gguf = complete.filter((file) => file.format === 'gguf')
  for (const quant of PREFERRED_QUANTS) {
    const match = gguf.find((file) => file.quant === quant)
    if (match) return match
  }
  if (gguf[0]) return gguf[0]
  const largest = complete.reduce<WeightVariant | undefined>((best, file) => {
    if (!best) return file
    return (file.size ?? 0) > (best.size ?? 0) ? file : best
  }, undefined)
  return largest ?? files[0]
}

function isRecommendationCandidate(file: WeightVariant): boolean {
  if (!file.complete || file.format !== 'gguf' || !file.size || file.size <= 0) return false
  const name = file.path.split('/').at(-1) ?? file.path
  return !AUXILIARY_GGUF_NAME.test(name)
}

/**
 * Approximate pre-download fit from file size and the current machine profile.
 * Exact GGUF metadata remains the source of truth in the local-run workflow.
 */
export function recommendWeightVariantForProfile(
  files: WeightVariant[],
  profile: MachineProfile,
  availableDiskBytes?: number
): WeightRecommendation {
  const osReserve = Math.max(2 * GIB, Math.ceil(profile.totalMemoryBytes * 0.1))
  const availableMemoryBytes = Math.max(0, profile.freeMemoryBytes - osReserve)
  const discreteGpuMemory = profile.accelerators
    .filter((accelerator) => accelerator.unifiedMemory !== true)
    .reduce(
      (sum, accelerator) =>
        sum + (accelerator.freeMemoryBytes ?? accelerator.totalMemoryBytes ?? 0),
      0
    )

  const estimates = files.filter(isRecommendationCandidate).map((file): WeightFitEstimate => {
    const fileSize = file.size!
    const estimatedGpuBytes = Math.min(fileSize, Math.floor(discreteGpuMemory * 0.9))
    const estimatedKvBytes = Math.ceil(Math.min(2 * GIB, fileSize * 0.2))
    const estimatedRuntimeBytes = Math.max(512 * 1024 ** 2, Math.ceil(fileSize * 0.12))
    const estimatedSystemMemoryBytes =
      fileSize - estimatedGpuBytes + estimatedKvBytes + estimatedRuntimeBytes

    let level: ModelFitLevel
    if (availableDiskBytes !== undefined && availableDiskBytes < fileSize) level = 'unlikely'
    else if (availableMemoryBytes >= estimatedSystemMemoryBytes * 1.2) level = 'comfortable'
    else if (availableMemoryBytes >= estimatedSystemMemoryBytes) level = 'tight'
    else level = 'unlikely'

    return {
      path: file.path,
      level,
      estimatedSystemMemoryBytes,
      estimatedGpuBytes,
      requiredDiskBytes: fileSize
    }
  })

  const bySizeDescending = [...estimates].sort((a, b) => {
    const sizeDiff = b.requiredDiskBytes - a.requiredDiskBytes
    return sizeDiff !== 0 ? sizeDiff : a.path.localeCompare(b.path)
  })
  const recommended =
    bySizeDescending.find((estimate) => estimate.level === 'comfortable') ??
    bySizeDescending.find((estimate) => estimate.level === 'tight')

  return { recommendedPath: recommended?.path, estimates }
}
