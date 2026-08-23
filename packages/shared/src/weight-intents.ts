/**
 * Card-level "download this weight" intents derived from a repo file list
 * (Hub `siblings` or a recursive tree). The picker is a filename convention
 * reader — it never opens the blobs.
 */
import type { ExportTool } from './types'

export type WeightFormat = 'gguf' | 'safetensors' | 'ckpt' | 'pt' | 'pth' | 'bin'

export interface WeightFile {
  path: string
  size?: number
  format: WeightFormat
  /** e.g. Q4_K_M, Q5_K_S, F16 — GGUF / quantised checkpoints only. */
  quant?: string
  label: string
}

const FORMAT_EXT: Record<string, WeightFormat> = {
  gguf: 'gguf',
  safetensors: 'safetensors',
  ckpt: 'ckpt',
  pt: 'pt',
  pth: 'pth',
  bin: 'bin'
}

/** Quant token sitting between separators or before the extension. */
const QUANT_RE = /(?:^|[-_.])((?:IQ|Q|F|BF)\d+(?:_[A-Z0-9]+)*|FP16|FP32|BF16)(?=[-_.]|\.|$)/i

const SKIP_NAME = /(?:^|[._-])(optimizer|training_args|scheduler|rng_state)(?:[._-]|$)/i

const PREFERRED_QUANTS = ['Q4_K_M', 'Q5_K_M', 'Q4_K_S', 'Q4_0', 'Q5_0', 'Q8_0', 'Q6_K']

export function extensionOfPath(path: string): string {
  const name = path.split('/').at(-1) ?? path
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function parseQuantLabel(path: string): string | undefined {
  const name = path.split('/').at(-1) ?? path
  const match = QUANT_RE.exec(name)
  return match?.[1]?.toUpperCase()
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
