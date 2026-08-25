/**
 * Card-level "download this weight" intents derived from a repo file list
 * (Hub `siblings` or a recursive tree). The picker is a filename convention
 * reader — it never opens the blobs.
 */
import type { ExportTool, MachineProfile, ModelFitLevel } from './types'

export type WeightFormat = 'gguf' | 'safetensors' | 'ckpt' | 'pt' | 'pth' | 'bin'

export interface WeightFile {
  path: string
  size?: number
  format: WeightFormat
  /** e.g. Q4_K_M, Q5_K_S, F16 — GGUF / quantised checkpoints only. */
  quant?: string
  label: string
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
  /(?:^|[._ -])(?:mmproj|projector|vision|clip|embedding|embedder|reranker|rerank)(?:$|[._ -])/i
const SPLIT_GGUF_NAME = /-\d{5}-of-\d{5}\.gguf$/i

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

export function listWeightFiles(
  files: Array<{ path?: string; rfilename?: string; size?: number }>
): WeightFile[] {
  const out: WeightFile[] = []
  for (const file of files) {
    const path = file.path ?? file.rfilename
    if (!path) continue
    const ext = extensionOfPath(path)
    const format = FORMAT_EXT[ext]
    if (!format) continue
    const name = path.split('/').at(-1) ?? path
    if (SKIP_NAME.test(name)) continue
    const quant = format === 'gguf' || format === 'safetensors' ? parseQuantLabel(path) : undefined
    const label = quant ?? name
    out.push({ path, size: file.size, format, quant, label })
  }
  return out.sort((a, b) => {
    if (a.format !== b.format) return a.format === 'gguf' ? -1 : b.format === 'gguf' ? 1 : 0
    return (a.quant ?? a.path).localeCompare(b.quant ?? b.path)
  })
}

/** Best default for "give me the file my local tool can eat". */
export function preferredWeightFile(files: WeightFile[]): WeightFile | undefined {
  if (files.length === 0) return undefined
  const gguf = files.filter((file) => file.format === 'gguf')
  for (const quant of PREFERRED_QUANTS) {
    const match = gguf.find((file) => file.quant === quant)
    if (match) return match
  }
  if (gguf[0]) return gguf[0]
  const largest = files.reduce<WeightFile | undefined>((best, file) => {
    if (!best) return file
    return (file.size ?? 0) > (best.size ?? 0) ? file : best
  }, undefined)
  return largest ?? files[0]
}

function isRecommendationCandidate(file: WeightFile): boolean {
  if (file.format !== 'gguf' || !file.size || file.size <= 0) return false
  const name = file.path.split('/').at(-1) ?? file.path
  return !AUXILIARY_GGUF_NAME.test(name) && !SPLIT_GGUF_NAME.test(name)
}

/**
 * Approximate pre-download fit from file size and the current machine profile.
 * Exact GGUF metadata remains the source of truth in the local-run workflow.
 */
export function recommendWeightFileForProfile(
  files: WeightFile[],
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
